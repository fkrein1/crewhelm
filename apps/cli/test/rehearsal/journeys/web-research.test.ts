import { describe, expect, it } from "vitest";
import * as z from "zod";

import { commandFixtureCall } from "../facade-fixtures.js";

import {
  hasExactWebResearchToolSequence,
  includesOfficialCloudflareDevelopersUrl,
  runWebResearchRehearsal,
} from "../../../src/rehearsal/journeys/web-research.js";

const origin = "https://crewhelm-testing.example";
const fingerprint = "a".repeat(64);
const timestamp = "2026-08-01T12:00:00.000Z";
const agentId = "agent_11111111-1111-4111-8111-111111111111";
const credential = {
  clientId: "web-research-rehearsal-client",
  origin,
  refreshToken: "old-refresh-token",
  schemaVersion: 1 as const,
  scope: "crewhelm:full" as const,
};
const mcpRequestSchema = z.looseObject({
  id: z.number(),
  method: z.string(),
  params: z.looseObject({
    arguments: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
  }),
});

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("Unexpected request body type.");
}

function publicPayload(path: string): unknown {
  if (path === "/health") {
    return {
      deployment: { fingerprint, protocolVersion: 1 },
      service: "crewhelm",
      status: "ok",
    };
  }
  if (path === "/.well-known/oauth-protected-resource") {
    return {
      authorization_servers: [`${origin}/api/auth`],
      bearer_methods_supported: ["header"],
      resource: `${origin}/mcp`,
      scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
    };
  }
  return {
    authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: `${origin}/api/auth`,
    jwks_uri: `${origin}/api/auth/jwks`,
    registration_endpoint: `${origin}/api/auth/oauth2/register`,
    response_modes_supported: ["query"],
    response_types_supported: ["code"],
    revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
    scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
    token_endpoint: `${origin}/api/auth/oauth2/token`,
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function toolResult(id: number, payload: unknown): Response {
  return Response.json({
    id,
    jsonrpc: "2.0",
    result: { content: [{ text: JSON.stringify(payload), type: "text" }], isError: false },
  });
}

function capability(id: "tools.web-fetch" | "tools.web-search") {
  return {
    availability: { missingPrerequisites: [], state: "available" },
    configurationFields: [],
    description: `${id} fixture`,
    id,
    prerequisites:
      id === "tools.web-search"
        ? [
            {
              description: "Brave Search API key.",
              id: "brave.search",
              kind: "resource",
              setup: {
                command: "crewhelm up",
                mode: "installation-opt-in",
                requirement: "Brave Search API plan and CREWHELM_BRAVE_SEARCH_API_KEY",
              },
            },
          ]
        : [],
    schemaVersion: 1,
    title: id,
    trust: {
      configuration: "untrusted-until-validated",
      runtimeContribution: "module-validated",
    },
  };
}

describe("Web research feature rehearsal", () => {
  it("replays a lost Agent create response and disables the recovered fixture", async () => {
    const createArguments: string[] = [];
    const revoked = new Set<string>();
    let activeAgents = 3;
    let agentStatus: "active" | "disabled" = "active";
    let createdInput: Record<string, unknown> | undefined;
    let disableCalls = 0;
    const currentAgent = () => {
      if (createdInput === undefined) throw new Error("Agent was not created.");
      const agentConfiguration = { ...createdInput };
      delete agentConfiguration.idempotencyKey;
      return {
        ...agentConfiguration,
        capabilityGrants: [],
        createdAt: timestamp,
        id: agentId,
        model: "@cf/zai-org/glm-4.7-flash",
        revision: 1,
        status: agentStatus,
      };
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      if (init?.method !== "POST") return Response.json(publicPayload(url.pathname));
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "secret-access-token",
          expires_in: 900,
          refresh_token: "rotated-refresh-token",
          scope: "crewhelm:full offline_access",
          token_type: "Bearer",
        });
      }
      if (url.pathname.endsWith("/oauth2/revoke")) {
        revoked.add(new URLSearchParams(requestBodyText(init.body)).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname !== "/mcp") throw new Error(`Unexpected request: ${url.pathname}`);
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (revoked.has(token)) return new Response(null, { status: 401 });
      const request = mcpRequestSchema.parse(JSON.parse(requestBodyText(init.body)));
      if (request.method === "initialize") {
        return Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "crewhelm", version: "test" },
          },
        });
      }
      if (request.method === "tools/list") {
        const required = [
          "crewhelm_change_agents",
          "crewhelm_change_work",
          "crewhelm_inspect_agents",
          "crewhelm_inspect_context",
          "crewhelm_inspect_work",
          "crewhelm_status",
        ];
        return Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              ...required,
              ...Array.from({ length: 30 }, (_, index) => `fixture_${index}`),
            ].map((name) => ({
              annotations: {
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
                readOnlyHint: false,
              },
              inputSchema: {},
              name,
            })),
          },
        });
      }

      const fixtureCall = commandFixtureCall({
        arguments: request.params.arguments ?? {},
        name: String(request.params.name),
      });
      const name = fixtureCall.name;
      const toolArguments = z.looseObject({}).parse(fixtureCall.arguments);
      if (name === "crewhelm_get_config") {
        const target = z.looseObject({ id: z.string() }).parse(toolArguments.target);
        return toolResult(request.id, {
          capabilities: [
            capability(target.id === "tools.web-search" ? "tools.web-search" : "tools.web-fetch"),
          ],
          ok: true,
        });
      }
      if (name === "crewhelm_status") {
        return toolResult(request.id, {
          guidance: [],
          ok: true,
          status: {
            capacity: {
              maxAgents: 100,
              maxConcurrentRuns: 25,
              maxConnections: 100,
              retention: { inboxSeconds: 2_592_000, runSeconds: 86_400 },
            },
            configurationRevision: 1,
            schemaVersion: 15,
            status: "ready",
            usage: {
              agents: { active: activeAgents, total: 9 },
              connections: { active: 0, pending: 0, total: 0 },
              diagnostics: { expiredApprovals: 0, pendingAiUsage: 0 },
              inbox: {
                actionRequired: 0,
                attention: { needsAction: 0, oldestNeedsActionAt: null, warnings: 0 },
                deferred: 0,
                exceptions: 0,
                outcomes: 0,
                total: 0,
              },
              recovery: { unresolvedEffects: 0 },
              runs: { active: 0 },
              skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
              workflows: { active: 0, total: 0 },
            },
          },
        });
      }
      if (name === "crewhelm_create_agent") {
        createArguments.push(JSON.stringify(toolArguments));
        createdInput = toolArguments;
        if (createArguments.length === 1) {
          activeAgents += 1;
          return new Response("Injected lost Agent create response.", { status: 503 });
        }
        return toolResult(request.id, {
          agent: currentAgent(),
          created: false,
          ok: true,
        });
      }
      if (name === "crewhelm_start_run") {
        return toolResult(request.id, {
          error: { code: "invalid_request", message: "Run request denied." },
          ok: false,
        });
      }
      if (name === "crewhelm_list_agent_runs") {
        return toolResult(request.id, { nextCursor: null, ok: true, runs: [] });
      }
      if (name === "crewhelm_get_agent") {
        return toolResult(request.id, {
          agent: currentAgent(),
          ok: true,
        });
      }
      if (name === "crewhelm_batch_disable_agents") {
        disableCalls += 1;
        agentStatus = "disabled";
        activeAgents -= 1;
        return toolResult(request.id, {
          ok: true,
          receipts: [{ agentId, disabledAt: timestamp, expectedRevision: 1, outcome: "disabled" }],
        });
      }
      throw new Error(`Unexpected tool call: ${name}`);
    };

    const report = await runWebResearchRehearsal(
      {
        credential,
        origin: new URL(origin),
        persistCredential: async () => undefined,
        runTimeoutMs: 60_000,
        timeoutMs: 5_000,
      },
      { expectedDeploymentFingerprint: fingerprint, fetch, wait: async () => undefined },
    );

    expect(createArguments).toHaveLength(2);
    expect(createArguments[1]).toBe(createArguments[0]);
    expect(disableCalls).toBe(1);
    expect(agentStatus).toBe("disabled");
    expect(report.checks[7]).toEqual({
      code: "valid",
      message: "The short-lived access token was revoked.",
      name: "access-token-revocation",
      status: "pass",
    });
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      checks: [
        ...Array.from({ length: 5 }, () => ({ status: "pass" })),
        { name: "search-and-fetch", status: "fail" },
        { name: "agent-disable", status: "pass" },
        { name: "access-token-revocation", status: "pass" },
      ],
      ok: false,
    });
    expect(revoked).toContain("secret-access-token");
  });
});

describe("Web research live evidence", () => {
  it("accepts only an exact credential-free Cloudflare Developers HTTPS origin", () => {
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "WEB_RESEARCH_OK [source](https://developers.cloudflare.com/agents/).",
      ),
    ).toBe(true);
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "https://developers.cloudflare.com.evil.example/agents/",
      ),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "https://evil.example/developers.cloudflare.com/agents/",
      ),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "https://developers.cloudflare.com@evil.example/agents/",
      ),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl("http://developers.cloudflare.com/agents/"),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl("https://developers.cloudflare.com:444/agents/"),
    ).toBe(false);
  });
});

describe("Web research tool evidence", () => {
  const occurredAt = "2026-08-01T00:00:00.000Z";
  const toolCallId = "tool_call_00000000-0000-4000-8000-000000000000";

  it("requires exactly one completed search followed by one completed fetch", () => {
    expect(
      hasExactWebResearchToolSequence([
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.search", toolCallId },
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.fetch", toolCallId },
      ]),
    ).toBe(true);
    expect(
      hasExactWebResearchToolSequence([
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.search", toolCallId },
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.search", toolCallId },
      ]),
    ).toBe(false);
    expect(
      hasExactWebResearchToolSequence([
        { event: "tool.execution_completed", occurredAt, toolCallId },
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.fetch", toolCallId },
      ]),
    ).toBe(false);
  });
});
