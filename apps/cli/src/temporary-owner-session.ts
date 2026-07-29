import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import * as z from "zod";

import type { DoctorDependencies, DoctorOptions } from "./doctor.js";

const AUTH_BASE_PATH = "/api/auth";
const MCP_PATH = "/mcp";
export const MCP_PROTOCOL_VERSION = "2025-11-25";
const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1_000;
const MAXIMUM_OAUTH_RESPONSE_BYTES = 16 * 1_024;
const MAXIMUM_MCP_RESPONSE_BYTES = 96 * 1_024;
const MAXIMUM_REVOCATION_RESPONSE_BYTES = 4 * 1_024;

export const temporaryOwnerSessionErrorCodeSchema = z.enum([
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
]);

export type TemporaryOwnerSessionErrorCode = z.infer<typeof temporaryOwnerSessionErrorCodeSchema>;

export class TemporaryOwnerSessionError extends Error {
  override readonly name = "TemporaryOwnerSessionError";

  constructor(
    readonly code: TemporaryOwnerSessionErrorCode,
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
const revocableTokenValueSchema = z.string().min(1).max(8_192);

export const initializeResponseSchema = z.looseObject({
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

export const toolListResponseSchema = z.looseObject({
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
      .max(30),
  }),
});

export const toolCallResponseSchema = z.looseObject({
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
    isError: z.boolean(),
  }),
});

interface CallbackListener {
  close: () => Promise<void>;
  redirectUrl: URL;
  wait: (timeoutMs: number) => Promise<string>;
}

type CallbackResult =
  | { kind: "code"; code: string }
  | { kind: "error"; code: "authorization_denied" | "invalid_callback" | "timeout" };

export interface TemporaryOwnerMcpSession {
  call<T extends { id: number | string }>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
  ): Promise<T>;
  endpoint: URL;
}

interface SessionFailure {
  code: TemporaryOwnerSessionErrorCode;
  message: string;
}

type SessionStep =
  | { ok: true }
  | {
      error: SessionFailure;
      ok: false;
    };

type SessionOperation<T> =
  | { status: "not_run" }
  | { ok: true; status: "completed"; value: T }
  | { error: SessionFailure; ok: false; status: "failed" };

export interface TemporaryOwnerSessionResult<T> {
  authorization: SessionStep;
  operation: SessionOperation<T>;
  revocation:
    | { status: "not_issued" }
    | { ok: true; status: "revoked" }
    | { error: SessionFailure; ok: false; status: "failed" };
}

export interface TemporaryOwnerSessionOptions extends DoctorOptions {
  authorizationTimeoutMs?: number;
  clientName: string;
  scope: "crewhelm:view" | "crewhelm:full";
}

export interface TemporaryOwnerSessionDependencies extends DoctorDependencies {
  openUrl: (url: URL) => Promise<void>;
}

function normalizeFailure(error: unknown): SessionFailure {
  return error instanceof TemporaryOwnerSessionError
    ? { code: error.code, message: error.message }
    : { code: "request_failed", message: "Temporary owner session failed." };
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
      // Preserve the original bounded-read failure.
    }

    if (error instanceof ResponseTooLargeError || isTimeout(error)) {
      throw error;
    }

    throw new TemporaryOwnerSessionError("invalid_payload", "Response encoding was invalid.");
  }
}

async function fetchResponseBounded(
  dependencies: DoctorDependencies,
  endpoint: URL,
  init: RequestInit,
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ body: string; response: Response }> {
  try {
    const response = await dependencies.fetch(endpoint, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readBoundedBody(response, maximumBytes);
    return { body, response };
  } catch (error) {
    if (error instanceof TemporaryOwnerSessionError) {
      throw error;
    }
    if (error instanceof ResponseTooLargeError) {
      throw new TemporaryOwnerSessionError(
        "response_too_large",
        `Response exceeded ${maximumBytes} bytes.`,
      );
    }
    if (isTimeout(error)) {
      throw new TemporaryOwnerSessionError("timeout", "Request timed out.");
    }

    throw new TemporaryOwnerSessionError("request_failed", "Request failed.");
  }
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
    throw new TemporaryOwnerSessionError(
      "http_status",
      "Endpoint returned an unexpected HTTP status.",
    );
  }

  return result;
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
    throw new TemporaryOwnerSessionError("content_type", "Endpoint did not return JSON.");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new TemporaryOwnerSessionError("invalid_json", "Endpoint returned invalid JSON.");
  }
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
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Endpoint returned an invalid payload.",
    );
  }

  return parsed.data;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
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
    throw new TemporaryOwnerSessionError(
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
          throw new TemporaryOwnerSessionError(
            "authorization_denied",
            "Owner declined temporary access.",
          );
        }
        if (result.code === "timeout") {
          throw new TemporaryOwnerSessionError("timeout", "Authorization timed out.");
        }

        throw new TemporaryOwnerSessionError(
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
      body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
      headers: mcpHeaders(accessToken),
      method: "POST",
    },
    options.timeoutMs,
    MAXIMUM_MCP_RESPONSE_BYTES,
    schema,
  );

  if (result.id !== id) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "MCP response did not match its request.",
    );
  }

  return result;
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
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "crewhelm-cli", version: "0.0.0" },
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
    throw new TemporaryOwnerSessionError(
      "http_status",
      "Temporary access-token revocation could not be verified.",
    );
  }
}

export function parseMcpToolResult<T>(
  response: z.infer<typeof toolCallResponseSchema>,
  schema: z.ZodType<T>,
  invalidMessage: string,
): T {
  const text = response.result.content.find((content) => content.text !== undefined)?.text;
  let payload: unknown;

  try {
    payload = JSON.parse(text ?? "");
  } catch {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }

  const parsed = schema.safeParse(payload);

  if (response.result.isError || !parsed.success) {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }

  return parsed.data;
}

export async function runTemporaryOwnerSession<T>(
  options: TemporaryOwnerSessionOptions,
  dependencies: TemporaryOwnerSessionDependencies,
  operation: (session: TemporaryOwnerMcpSession) => Promise<T>,
): Promise<TemporaryOwnerSessionResult<T>> {
  const clientName = z.string().min(1).max(128).parse(options.clientName);
  const endpoints = oauthEndpoints(options.origin);
  const mcpEndpoint = new URL(MCP_PATH, options.origin);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let listener: CallbackListener | undefined;
  let clientId: string | undefined;
  let authorization: SessionStep = {
    error: { code: "request_failed", message: "Temporary access was not granted." },
    ok: false,
  };
  let operationResult: SessionOperation<T> = { status: "not_run" };
  let revocation: TemporaryOwnerSessionResult<T>["revocation"] = { status: "not_issued" };
  const revocationTokens: Array<{ token: string; tokenType: "access_token" | "refresh_token" }> =
    [];

  try {
    listener = await startCallbackListener(state, endpoints.issuer);
    const registration = await fetchJson(
      dependencies,
      endpoints.register,
      {
        body: JSON.stringify({
          application_type: "native",
          client_name: clientName,
          grant_types: ["authorization_code"],
          redirect_uris: [listener.redirectUrl.href],
          require_pkce: true,
          resources: [mcpEndpoint.href],
          response_types: ["code"],
          scope: options.scope,
          token_endpoint_auth_method: "none",
        }),
        headers: { accept: "application/json", "content-type": "application/json" },
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
    authorizeUrl.searchParams.set("scope", options.scope);
    authorizeUrl.searchParams.set("state", state);

    try {
      await dependencies.openUrl(authorizeUrl);
    } catch {
      throw new TemporaryOwnerSessionError(
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
      for (const [property, tokenType] of [
        ["access_token", "access_token"],
        ["refresh_token", "refresh_token"],
      ] as const) {
        const candidate = revocableTokenValueSchema.safeParse(Reflect.get(tokenPayload, property));

        if (candidate.success) {
          revocationTokens.push({ token: candidate.data, tokenType });
        }
      }
    }

    const token = z
      .looseObject({
        access_token: revocableTokenValueSchema,
        expires_in: z.literal(900),
        scope: z.literal(options.scope),
        token_type: z.string().transform((value, context) => {
          if (value.toLowerCase() !== "bearer") {
            context.addIssue({ code: "custom", message: "Expected a Bearer token." });
            return z.NEVER;
          }
          return "Bearer" as const;
        }),
      })
      .refine((value) => !("refresh_token" in value))
      .safeParse(tokenPayload);

    if (!token.success) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "Endpoint returned an invalid payload.",
      );
    }

    authorization = { ok: true };
    let nextRequestId = 1;
    const session: TemporaryOwnerMcpSession = {
      call: (method, params, schema) =>
        callMcp(
          options,
          dependencies,
          token.data.access_token,
          nextRequestId++,
          method,
          params,
          schema,
        ),
      endpoint: mcpEndpoint,
    };

    try {
      operationResult = {
        ok: true,
        status: "completed",
        value: await operation(session),
      };
    } catch (error) {
      operationResult = { error: normalizeFailure(error), ok: false, status: "failed" };
    }
  } catch (error) {
    authorization = { error: normalizeFailure(error), ok: false };
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

      revocation =
        revocationError === undefined
          ? { ok: true, status: "revoked" }
          : { error: normalizeFailure(revocationError), ok: false, status: "failed" };
    }
  }

  return { authorization, operation: operationResult, revocation };
}
