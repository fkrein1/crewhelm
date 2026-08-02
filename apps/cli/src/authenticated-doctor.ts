import * as z from "zod";

import { diagnoseDeployment, doctorReportSchema, type DoctorOptions } from "./doctor.js";
import { mcpControlPlaneStatusResultSchema } from "./mcp-result-schemas.js";
import {
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
  parseMcpToolResult,
  parseTemporaryOwnerSessionFailure,
  runTemporaryOwnerSession,
  TemporaryOwnerSessionError,
  temporaryOwnerSessionErrorCodeSchema,
  toolCallResponseSchema,
  toolListResponseSchema,
  type TemporaryOwnerSessionDependencies,
} from "./temporary-owner-session.js";
import { CREWHELM_CLI_VERSION } from "./version.js";

const VIEW_SCOPE = "crewhelm:view";
const MAXIMUM_MCP_SCHEMA_BYTES = 64 * 1_024;

const authenticatedDoctorCheckSchema = z.strictObject({
  code: z.union([z.enum(["valid", "not_run"]), temporaryOwnerSessionErrorCodeSchema]),
  endpoint: z.url(),
  message: z.string().max(512),
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

export type AuthenticatedDoctorDependencies = TemporaryOwnerSessionDependencies;

export interface AuthenticatedDoctorOptions extends DoctorOptions {
  authorizationTimeoutMs?: number;
}

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
  const failure = parseTemporaryOwnerSessionFailure(error);

  if (failure !== null) {
    return createCheck(name, endpoint, failure.code, failure.message);
  }

  return createCheck(name, endpoint, "request_failed", "Authenticated check failed.");
}

function validateToolCatalog(toolList: z.infer<typeof toolListResponseSchema>): void {
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
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "MCP tool catalog violated its bounded read-only contract.",
    );
  }
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
  const authorizeEndpoint = new URL("/api/auth/oauth2/authorize", options.origin);
  const revokeEndpoint = new URL("/api/auth/oauth2/revoke", options.origin);
  const mcpEndpoint = new URL("/mcp", options.origin);
  const checks: AuthenticatedDoctorReport["checks"] = [
    skippedCheck(checkDefinitions.oauthOwnerAccess.name, authorizeEndpoint),
    skippedCheck(checkDefinitions.mcpInitialize.name, mcpEndpoint),
    skippedCheck(checkDefinitions.mcpToolCatalog.name, mcpEndpoint),
    skippedCheck(checkDefinitions.fleetStatus.name, mcpEndpoint),
    skippedCheck(checkDefinitions.oauthTokenRevocation.name, revokeEndpoint),
  ];

  if (!publicReport.ok) {
    return createReport(publicReport, checks);
  }

  let activeCheckIndex = 1;
  const sessionResult = await runTemporaryOwnerSession(
    {
      ...(options.authorizationTimeoutMs === undefined
        ? {}
        : { authorizationTimeoutMs: options.authorizationTimeoutMs }),
      clientName: "Crewhelm authenticated doctor",
      origin: options.origin,
      scope: VIEW_SCOPE,
      timeoutMs: options.timeoutMs,
    },
    dependencies,
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-cli", version: CREWHELM_CLI_VERSION },
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
      const toolList = await session.call("tools/list", {}, toolListResponseSchema);
      validateToolCatalog(toolList);
      checks[2] = createCheck(
        checkDefinitions.mcpToolCatalog.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.mcpToolCatalog.validMessage,
      );

      activeCheckIndex = 3;
      const statusResponse = await session.call(
        "tools/call",
        { arguments: {}, name: "crewhelm_status" },
        toolCallResponseSchema,
      );
      const status = parseMcpToolResult(
        statusResponse,
        mcpControlPlaneStatusResultSchema,
        "Fleet status tool returned an invalid payload.",
      );

      if (!status.ok) {
        throw new TemporaryOwnerSessionError(
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
    },
  );

  checks[0] = sessionResult.authorization.ok
    ? createCheck(
        checkDefinitions.oauthOwnerAccess.name,
        authorizeEndpoint,
        "valid",
        checkDefinitions.oauthOwnerAccess.validMessage,
      )
    : failedCheck(
        checkDefinitions.oauthOwnerAccess.name,
        authorizeEndpoint,
        sessionResult.authorization.error,
      );

  if (sessionResult.operation.status === "failed") {
    checks[activeCheckIndex] = failedCheck(
      checks[activeCheckIndex]!.name,
      mcpEndpoint,
      sessionResult.operation.error,
    );
  }

  if (sessionResult.revocation.status === "revoked") {
    checks[4] = createCheck(
      checkDefinitions.oauthTokenRevocation.name,
      revokeEndpoint,
      "valid",
      checkDefinitions.oauthTokenRevocation.validMessage,
    );
  } else if (sessionResult.revocation.status === "failed") {
    checks[4] = failedCheck(
      checkDefinitions.oauthTokenRevocation.name,
      revokeEndpoint,
      sessionResult.revocation.error,
    );
  }

  return createReport(publicReport, checks);
}
