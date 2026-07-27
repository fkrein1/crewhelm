import { HEALTH_PATH, healthReportSchema, OWNER_SCOPES } from "@crewhelm/contracts";
import * as z from "zod";

const MAX_DIAGNOSTIC_RESPONSE_BYTES = 4_096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server/api/auth";
const AUTH_BASE_PATH = "/api/auth";
const MCP_PATH = "/mcp";

const deploymentOriginInputSchema = z.string().trim().min(1).max(2_048);
const doctorCheckSchema = z.strictObject({
  code: z.enum([
    "valid",
    "timeout",
    "request_failed",
    "response_too_large",
    "http_status",
    "content_type",
    "invalid_json",
    "invalid_payload",
  ]),
  endpoint: z.url(),
  message: z.string(),
  name: z.enum(["worker-health", "mcp-protected-resource", "oauth-authorization-server"]),
  status: z.enum(["pass", "fail"]),
});

export const doctorReportSchema = z.strictObject({
  schemaVersion: z.literal(2),
  ok: z.boolean(),
  checks: z.tuple([doctorCheckSchema, doctorCheckSchema, doctorCheckSchema]),
});

export type DoctorReport = z.infer<typeof doctorReportSchema>;

export class DoctorInputError extends Error {
  override readonly name = "DoctorInputError";
}

class ResponseTooLargeError extends Error {
  override readonly name = "ResponseTooLargeError";
}

export function parseDeploymentOrigin(input: string): URL {
  const parsedInput = deploymentOriginInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw new DoctorInputError("The endpoint must be a URL no longer than 2048 characters.");
  }

  let origin: URL;

  try {
    origin = new URL(parsedInput.data);
  } catch {
    throw new DoctorInputError("The endpoint must be a valid absolute URL.");
  }

  if (origin.username || origin.password) {
    throw new DoctorInputError("The endpoint must not include credentials.");
  }

  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new DoctorInputError(
      "The endpoint must be an origin without a path, query, or fragment.",
    );
  }

  const isHttps = origin.protocol === "https:";
  const isLoopbackHttp = origin.protocol === "http:" && LOOPBACK_HOSTS.has(origin.hostname);

  if (!isHttps && !isLoopbackHttp) {
    throw new DoctorInputError("Use HTTPS, or HTTP only for an exact loopback host.");
  }

  return new URL(origin.origin);
}

type DoctorCheck = DoctorReport["checks"][number];
type DoctorCheckCode = DoctorCheck["code"];
type DoctorCheckName = DoctorCheck["name"];

interface CheckDefinition {
  invalidPayloadMessage: string;
  name: DoctorCheckName;
  path: string;
  schema: z.ZodType;
  subject: string;
  validMessage: string;
}

function createCheck(
  definition: CheckDefinition,
  endpoint: URL,
  code: DoctorCheckCode,
  message: string,
): DoctorCheck {
  const passed = code === "valid";

  return doctorCheckSchema.parse({
    code,
    endpoint: endpoint.href,
    message,
    name: definition.name,
    status: passed ? "pass" : "fail",
  });
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    byteLength += result.value.byteLength;

    if (byteLength > MAX_DIAGNOSTIC_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }

    chunks.push(result.value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function stringArrayContaining(value: string): z.ZodType {
  return z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(32)
    .refine((values) => values.includes(value));
}

function checkDefinitions(origin: URL): [CheckDefinition, CheckDefinition, CheckDefinition] {
  const authBaseUrl = `${origin.origin}${AUTH_BASE_PATH}`;

  return [
    {
      invalidPayloadMessage: "Health endpoint returned an invalid Crewhelm health report.",
      name: "worker-health",
      path: HEALTH_PATH,
      schema: healthReportSchema,
      subject: "Health",
      validMessage: "Worker health contract is valid.",
    },
    {
      invalidPayloadMessage: "Protected-resource endpoint returned invalid Crewhelm MCP metadata.",
      name: "mcp-protected-resource",
      path: PROTECTED_RESOURCE_METADATA_PATH,
      schema: z.strictObject({
        authorization_servers: z.tuple([z.literal(authBaseUrl)]),
        bearer_methods_supported: z.tuple([z.literal("header")]),
        resource: z.literal(`${origin.origin}${MCP_PATH}`),
        scopes_supported: z.tuple([
          z.literal(OWNER_SCOPES[0]),
          z.literal(OWNER_SCOPES[1]),
          z.literal(OWNER_SCOPES[2]),
          z.literal(OWNER_SCOPES[3]),
          z.literal(OWNER_SCOPES[4]),
          z.literal(OWNER_SCOPES[5]),
        ]),
      }),
      subject: "Protected-resource",
      validMessage: "MCP protected-resource metadata is valid.",
    },
    {
      invalidPayloadMessage:
        "Authorization-server endpoint returned invalid Crewhelm OAuth metadata.",
      name: "oauth-authorization-server",
      path: AUTHORIZATION_SERVER_METADATA_PATH,
      schema: z.looseObject({
        authorization_endpoint: z.literal(`${authBaseUrl}/oauth2/authorize`),
        authorization_response_iss_parameter_supported: z.literal(true),
        code_challenge_methods_supported: z.tuple([z.literal("S256")]),
        grant_types_supported: z.tuple([z.literal("authorization_code")]),
        issuer: z.literal(authBaseUrl),
        jwks_uri: z.literal(`${authBaseUrl}/jwks`),
        registration_endpoint: z.literal(`${authBaseUrl}/oauth2/register`),
        response_modes_supported: stringArrayContaining("query"),
        response_types_supported: z.tuple([z.literal("code")]),
        revocation_endpoint: z.literal(`${authBaseUrl}/oauth2/revoke`),
        scopes_supported: z.tuple([
          z.literal(OWNER_SCOPES[0]),
          z.literal(OWNER_SCOPES[1]),
          z.literal(OWNER_SCOPES[2]),
          z.literal(OWNER_SCOPES[3]),
          z.literal(OWNER_SCOPES[4]),
          z.literal(OWNER_SCOPES[5]),
        ]),
        token_endpoint: z.literal(`${authBaseUrl}/oauth2/token`),
        token_endpoint_auth_methods_supported: stringArrayContaining("none"),
      }),
      subject: "Authorization-server",
      validMessage: "OAuth authorization-server metadata is valid.",
    },
  ];
}

async function runCheck(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
  definition: CheckDefinition,
): Promise<DoctorCheck> {
  const endpoint = new URL(definition.path, options.origin);
  let response: Response;
  let body: string;

  try {
    response = await dependencies.fetch(endpoint, {
      headers: {
        accept: "application/json",
      },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    body = await readBoundedBody(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return createCheck(
        definition,
        endpoint,
        "response_too_large",
        `${definition.subject} response exceeded ${MAX_DIAGNOSTIC_RESPONSE_BYTES} bytes.`,
      );
    }

    const timedOut = isTimeout(error);

    return createCheck(
      definition,
      endpoint,
      timedOut ? "timeout" : "request_failed",
      timedOut
        ? `${definition.subject} request timed out.`
        : `${definition.subject} request failed.`,
    );
  }

  if (response.status !== 200) {
    return createCheck(
      definition,
      endpoint,
      "http_status",
      `${definition.subject} endpoint returned an unexpected HTTP status.`,
    );
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

  if (contentType !== "application/json") {
    return createCheck(
      definition,
      endpoint,
      "content_type",
      `${definition.subject} endpoint did not return JSON.`,
    );
  }

  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    return createCheck(
      definition,
      endpoint,
      "invalid_json",
      `${definition.subject} endpoint returned invalid JSON.`,
    );
  }

  if (!definition.schema.safeParse(payload).success) {
    return createCheck(definition, endpoint, "invalid_payload", definition.invalidPayloadMessage);
  }

  return createCheck(definition, endpoint, "valid", definition.validMessage);
}

export interface DoctorDependencies {
  fetch: typeof globalThis.fetch;
}

export interface DoctorOptions {
  origin: URL;
  timeoutMs: number;
}

export async function diagnoseDeployment(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const definitions = checkDefinitions(options.origin);
  const health = await runCheck(options, dependencies, definitions[0]);
  const protectedResource = await runCheck(options, dependencies, definitions[1]);
  const authorizationServer = await runCheck(options, dependencies, definitions[2]);
  const checks: DoctorReport["checks"] = [health, protectedResource, authorizationServer];

  return doctorReportSchema.parse({
    schemaVersion: 2,
    ok: checks.every((check) => check.status === "pass"),
    checks,
  });
}
