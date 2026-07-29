import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { controlPlaneStatusResultSchema } from "@crewhelm/contracts";
import * as z from "zod";

import {
  diagnoseDeployment,
  type DoctorDependencies,
  type DoctorOptions,
  doctorReportSchema,
} from "./doctor.js";

const AUTH_BASE_PATH = "/api/auth";
const MCP_PATH = "/mcp";
const VIEW_SCOPE = "crewhelm:view";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1_000;
const MAXIMUM_OAUTH_RESPONSE_BYTES = 16 * 1_024;
const MAXIMUM_MCP_RESPONSE_BYTES = 96 * 1_024;
const MAXIMUM_MCP_TOOL_COUNT = 30;
const MAXIMUM_MCP_SCHEMA_BYTES = 64 * 1_024;
const MAXIMUM_REVOCATION_RESPONSE_BYTES = 4 * 1_024;

const authenticatedDoctorCheckSchema = z.strictObject({
  code: z.enum([
    "valid",
    "not_run",
    "timeout",
    "request_failed",
    "response_too_large",
    "http_status",
    "content_type",
    "invalid_json",
    "invalid_payload",
    "authorization_denied",
    "invalid_callback",
    "browser_unavailable",
  ]),
  endpoint: z.url(),
  message: z.string(),
  name: z.enum([
    "oauth-owner-access",
    "mcp-initialize",
    "mcp-tool-catalog",
    "fleet-status",
    "oauth-token-revocation",
  ]),
  status: z.enum(["pass", "fail", "skip"]),
});

export const authenticatedDoctorReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  public: doctorReportSchema,
  checks: z.tuple([
    authenticatedDoctorCheckSchema,
    authenticatedDoctorCheckSchema,
    authenticatedDoctorCheckSchema,
    authenticatedDoctorCheckSchema,
    authenticatedDoctorCheckSchema,
  ]),
});

export type AuthenticatedDoctorReport = z.infer<typeof authenticatedDoctorReportSchema>;
type AuthenticatedDoctorCheck = AuthenticatedDoctorReport["checks"][number];
type AuthenticatedDoctorCheckCode = AuthenticatedDoctorCheck["code"];
type AuthenticatedDoctorCheckName = AuthenticatedDoctorCheck["name"];

export interface AuthenticatedDoctorDependencies extends DoctorDependencies {
  openUrl: (url: URL) => Promise<void>;
}

export interface AuthenticatedDoctorOptions extends DoctorOptions {
  authorizationTimeoutMs?: number;
}

class AuthenticatedDoctorError extends Error {
  override readonly name = "AuthenticatedDoctorError";

  constructor(
    readonly code: Exclude<AuthenticatedDoctorCheckCode, "valid" | "not_run">,
    message: string,
  ) {
    super(message);
  }
}

class ResponseTooLargeError extends Error {
  override readonly name = "ResponseTooLargeError";
}

const registrationResponseSchema = z
  .looseObject({
    client_id: z.string().min(1).max(2_048),
    token_endpoint_auth_method: z.literal("none"),
  })
  .refine((value) => !("client_secret" in value));

const tokenResponseSchema = z
  .looseObject({
    access_token: z.string().min(1).max(8_192),
    expires_in: z.literal(900),
    scope: z.literal(VIEW_SCOPE),
    token_type: z.string().transform((value, context) => {
      if (value.toLowerCase() !== "bearer") {
        context.addIssue({
          code: "custom",
          message: "Expected a Bearer token.",
        });

        return z.NEVER;
      }

      return "Bearer" as const;
    }),
  })
  .refine((value) => !("refresh_token" in value));
const revocableTokenValueSchema = z.string().min(1).max(8_192);

const initializeResponseSchema = z.looseObject({
  error: z.never().optional(),
  id: z.union([z.number(), z.string()]),
  jsonrpc: z.literal("2.0"),
  result: z.looseObject({
    protocolVersion: z.literal(MCP_PROTOCOL_VERSION),
    serverInfo: z.looseObject({
      name: z.string().min(1).max(256),
      version: z.string().min(1).max(256),
    }),
  }),
});

const toolListResponseSchema = z.looseObject({
  error: z.never().optional(),
  id: z.union([z.number(), z.string()]),
  jsonrpc: z.literal("2.0"),
  result: z.looseObject({
    tools: z
      .array(
        z.looseObject({
          annotations: z.looseObject({
            destructiveHint: z.boolean(),
            idempotentHint: z.boolean(),
            openWorldHint: z.boolean(),
            readOnlyHint: z.boolean(),
          }),
          inputSchema: z.unknown(),
          name: z.string().min(1).max(256),
        }),
      )
      .max(MAXIMUM_MCP_TOOL_COUNT),
  }),
});

const toolCallResponseSchema = z.looseObject({
  error: z.never().optional(),
  id: z.union([z.number(), z.string()]),
  jsonrpc: z.literal("2.0"),
  result: z.looseObject({
    content: z
      .array(
        z.looseObject({
          text: z
            .string()
            .max(64 * 1_024)
            .optional(),
          type: z.literal("text"),
        }),
      )
      .min(1)
      .max(8),
    isError: z.literal(false),
  }),
});

const checkDefinitions = {
  fleetStatus: {
    name: "fleet-status",
    validMessage: "Owner-local fleet status is available with view-only access.",
  },
  mcpInitialize: {
    name: "mcp-initialize",
    validMessage: "Authenticated MCP initialization succeeded.",
  },
  mcpToolCatalog: {
    name: "mcp-tool-catalog",
    validMessage: "The bounded MCP catalog exposes the read-only fleet status tool.",
  },
  oauthOwnerAccess: {
    name: "oauth-owner-access",
    validMessage: "Temporary view-only owner access was granted.",
  },
  oauthTokenRevocation: {
    name: "oauth-token-revocation",
    validMessage: "The temporary access token was revoked.",
  },
} as const satisfies Record<string, { name: AuthenticatedDoctorCheckName; validMessage: string }>;

function createCheck(
  name: AuthenticatedDoctorCheckName,
  endpoint: URL,
  code: AuthenticatedDoctorCheckCode,
  message: string,
): AuthenticatedDoctorCheck {
  return authenticatedDoctorCheckSchema.parse({
    code,
    endpoint: endpoint.href,
    message,
    name,
    status: code === "valid" ? "pass" : code === "not_run" ? "skip" : "fail",
  });
}

function skippedCheck(name: AuthenticatedDoctorCheckName, endpoint: URL): AuthenticatedDoctorCheck {
  return createCheck(name, endpoint, "not_run", "Check was not run.");
}

function failedCheck(
  name: AuthenticatedDoctorCheckName,
  endpoint: URL,
  error: unknown,
): AuthenticatedDoctorCheck {
  if (error instanceof AuthenticatedDoctorError) {
    return createCheck(name, endpoint, error.code, error.message);
  }

  return createCheck(name, endpoint, "request_failed", "Authenticated check failed.");
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        return body + decoder.decode();
      }

      bytes += chunk.value.byteLength;

      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }

      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The original bounded-read failure is the diagnostic signal.
    }

    if (error instanceof ResponseTooLargeError) {
      throw error;
    }

    if (isTimeout(error)) {
      throw error;
    }

    throw new AuthenticatedDoctorError("invalid_payload", "Response encoding was invalid.");
  }
}

async function fetchResponseBounded(
  dependencies: DoctorDependencies,
  endpoint: URL,
  init: RequestInit,
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ body: string; response: Response }> {
  let response: Response;
  let body: string;

  try {
    response = await dependencies.fetch(endpoint, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await readBoundedBody(response, maximumBytes);
  } catch (error) {
    if (error instanceof AuthenticatedDoctorError) {
      throw error;
    }

    if (error instanceof ResponseTooLargeError) {
      throw new AuthenticatedDoctorError(
        "response_too_large",
        `Response exceeded ${maximumBytes} bytes.`,
      );
    }

    if (isTimeout(error)) {
      throw new AuthenticatedDoctorError("timeout", "Request timed out.");
    }

    throw new AuthenticatedDoctorError("request_failed", "Request failed.");
  }

  return { body, response };
}

async function fetchBounded(
  dependencies: DoctorDependencies,
  endpoint: URL,
  init: RequestInit,
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ body: string; response: Response }> {
  const result = await fetchResponseBounded(dependencies, endpoint, init, timeoutMs, maximumBytes);

  if (!result.response.ok) {
    throw new AuthenticatedDoctorError(
      "http_status",
      "Endpoint returned an unexpected HTTP status.",
    );
  }

  return result;
}

async function fetchJson<T>(
  dependencies: DoctorDependencies,
  endpoint: URL,
  init: RequestInit,
  timeoutMs: number,
  maximumBytes: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload = await fetchJsonValue(dependencies, endpoint, init, timeoutMs, maximumBytes);
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    throw new AuthenticatedDoctorError("invalid_payload", "Endpoint returned an invalid payload.");
  }

  return parsed.data;
}

async function fetchJsonValue(
  dependencies: DoctorDependencies,
  endpoint: URL,
  init: RequestInit,
  timeoutMs: number,
  maximumBytes: number,
): Promise<unknown> {
  const { body, response } = await fetchBounded(
    dependencies,
    endpoint,
    init,
    timeoutMs,
    maximumBytes,
  );
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

  if (contentType !== "application/json") {
    throw new AuthenticatedDoctorError("content_type", "Endpoint did not return JSON.");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    throw new AuthenticatedDoctorError("invalid_json", "Endpoint returned invalid JSON.");
  }

  return payload;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

type CallbackResult =
  | { kind: "code"; code: string }
  | { kind: "error"; code: "authorization_denied" | "invalid_callback" | "timeout" };

interface CallbackListener {
  close: () => Promise<void>;
  redirectUrl: URL;
  wait: (timeoutMs: number) => Promise<string>;
}

async function startCallbackListener(state: string, issuer: string): Promise<CallbackListener> {
  const capability = randomBytes(32).toString("base64url");
  const callbackPath = `/oauth/callback/${capability}`;
  let expectedHost: string | undefined;
  let resolveCallback: ((result: CallbackResult) => void) | undefined;
  let settled = false;
  const callback = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });
  const settle = (result: CallbackResult) => {
    if (!settled) {
      settled = true;
      resolveCallback?.(result);
    }
  };
  const server = createServer((request, response) => {
    if (expectedHost === undefined || request.headers.host !== expectedHost) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }

    const states = requestUrl.searchParams.getAll("state");
    const codes = requestUrl.searchParams.getAll("code");
    const errors = requestUrl.searchParams.getAll("error");
    const issuers = requestUrl.searchParams.getAll("iss");
    const validEnvelope =
      states.length === 1 && states[0] === state && issuers.length === 1 && issuers[0] === issuer;
    const validCode =
      validEnvelope &&
      codes.length === 1 &&
      codes[0] !== undefined &&
      codes[0].length > 0 &&
      codes[0].length <= 2_048 &&
      errors.length === 0;
    const denied =
      validEnvelope && errors.length === 1 && errors[0] === "access_denied" && codes.length === 0;

    response.writeHead(validCode ? 200 : denied ? 403 : 400, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    });

    if (validCode) {
      response.end("Crewhelm access verified. Return to the terminal.", () => {
        settle({ code: codes[0] ?? "", kind: "code" });
      });
      return;
    }

    if (denied) {
      response.end("Crewhelm access was not approved.", () => {
        settle({ code: "authorization_denied", kind: "error" });
      });
      return;
    }

    response.end("Crewhelm authorization callback could not be verified.", () => {
      settle({ code: "invalid_callback", kind: "error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new AuthenticatedDoctorError(
      "request_failed",
      "Local authorization callback could not start.",
    );
  }

  expectedHost = `127.0.0.1:${address.port}`;

  return {
    close: () => closeServer(server),
    redirectUrl: new URL(`http://${expectedHost}${callbackPath}`),
    wait: async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const result = await Promise.race([
          callback,
          new Promise<CallbackResult>((resolve) => {
            timer = setTimeout(() => resolve({ code: "timeout", kind: "error" }), timeoutMs);
          }),
        ]);

        if (result.kind === "code") {
          return result.code;
        }

        if (result.code === "authorization_denied") {
          throw new AuthenticatedDoctorError(
            "authorization_denied",
            "Owner declined temporary view-only access.",
          );
        }

        if (result.code === "timeout") {
          throw new AuthenticatedDoctorError("timeout", "Authorization timed out.");
        }

        throw new AuthenticatedDoctorError(
          "invalid_callback",
          "Authorization callback could not be verified.",
        );
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}

function oauthEndpoints(origin: URL) {
  const authBase = new URL(AUTH_BASE_PATH, origin);

  return {
    authorize: new URL(`${authBase.pathname}/oauth2/authorize`, origin),
    issuer: authBase.href.replace(/\/$/u, ""),
    register: new URL(`${authBase.pathname}/oauth2/register`, origin),
    revoke: new URL(`${authBase.pathname}/oauth2/revoke`, origin),
    token: new URL(`${authBase.pathname}/oauth2/token`, origin),
  };
}

function mcpHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
}

async function confirmAccessTokenRevoked(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
  accessToken: string,
): Promise<void> {
  const { response } = await fetchResponseBounded(
    dependencies,
    new URL(MCP_PATH, options.origin),
    {
      body: JSON.stringify({
        id: 4,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: {
            name: "crewhelm-cli",
            version: "0.0.0",
          },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
      }),
      headers: mcpHeaders(accessToken),
      method: "POST",
    },
    options.timeoutMs,
    MAXIMUM_OAUTH_RESPONSE_BYTES,
  );

  if (response.status !== 401) {
    throw new AuthenticatedDoctorError(
      "http_status",
      "Temporary access-token revocation could not be verified.",
    );
  }
}

async function callMcp<T extends { id: number | string }>(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
  accessToken: string,
  id: number,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await fetchJson(
    dependencies,
    new URL(MCP_PATH, options.origin),
    {
      body: JSON.stringify({
        id,
        jsonrpc: "2.0",
        method,
        params,
      }),
      headers: mcpHeaders(accessToken),
      method: "POST",
    },
    options.timeoutMs,
    MAXIMUM_MCP_RESPONSE_BYTES,
    schema,
  );

  if (result.id !== id) {
    throw new AuthenticatedDoctorError(
      "invalid_payload",
      "MCP response did not match its request.",
    );
  }

  return result;
}

function createReport(
  publicReport: AuthenticatedDoctorReport["public"],
  checks: AuthenticatedDoctorReport["checks"],
): AuthenticatedDoctorReport {
  return authenticatedDoctorReportSchema.parse({
    schemaVersion: 1,
    ok: publicReport.ok && checks.every((check) => check.status === "pass"),
    public: publicReport,
    checks,
  });
}

export async function diagnoseAuthenticatedDeployment(
  options: AuthenticatedDoctorOptions,
  dependencies: AuthenticatedDoctorDependencies,
): Promise<AuthenticatedDoctorReport> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  const endpoints = oauthEndpoints(options.origin);
  const mcpEndpoint = new URL(MCP_PATH, options.origin);
  const checks: AuthenticatedDoctorReport["checks"] = [
    skippedCheck(checkDefinitions.oauthOwnerAccess.name, endpoints.authorize),
    skippedCheck(checkDefinitions.mcpInitialize.name, mcpEndpoint),
    skippedCheck(checkDefinitions.mcpToolCatalog.name, mcpEndpoint),
    skippedCheck(checkDefinitions.fleetStatus.name, mcpEndpoint),
    skippedCheck(checkDefinitions.oauthTokenRevocation.name, endpoints.revoke),
  ];

  if (!publicReport.ok) {
    return createReport(publicReport, checks);
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let listener: CallbackListener | undefined;
  let clientId: string | undefined;
  let accessToken: string | undefined;
  const revocationTokens: Array<{ token: string; tokenType: "access_token" | "refresh_token" }> =
    [];
  let activeCheckIndex = 0;

  try {
    listener = await startCallbackListener(state, endpoints.issuer);
    const registration = await fetchJson(
      dependencies,
      endpoints.register,
      {
        body: JSON.stringify({
          application_type: "native",
          client_name: "Crewhelm authenticated doctor",
          grant_types: ["authorization_code"],
          redirect_uris: [listener.redirectUrl.href],
          require_pkce: true,
          resources: [mcpEndpoint.href],
          response_types: ["code"],
          scope: VIEW_SCOPE,
          token_endpoint_auth_method: "none",
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      },
      options.timeoutMs,
      MAXIMUM_OAUTH_RESPONSE_BYTES,
      registrationResponseSchema,
    );
    clientId = registration.client_id;
    const authorizeUrl = new URL(endpoints.authorize);

    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("redirect_uri", listener.redirectUrl.href);
    authorizeUrl.searchParams.set("resource", mcpEndpoint.href);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", VIEW_SCOPE);
    authorizeUrl.searchParams.set("state", state);

    try {
      await dependencies.openUrl(authorizeUrl);
    } catch {
      throw new AuthenticatedDoctorError(
        "browser_unavailable",
        "The authorization page could not be opened.",
      );
    }

    const authorizationCode = await listener.wait(
      options.authorizationTimeoutMs ?? AUTHORIZATION_TIMEOUT_MS,
    );
    const tokenPayload = await fetchJsonValue(
      dependencies,
      endpoints.token,
      {
        body: new URLSearchParams({
          client_id: clientId,
          code: authorizationCode,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: listener.redirectUrl.href,
          resource: mcpEndpoint.href,
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      options.timeoutMs,
      MAXIMUM_OAUTH_RESPONSE_BYTES,
    );
    if (typeof tokenPayload === "object" && tokenPayload !== null && !Array.isArray(tokenPayload)) {
      const revocableAccessToken = revocableTokenValueSchema.safeParse(
        Reflect.get(tokenPayload, "access_token"),
      );
      const revocableRefreshToken = revocableTokenValueSchema.safeParse(
        Reflect.get(tokenPayload, "refresh_token"),
      );

      if (revocableAccessToken.success) {
        revocationTokens.push({
          token: revocableAccessToken.data,
          tokenType: "access_token",
        });
      }

      if (revocableRefreshToken.success) {
        revocationTokens.push({
          token: revocableRefreshToken.data,
          tokenType: "refresh_token",
        });
      }
    }

    const token = tokenResponseSchema.safeParse(tokenPayload);

    if (!token.success) {
      throw new AuthenticatedDoctorError(
        "invalid_payload",
        "Endpoint returned an invalid payload.",
      );
    }

    accessToken = token.data.access_token;
    checks[0] = createCheck(
      checkDefinitions.oauthOwnerAccess.name,
      endpoints.authorize,
      "valid",
      checkDefinitions.oauthOwnerAccess.validMessage,
    );

    activeCheckIndex = 1;
    await callMcp(
      options,
      dependencies,
      accessToken,
      1,
      "initialize",
      {
        capabilities: {},
        clientInfo: {
          name: "crewhelm-cli",
          version: "0.0.0",
        },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
      initializeResponseSchema,
    );
    checks[1] = createCheck(
      checkDefinitions.mcpInitialize.name,
      mcpEndpoint,
      "valid",
      checkDefinitions.mcpInitialize.validMessage,
    );

    activeCheckIndex = 2;
    const toolList = await callMcp(
      options,
      dependencies,
      accessToken,
      2,
      "tools/list",
      {},
      toolListResponseSchema,
    );
    const toolNames = toolList.result.tools.map((tool) => tool.name);
    const statusTool = toolList.result.tools.find((tool) => tool.name === "crewhelm_status");
    const serializedSchemaBytes = new TextEncoder().encode(
      JSON.stringify(toolList.result.tools.map((tool) => tool.inputSchema)),
    ).byteLength;

    if (
      new Set(toolNames).size !== toolNames.length ||
      serializedSchemaBytes > MAXIMUM_MCP_SCHEMA_BYTES ||
      !statusTool ||
      !statusTool.annotations.readOnlyHint ||
      statusTool.annotations.destructiveHint ||
      !statusTool.annotations.idempotentHint ||
      statusTool.annotations.openWorldHint
    ) {
      throw new AuthenticatedDoctorError(
        "invalid_payload",
        "MCP tool catalog violated its bounded read-only contract.",
      );
    }

    checks[2] = createCheck(
      checkDefinitions.mcpToolCatalog.name,
      mcpEndpoint,
      "valid",
      checkDefinitions.mcpToolCatalog.validMessage,
    );

    activeCheckIndex = 3;
    const statusResponse = await callMcp(
      options,
      dependencies,
      accessToken,
      3,
      "tools/call",
      {
        arguments: {},
        name: "crewhelm_status",
      },
      toolCallResponseSchema,
    );
    const statusText = statusResponse.result.content.find(
      (content) => content.type === "text" && content.text !== undefined,
    )?.text;
    let statusPayload: unknown;

    try {
      statusPayload = JSON.parse(statusText ?? "");
    } catch {
      throw new AuthenticatedDoctorError(
        "invalid_payload",
        "Fleet status tool returned an invalid payload.",
      );
    }

    const status = controlPlaneStatusResultSchema.safeParse(statusPayload);

    if (!status.success || !status.data.ok) {
      throw new AuthenticatedDoctorError(
        "invalid_payload",
        "Fleet status tool returned an invalid payload.",
      );
    }

    checks[3] = createCheck(
      checkDefinitions.fleetStatus.name,
      mcpEndpoint,
      "valid",
      checkDefinitions.fleetStatus.validMessage,
    );
  } catch (error) {
    const definition = [
      checkDefinitions.oauthOwnerAccess,
      checkDefinitions.mcpInitialize,
      checkDefinitions.mcpToolCatalog,
      checkDefinitions.fleetStatus,
    ][activeCheckIndex];
    const endpoint = activeCheckIndex === 0 ? endpoints.authorize : mcpEndpoint;

    if (definition) {
      checks[activeCheckIndex] = failedCheck(definition.name, endpoint, error);
    }
  } finally {
    if (listener) {
      await listener.close();
    }

    if (revocationTokens.length > 0 && clientId) {
      let revocationError: unknown;

      for (const token of revocationTokens) {
        try {
          await fetchBounded(
            dependencies,
            endpoints.revoke,
            {
              body: new URLSearchParams({
                client_id: clientId,
                token: token.token,
                token_type_hint: token.tokenType,
              }),
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
              },
              method: "POST",
            },
            options.timeoutMs,
            MAXIMUM_REVOCATION_RESPONSE_BYTES,
          );
        } catch (error) {
          revocationError ??= error;
        }
      }

      for (const token of revocationTokens) {
        if (token.tokenType === "access_token") {
          try {
            await confirmAccessTokenRevoked(options, dependencies, token.token);
          } catch (error) {
            revocationError ??= error;
          }
        }
      }

      if (revocationError === undefined) {
        checks[4] = createCheck(
          checkDefinitions.oauthTokenRevocation.name,
          endpoints.revoke,
          "valid",
          checkDefinitions.oauthTokenRevocation.validMessage,
        );
      } else {
        checks[4] = failedCheck(
          checkDefinitions.oauthTokenRevocation.name,
          endpoints.revoke,
          revocationError,
        );
      }
    }
  }

  return createReport(publicReport, checks);
}
