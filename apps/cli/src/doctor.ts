import {
  CREWHELM_DEPLOYMENT_PROTOCOL_VERSION,
  HEALTH_PATH,
  deploymentIdentitySchema,
  healthReportSchema,
  legacyHealthReportSchema,
  type deploymentFingerprintSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

const MAX_DIAGNOSTIC_RESPONSE_BYTES = 4_096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server/api/auth";
const AUTH_BASE_PATH = "/api/auth";
const MCP_PATH = "/mcp";
const OFFLINE_ACCESS_SCOPE = "offline_access";
const OAUTH_SCOPES = [
  "crewhelm:view",
  "crewhelm:use",
  "crewhelm:full",
  OFFLINE_ACCESS_SCOPE,
] as const;

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
const deploymentAlignmentSchema = z.enum([
  "aligned",
  "cli_outdated",
  "different",
  "unavailable",
  "unverified",
  "worker_outdated",
]);
const deploymentProtocolProbeSchema = z.looseObject({
  deployment: z.looseObject({
    protocolVersion: z.number().int().positive().safe(),
  }),
  service: z.literal("crewhelm"),
  status: z.literal("ok"),
});

export const doctorReportSchema = z.strictObject({
  schemaVersion: z.literal(3),
  ok: z.boolean(),
  checks: z.tuple([doctorCheckSchema, doctorCheckSchema, doctorCheckSchema]),
  deployment: z.strictObject({
    alignment: deploymentAlignmentSchema,
    worker: deploymentIdentitySchema.nullable(),
  }),
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

function stringArrayContaining(value: string) {
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
      schema: z.union([healthReportSchema, legacyHealthReportSchema]),
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
          z.literal(OAUTH_SCOPES[0]),
          z.literal(OAUTH_SCOPES[1]),
          z.literal(OAUTH_SCOPES[2]),
          z.literal(OAUTH_SCOPES[3]),
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
        code_challenge_methods_supported: z.tuple([z.literal("S256")]),
        grant_types_supported: stringArrayContaining("authorization_code").refine((values) =>
          values.includes("refresh_token"),
        ),
        issuer: z.literal(authBaseUrl),
        jwks_uri: z.literal(`${authBaseUrl}/jwks`),
        registration_endpoint: z.literal(`${authBaseUrl}/oauth2/register`),
        response_modes_supported: stringArrayContaining("query"),
        response_types_supported: z.tuple([z.literal("code")]),
        revocation_endpoint: z.literal(`${authBaseUrl}/oauth2/revoke`),
        scopes_supported: z.tuple([
          z.literal(OAUTH_SCOPES[0]),
          z.literal(OAUTH_SCOPES[1]),
          z.literal(OAUTH_SCOPES[2]),
          z.literal(OAUTH_SCOPES[3]),
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
  onPayload?: (payload: unknown) => void,
): Promise<DoctorCheck> {
  const endpoint = new URL(definition.path, options.origin);
  const requestEndpoint = new URL(endpoint);
  requestEndpoint.searchParams.set("crewhelm-doctor", Date.now().toString(36));
  let response: Response;
  let body: string;

  try {
    response = await dependencies.fetch(requestEndpoint, {
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

  onPayload?.(payload);
  const parsed = definition.schema.safeParse(payload);

  if (!parsed.success) {
    return createCheck(definition, endpoint, "invalid_payload", definition.invalidPayloadMessage);
  }

  return createCheck(definition, endpoint, "valid", definition.validMessage);
}

export interface DoctorDependencies {
  expectedDeploymentFingerprint?: z.infer<typeof deploymentFingerprintSchema>;
  fetch: typeof globalThis.fetch;
}

export interface DoctorOptions {
  origin: URL;
  timeoutMs: number;
}

type HealthDeployment = z.infer<typeof deploymentIdentitySchema> | null | undefined;

function classifyDeployment(
  healthDeployment: HealthDeployment,
  advertisedProtocolVersion: number | undefined,
  expectedFingerprint: DoctorDependencies["expectedDeploymentFingerprint"],
): DoctorReport["deployment"] {
  const alignment =
    advertisedProtocolVersion !== undefined &&
    advertisedProtocolVersion > CREWHELM_DEPLOYMENT_PROTOCOL_VERSION
      ? "cli_outdated"
      : healthDeployment === undefined
        ? "unavailable"
        : healthDeployment === null ||
            healthDeployment.protocolVersion < CREWHELM_DEPLOYMENT_PROTOCOL_VERSION
          ? "worker_outdated"
          : healthDeployment.protocolVersion > CREWHELM_DEPLOYMENT_PROTOCOL_VERSION
            ? "cli_outdated"
            : expectedFingerprint === undefined
              ? "unverified"
              : healthDeployment.fingerprint === expectedFingerprint
                ? "aligned"
                : "different";

  return {
    alignment,
    worker: healthDeployment ?? null,
  };
}

async function inspectDeploymentHealth(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
  definition: CheckDefinition,
): Promise<{
  advertisedProtocolVersion: number | undefined;
  check: DoctorCheck;
  deployment: HealthDeployment;
}> {
  let deployment: HealthDeployment;
  let advertisedProtocolVersion: number | undefined;
  const check = await runCheck(options, dependencies, definition, (payload) => {
    const probe = deploymentProtocolProbeSchema.safeParse(payload);
    const current = healthReportSchema.safeParse(payload);
    const legacy = legacyHealthReportSchema.safeParse(payload);
    advertisedProtocolVersion = probe.success ? probe.data.deployment.protocolVersion : undefined;
    deployment = current.success ? current.data.deployment : legacy.success ? null : undefined;
  });
  return { advertisedProtocolVersion, check, deployment };
}

export async function diagnoseDeploymentAlignment(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorReport["deployment"]> {
  const health = await inspectDeploymentHealth(
    options,
    dependencies,
    checkDefinitions(options.origin)[0],
  );
  return classifyDeployment(
    health.deployment,
    health.advertisedProtocolVersion,
    dependencies.expectedDeploymentFingerprint,
  );
}

export async function diagnoseDeployment(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const definitions = checkDefinitions(options.origin);
  const [health, protectedResource, authorizationServer] = await Promise.all([
    inspectDeploymentHealth(options, dependencies, definitions[0]),
    runCheck(options, dependencies, definitions[1]),
    runCheck(options, dependencies, definitions[2]),
  ]);
  const checks: DoctorReport["checks"] = [health.check, protectedResource, authorizationServer];
  const deployment = classifyDeployment(
    health.deployment,
    health.advertisedProtocolVersion,
    dependencies.expectedDeploymentFingerprint,
  );

  return doctorReportSchema.parse({
    schemaVersion: 3,
    ok:
      checks.every((check) => check.status === "pass") &&
      (dependencies.expectedDeploymentFingerprint === undefined ||
        deployment.alignment === "aligned"),
    checks,
    deployment,
  });
}
