import { env, runInDurableObject } from "cloudflare:test";
import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTION_CONFIGS_READ_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  MAXIMUM_AGENT_INBOX_ITEMS,
  MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  agentInboxResultSchema,
  batchDisableAgentsResultSchema,
  changeAuthorityResultSchema,
  createAgentResultSchema,
  createConnectionLinkResultSchema,
  configureAgentConnectionResultSchema,
  controlPlaneStatusResultSchema,
  configureFleetConfigurationResultSchema,
  enableIntegrationResultSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  getAgentCapabilityCatalogResultSchema,
  getFleetConfigurationResultSchema,
  integrationAuthConfigListResultSchema,
  integrationCatalogSearchResultSchema,
  inspectIntegrationToolResultSchema,
  inspectRunResultSchema,
  integrationToolSearchResultSchema,
  listAgentRevisionsResultSchema,
  listAgentsResultSchema,
  listConnectionsResultSchema,
  listUnresolvedToolEffectsResultSchema,
  ownerAuthoritySchema,
  startRunResultSchema,
  updateAgentResultSchema,
  type OwnerScope,
} from "@crewhelm/contracts";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  MCP_AGENT_INBOX_TOOL_NAME,
  MCP_BATCH_DISABLE_AGENTS_TOOL_NAME,
  MCP_CANCEL_RUN_TOOL_NAME,
  MCP_CONFIGURE_TOOL_NAME,
  MCP_CREATE_AGENT_TOOL_NAME,
  MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
  MCP_ENABLE_INTEGRATION_TOOL_NAME,
  MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME,
  MCP_CONFIGURE_AGENT_SCHEDULE_TOOL_NAME,
  MCP_GET_AGENT_TOOL_NAME,
  MCP_GET_CONFIGURATION_TOOL_NAME,
  MCP_GET_AGENT_REVISION_TOOL_NAME,
  MCP_GET_AGENT_SCHEDULE_TOOL_NAME,
  MCP_INSPECT_INTEGRATION_TOOL_NAME,
  MCP_INSPECT_RUN_TOOL_NAME,
  MCP_LIST_INTEGRATION_AUTH_CONFIGS_TOOL_NAME,
  MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
  MCP_LIST_AGENT_RUNS_TOOL_NAME,
  MCP_LIST_AGENTS_TOOL_NAME,
  MCP_LIST_CONNECTIONS_TOOL_NAME,
  MCP_LIST_UNRESOLVED_TOOL_EFFECTS_TOOL_NAME,
  MCP_LIST_RUN_TOOL_APPROVALS_TOOL_NAME,
  MCP_SERIALIZED_SCHEMA_SIZE_BUDGET_BYTES,
  MCP_DECIDE_RUN_TOOL_APPROVAL_TOOL_NAME,
  MCP_RECONCILE_TOOL_EXECUTION_TOOL_NAME,
  MCP_REVOKE_AUTHORITY_TOOL_NAME,
  MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
  MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
  MCP_STATUS_TOOL_NAME,
  MCP_TOOL_COUNT_BUDGET,
  MCP_START_RUN_TOOL_NAME,
  MCP_UPDATE_AGENT_TOOL_NAME,
  handleAuthenticatedMcpRequest,
} from "./server.js";
import { TEST_REPLY } from "../agent/admitted-runs/test-agent.js";
import { deriveOwnerKey } from "../owner/identity.js";

const origin = "https://crewhelm.test";
const signingSecret = "test-better-auth-secret-that-is-at-least-32-bytes";
const jsonRpcToolResultSchema = z.looseObject({
  result: z.looseObject({
    content: z.array(
      z.looseObject({
        text: z.string().optional(),
        type: z.string(),
      }),
    ),
    isError: z.boolean(),
  }),
});
const jsonRpcToolListSchema = z.looseObject({
  result: z.looseObject({
    tools: z.array(
      z.looseObject({
        annotations: z.looseObject({
          destructiveHint: z.boolean(),
          idempotentHint: z.boolean(),
          openWorldHint: z.boolean(),
          readOnlyHint: z.boolean(),
        }),
        description: z.string(),
        inputSchema: z.looseObject({}),
        name: z.string(),
      }),
    ),
  }),
});

async function ownerAuthority(subject = "123456", scopes: OwnerScope[] = [OWNER_READ_SCOPE]) {
  return ownerAuthoritySchema.parse({
    clientId: "test-client",
    ownerKey: await deriveOwnerKey({
      issuer: "https://github.com",
      subject,
    }),
    scopes,
  });
}

function toolRequest(body: string, additionalHeaders?: HeadersInit): Request {
  const headers = new Headers(additionalHeaders);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("mcp-protocol-version", "2025-11-25");

  return new Request(`${origin}/mcp`, {
    body,
    headers,
    method: "POST",
  });
}

function fixedAgentFailure(code: string) {
  return {
    error: {
      code,
      message: "Agent request denied.",
    },
    ok: false,
  };
}

async function unavailableControlPlane(): Promise<never> {
  throw new Error("control-plane secret");
}

describe("authenticated MCP handler", () => {
  it("accepts the stateless initialize request used by installation diagnosis", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: {
              name: "crewhelm-cli",
              version: "0.0.0",
            },
            protocolVersion: "2025-11-25",
          },
        }),
      ),
      env,
      { authority },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      jsonrpc: "2.0",
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: {
          name: "crewhelm",
          version: "0.1.0",
        },
      },
    });
  });

  it("keeps the advertised MCP surface within explicit tool-count and schema budgets", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        }),
      ),
      env,
      { authority },
    );
    const tools = jsonRpcToolListSchema.parse(await response.json()).result.tools;
    const serializedSchemas = new TextEncoder().encode(
      JSON.stringify(tools.map((tool) => tool.inputSchema)),
    ).byteLength;

    expect(tools.length).toBeLessThanOrEqual(MCP_TOOL_COUNT_BUDGET);
    expect(serializedSchemas).toBeLessThanOrEqual(MCP_SERIALIZED_SCHEMA_SIZE_BUDGET_BYTES);
  });

  it("marks Agent replacement as destructive while keeping creation additive", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        }),
      ),
      env,
      { authority },
    );
    const payload = jsonRpcToolListSchema.parse(await response.json());
    const createTool = payload.result.tools.find(
      (tool) => tool.name === MCP_CREATE_AGENT_TOOL_NAME,
    );
    const updateTool = payload.result.tools.find(
      (tool) => tool.name === MCP_UPDATE_AGENT_TOOL_NAME,
    );
    const connectionLinkTool = payload.result.tools.find(
      (tool) => tool.name === MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
    );
    const enableIntegrationTool = payload.result.tools.find(
      (tool) => tool.name === MCP_ENABLE_INTEGRATION_TOOL_NAME,
    );
    const connectionListTool = payload.result.tools.find(
      (tool) => tool.name === MCP_LIST_CONNECTIONS_TOOL_NAME,
    );
    const unresolvedEffectsTool = payload.result.tools.find(
      (tool) => tool.name === MCP_LIST_UNRESOLVED_TOOL_EFFECTS_TOOL_NAME,
    );
    const startRunTool = payload.result.tools.find((tool) => tool.name === MCP_START_RUN_TOOL_NAME);
    const inboxTool = payload.result.tools.find((tool) => tool.name === MCP_AGENT_INBOX_TOOL_NAME);
    const configureScheduleTool = payload.result.tools.find(
      (tool) => tool.name === MCP_CONFIGURE_AGENT_SCHEDULE_TOOL_NAME,
    );
    const cancelRunTool = payload.result.tools.find(
      (tool) => tool.name === MCP_CANCEL_RUN_TOOL_NAME,
    );
    const inspectRunTool = payload.result.tools.find(
      (tool) => tool.name === MCP_INSPECT_RUN_TOOL_NAME,
    );
    const listApprovalsTool = payload.result.tools.find(
      (tool) => tool.name === MCP_LIST_RUN_TOOL_APPROVALS_TOOL_NAME,
    );
    const decideApprovalTool = payload.result.tools.find(
      (tool) => tool.name === MCP_DECIDE_RUN_TOOL_APPROVAL_TOOL_NAME,
    );
    const getConfigurationTool = payload.result.tools.find(
      (tool) => tool.name === MCP_GET_CONFIGURATION_TOOL_NAME,
    );
    const configureTool = payload.result.tools.find(
      (tool) => tool.name === MCP_CONFIGURE_TOOL_NAME,
    );
    const recoveryTools = payload.result.tools.filter(
      (tool) =>
        tool.name === MCP_BATCH_DISABLE_AGENTS_TOOL_NAME ||
        tool.name === MCP_REVOKE_AUTHORITY_TOOL_NAME ||
        tool.name === MCP_RECONCILE_TOOL_EXECUTION_TOOL_NAME,
    );
    const revisionTools = payload.result.tools.filter(
      (tool) =>
        tool.name === MCP_GET_AGENT_REVISION_TOOL_NAME ||
        tool.name === MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
    );
    const scheduleReadTools = payload.result.tools.filter(
      (tool) =>
        tool.name === MCP_GET_AGENT_SCHEDULE_TOOL_NAME ||
        tool.name === MCP_LIST_AGENT_RUNS_TOOL_NAME,
    );

    expect(createTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(updateTool?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(configureScheduleTool?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(inboxTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(scheduleReadTools).toHaveLength(2);
    expect(scheduleReadTools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(connectionLinkTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    });
    expect(enableIntegrationTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    });
    expect(connectionListTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    });
    expect(unresolvedEffectsTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    });
    expect(listApprovalsTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    });
    expect(decideApprovalTool?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(recoveryTools).toHaveLength(3);
    expect(
      recoveryTools.every(
        (tool) =>
          tool.annotations.destructiveHint &&
          tool.annotations.idempotentHint &&
          !tool.annotations.openWorldHint &&
          !tool.annotations.readOnlyHint,
      ),
    ).toBe(true);
    expect(startRunTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(cancelRunTool?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(inspectRunTool?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    });
    expect(revisionTools).toHaveLength(2);
    expect(
      revisionTools.every(
        (tool) =>
          !tool.annotations.destructiveHint &&
          tool.annotations.idempotentHint &&
          !tool.annotations.openWorldHint &&
          tool.annotations.readOnlyHint,
      ),
    ).toBe(true);
    expect(getConfigurationTool).toMatchObject({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: expect.stringContaining("deterministic owner step-up path"),
    });
    expect(getConfigurationTool?.description).toContain("--ai-budget-usd");
    const getConfigurationInputSchema = JSON.stringify(getConfigurationTool?.inputSchema);
    expect(getConfigurationInputSchema).toContain('"target"');
    expect(getConfigurationInputSchema).toContain('"fleet"');
    expect(getConfigurationInputSchema).toContain('"agent-capability"');
    expect(getConfigurationInputSchema).toContain('"id"');
    expect(configureTool).toMatchObject({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: expect.stringContaining("never applies policy changes"),
    });
    expect(JSON.stringify(configureTool?.inputSchema)).toContain(
      "Current revision returned by crewhelm_get_config",
    );
    expect(JSON.stringify(configureTool?.inputSchema)).toContain("bounds accidental loops");
  });

  it("returns owner control-plane status through the read-only MCP tool", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_STATUS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );

    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(typeof text).toBe("string");
    expect(controlPlaneStatusResultSchema.parse(JSON.parse(text ?? ""))).toMatchObject({
      ok: true,
      status: {
        schemaVersion: 18,
        status: "ready",
        usage: {
          recovery: { unresolvedEffects: 0 },
        },
      },
    });
  });

  it("lists bounded unresolved provider effects through a read-only MCP tool", async () => {
    const authority = await ownerAuthority("mcp-unresolved-effects-owner");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { limit: 1 },
            name: MCP_LIST_UNRESOLVED_TOOL_EFFECTS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const result = jsonRpcToolResultSchema.parse(await response.json()).result;

    expect(
      listUnresolvedToolEffectsResultSchema.parse(JSON.parse(result.content[0]?.text ?? "")),
    ).toEqual({
      effects: [],
      nextCursor: null,
      ok: true,
      total: 0,
    });
  });

  it("reads and previews a documented fleet configuration change through MCP", async () => {
    const authority = await ownerAuthority("mcp-configuration-owner", [
      OWNER_READ_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const readResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { target: { kind: "fleet" } },
            name: MCP_GET_CONFIGURATION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const readResult = jsonRpcToolResultSchema.parse(await readResponse.json()).result;
    const current = getFleetConfigurationResultSchema.parse(
      JSON.parse(readResult.content[0]?.text ?? ""),
    );

    expect(current).toMatchObject({ configuration: { revision: 1 }, ok: true });
    if (!current.ok) {
      throw new Error("Expected MCP fleet configuration.");
    }

    const previewResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              expectedRevision: current.configuration.revision,
              mode: "preview",
              patch: { integrations: { duplicateToolCallLimit: 3 } },
              target: { kind: "fleet" },
            },
            name: MCP_CONFIGURE_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const previewResult = jsonRpcToolResultSchema.parse(await previewResponse.json()).result;

    expect(
      configureFleetConfigurationResultSchema.parse(
        JSON.parse(previewResult.content[0]?.text ?? ""),
      ),
    ).toMatchObject({
      applied: false,
      configuration: {
        data: { integrations: { duplicateToolCallLimit: 3 } },
        revision: 2,
      },
      ok: true,
    });

    const applyResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              expectedRevision: current.configuration.revision,
              idempotencyKey: "model-must-not-apply-fleet-config",
              mode: "apply",
              patch: { integrations: { duplicateToolCallLimit: 3 } },
              target: { kind: "fleet" },
            },
            name: MCP_CONFIGURE_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const applyResult = jsonRpcToolResultSchema.parse(await applyResponse.json()).result;
    const unchanged = await env.OWNER_CONTROL_PLANE.getByName(
      authority.ownerKey,
    ).getFleetConfiguration(authority, { target: { kind: "fleet" } });

    expect(applyResult.isError).toBe(true);
    expect(unchanged).toMatchObject({ configuration: { revision: 1 }, ok: true });
  });

  it("discovers one bounded Agent capability through the existing configuration surface", async () => {
    const authority = await ownerAuthority("mcp-capability-catalog-owner", [OWNER_READ_SCOPE]);
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              target: {
                id: "inference.workers-ai",
                kind: "agent-capability",
              },
            },
            name: MCP_GET_CONFIGURATION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const result = jsonRpcToolResultSchema.parse(await response.json()).result;

    expect(
      getAgentCapabilityCatalogResultSchema.parse(JSON.parse(result.content[0]?.text ?? "")),
    ).toEqual({
      capabilities: [
        {
          availability: {
            missingPrerequisites: [],
            state: "available",
          },
          configurationFields: [
            {
              description: "Supported Workers AI model; the fleet policy may narrow this list.",
              enum: [
                "@cf/ibm-granite/granite-4.0-h-micro",
                "@cf/meta/llama-4-scout-17b-16e-instruct",
                "@cf/openai/gpt-oss-20b",
                "@cf/qwen/qwen3-30b-a3b-fp8",
                "@cf/zai-org/glm-4.7-flash",
              ],
              name: "model",
              required: true,
              type: "string",
            },
          ],
          description:
            "Selects the Cloudflare Workers AI model used for Agent reasoning and tool orchestration.",
          id: "inference.workers-ai",
          prerequisites: [
            {
              description: "Cloudflare Workers AI binding used for admitted model calls.",
              id: "binding.ai",
              kind: "binding",
            },
          ],
          schemaVersion: 1,
          title: "Workers AI inference",
          trust: {
            configuration: "untrusted-until-validated",
            runtimeContribution: "module-validated",
          },
        },
      ],
      ok: true,
    });
    expect(result.isError).toBe(false);
  });

  it("disables an Agent through the recovery MCP tool", async () => {
    const authority = await ownerAuthority("mcp-recovery-owner", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      executionLimits: {
        maxDurationSeconds: 60,
        maxModelTokens: 2_000,
        maxToolCalls: 1,
        maxTurns: 2,
      },
      idempotencyKey: "mcp-recovery-agent",
      instructions: "Stop immediately when disabled.",
      name: "Recovery Agent",
    });

    if (!created.ok) {
      throw new Error("Expected recovery Agent.");
    }
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { agentId: created.agent.id, target: "agent" },
            name: MCP_REVOKE_AUTHORITY_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;

    expect(result.isError).toBe(false);
    expect(changeAuthorityResultSchema.parse(JSON.parse(result.content[0]?.text ?? ""))).toEqual({
      changed: true,
      ok: true,
      state: {
        agentId: created.agent.id,
        status: "disabled",
        target: "agent",
      },
    });
  });

  it("disables exact Agent revisions through the bounded recovery MCP tool", async () => {
    const authority = await ownerAuthority("mcp-batch-recovery-owner", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await Promise.all([
      controlPlane.createAgent(authority, {
        executionLimits: {
          maxDurationSeconds: 60,
          maxModelTokens: 2_000,
          maxToolCalls: 1,
          maxTurns: 2,
        },
        idempotencyKey: "mcp-batch-recovery-agent-1",
        instructions: "Stop immediately when disabled.",
        name: "Batch Recovery Agent One",
      }),
      controlPlane.createAgent(authority, {
        executionLimits: {
          maxDurationSeconds: 60,
          maxModelTokens: 2_000,
          maxToolCalls: 1,
          maxTurns: 2,
        },
        idempotencyKey: "mcp-batch-recovery-agent-2",
        instructions: "Stop immediately when disabled.",
        name: "Batch Recovery Agent Two",
      }),
    ]);

    if (!created[0].ok || !created[1].ok) {
      throw new Error("Expected batch recovery Agents.");
    }

    const agents = [created[0].agent, created[1].agent].map((agent) => ({
      agentId: agent.id,
      expectedRevision: agent.revision,
    }));
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { agents },
            name: MCP_BATCH_DISABLE_AGENTS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;

    expect(result.isError).toBe(false);
    expect(batchDisableAgentsResultSchema.parse(JSON.parse(result.content[0]?.text ?? ""))).toEqual(
      {
        ok: true,
        receipts: agents.map((agent) => ({ ...agent, outcome: "disabled" })),
      },
    );
  });

  it("rejects missing or malformed authority before MCP parsing", async () => {
    const request = toolRequest('{"do-not-reflect":"secret"}');
    const response = await handleAuthenticatedMcpRequest(request, env, {
      authority: {
        clientId: "test-client",
        ownerKey: "not-an-owner-key",
        scopes: [OWNER_READ_SCOPE],
      },
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain("secret");
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "invalid_authority",
        message: "MCP request denied.",
      },
    });
  });

  it("rejects cross-origin browser requests", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest("{}", { origin: "https://attacker.example" }),
      env,
      { authority },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_origin",
        message: "MCP request denied.",
      },
    });
  });

  it("rejects oversized requests before reading their body", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest("{}", { "content-length": String(64 * 1024 + 1) }),
      env,
      { authority },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "request_too_large",
        message: "MCP request denied.",
      },
    });
  });

  it("returns a fixed MCP error when the control plane fails", async () => {
    const authority = await ownerAuthority();
    const failingEnv = {
      BETTER_AUTH_SECRET: signingSecret,
      OWNER_CONTROL_PLANE: {
        getByName: () => ({
          agentInbox: async () => {
            throw new Error("do-not-reflect-this");
          },
          batchDisableAgents: async () => {
            throw new Error("do-not-reflect-this");
          },
          cancelRun: async () => {
            throw new Error("do-not-reflect-this");
          },
          changeAuthority: async () => {
            throw new Error("do-not-reflect-this");
          },
          configureAgentConnection: async () => {
            throw new Error("do-not-reflect-this");
          },
          configureFleetConfiguration: async () => {
            throw new Error("do-not-reflect-this");
          },
          configureAgentSchedule: async () => {
            throw new Error("do-not-reflect-this");
          },
          createAgent: async () => {
            throw new Error("do-not-reflect-this");
          },
          completeConnectionLink: async () => {
            throw new Error("do-not-reflect-this");
          },
          completeIntegrationEnablement: async () => {
            throw new Error("do-not-reflect-this");
          },
          getAgent: async () => {
            throw new Error("do-not-reflect-this");
          },
          getAgentRevision: async () => {
            throw new Error("do-not-reflect-this");
          },
          getAgentSchedule: async () => {
            throw new Error("do-not-reflect-this");
          },
          getFleetConfiguration: async () => {
            throw new Error("do-not-reflect-this");
          },
          inspectRun: async () => {
            throw new Error("do-not-reflect-this");
          },
          decideRunToolApproval: async () => {
            throw new Error("do-not-reflect-this");
          },
          listAgentRevisions: async () => {
            throw new Error("do-not-reflect-this");
          },
          listAgentRuns: async () => {
            throw new Error("do-not-reflect-this");
          },
          listAgents: async () => {
            throw new Error("do-not-reflect-this");
          },
          listConnections: async () => {
            throw new Error("do-not-reflect-this");
          },
          listUnresolvedToolEffects: async () => {
            throw new Error("do-not-reflect-this");
          },
          listRunToolApprovals: async () => {
            throw new Error("do-not-reflect-this");
          },
          lookupAgentConnectionConfiguration: async () => {
            throw new Error("do-not-reflect-this");
          },
          reserveConnectionLink: async () => {
            throw new Error("do-not-reflect-this");
          },
          reserveIntegrationEnablement: async () => {
            throw new Error("do-not-reflect-this");
          },
          reconcileToolExecution: async () => {
            throw new Error("do-not-reflect-this");
          },
          resolveConnectionForAttachment: async () => {
            throw new Error("do-not-reflect-this");
          },
          status: async () => {
            throw new Error("do-not-reflect-this");
          },
          startRun: async () => {
            throw new Error("do-not-reflect-this");
          },
          updateAgent: async () => {
            throw new Error("do-not-reflect-this");
          },
        }),
      },
      PUBLIC_ORIGIN: origin,
    };
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_STATUS_TOOL_NAME,
          },
        }),
      ),
      failingEnv,
      { authority },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("control_plane_unavailable");
    expect(body).not.toContain("do-not-reflect-this");
  });

  it("advertises POST as the only stateless MCP request method", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(new Request(`${origin}/mcp`), env, {
      authority,
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("does not let the OAuth route prefix expose adjacent paths", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      new Request(`${origin}/mcp/private`),
      env,
      { authority },
    );

    expect(response.status).toBe(404);
  });

  it("creates and lists an owner-scoped Agent through MCP", async () => {
    const authority = await ownerAuthority("mcp-agent-owner", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const input = {
      executionLimits: {
        maxDurationSeconds: 120,
        maxModelTokens: 8_000,
        maxToolCalls: 0,
        maxTurns: 3,
      },
      idempotencyKey: "mcp-create-agent-1",
      instructions: "Keep a concise owner-controlled work queue.",
      name: "Work queue",
    };
    const createResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 10,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: input,
            name: MCP_CREATE_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const createPayload: unknown = await createResponse.json();
    const createText = jsonRpcToolResultSchema.parse(createPayload).result.content[0]?.text;
    const created = createAgentResultSchema.parse(JSON.parse(createText ?? ""));

    expect(created).toMatchObject({
      agent: {
        capabilityGrants: [],
        instructions: input.instructions,
        revision: 1,
      },
      created: true,
      ok: true,
    });

    const listResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 11,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_LIST_AGENTS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const listPayload: unknown = await listResponse.json();
    const listText = jsonRpcToolResultSchema.parse(listPayload).result.content[0]?.text;
    const listed = listAgentsResultSchema.parse(JSON.parse(listText ?? ""));

    expect(listed).toMatchObject({
      agents: [{ name: input.name, revision: 1 }],
      nextCursor: null,
      ok: true,
    });
    expect(listText).not.toContain(input.instructions);

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const getResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 12,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { id: created.agent.id },
            name: MCP_GET_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const getPayload: unknown = await getResponse.json();
    const getResult = jsonRpcToolResultSchema.parse(getPayload).result;
    const getText = getResult.content[0]?.text;

    expect(getResult.isError).toBe(false);
    expect(getAgentResultSchema.parse(JSON.parse(getText ?? ""))).toEqual({
      agent: created.agent,
      ok: true,
    });

    const updateResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 13,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              ...input,
              capabilities: created.agent.capabilities,
              expectedRevision: 1,
              id: created.agent.id,
              idempotencyKey: "mcp-update-agent-1",
              instructions: "Keep a concise work queue and coordinate approved tools.",
              name: "Work coordinator",
            },
            name: MCP_UPDATE_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const updatePayload: unknown = await updateResponse.json();
    const updateResult = jsonRpcToolResultSchema.parse(updatePayload).result;
    const updateText = updateResult.content[0]?.text;
    const updated = updateAgentResultSchema.parse(JSON.parse(updateText ?? ""));

    expect(updateResult.isError).toBe(false);
    expect(updated).toMatchObject({
      agent: {
        id: created.agent.id,
        name: "Work coordinator",
        revision: 2,
      },
      ok: true,
      updated: true,
    });
    const revisionsResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 14,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { id: created.agent.id },
            name: MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const revisionsPayload: unknown = await revisionsResponse.json();
    const revisionsResult = jsonRpcToolResultSchema.parse(revisionsPayload).result;
    const revisionsText = revisionsResult.content[0]?.text;

    expect(revisionsResult.isError).toBe(false);
    expect(listAgentRevisionsResultSchema.parse(JSON.parse(revisionsText ?? ""))).toMatchObject({
      nextCursor: null,
      ok: true,
      revisions: [
        { id: created.agent.id, name: "Work coordinator", revision: 2 },
        { id: created.agent.id, name: "Work queue", revision: 1 },
      ],
    });
    expect(revisionsText).not.toContain(input.instructions);
    const revisionResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 15,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { id: created.agent.id, revision: 1 },
            name: MCP_GET_AGENT_REVISION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const revisionPayload: unknown = await revisionResponse.json();
    const revisionResult = jsonRpcToolResultSchema.parse(revisionPayload).result;

    expect(revisionResult.isError).toBe(false);
    expect(
      getAgentRevisionResultSchema.parse(JSON.parse(revisionResult.content[0]?.text ?? "")),
    ).toEqual({
      agent: {
        ...created.agent,
        revisedAt: created.agent.createdAt,
      },
      ok: true,
    });
  });

  it("starts and inspects a durable Agent run through MCP", async () => {
    const authority = await ownerAuthority("mcp-run-owner", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      executionLimits: {
        maxDurationSeconds: 45,
        maxModelTokens: 2_000,
        maxToolCalls: 0,
        maxTurns: 4,
      },
      idempotencyKey: "mcp-run-agent",
      instructions: "Return one concise, plain-text answer.",
      name: "MCP run Agent",
    });

    if (!created.ok) {
      throw new Error("Expected MCP run fixture Agent.");
    }

    const runInput = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "mcp-run-1",
      prompt: "Complete this bounded MCP run.",
    };
    const startResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 30,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: runInput,
            name: MCP_START_RUN_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const startPayload = jsonRpcToolResultSchema.parse(await startResponse.json()).result;
    const started = startRunResultSchema.parse(JSON.parse(startPayload.content[0]?.text ?? ""));

    expect(startPayload.isError).toBe(false);
    expect(started).toMatchObject({
      created: true,
      ok: true,
      run: {
        agentId: created.agent.id,
        agentRevision: created.agent.revision,
      },
    });

    if (!started.ok) {
      throw new Error("Expected MCP run to start.");
    }

    const inspected = await vi.waitFor(
      async () => {
        const response = await handleAuthenticatedMcpRequest(
          toolRequest(
            JSON.stringify({
              id: 31,
              jsonrpc: "2.0",
              method: "tools/call",
              params: {
                arguments: { runId: started.run.runId },
                name: MCP_INSPECT_RUN_TOOL_NAME,
              },
            }),
          ),
          env,
          { authority },
        );
        const payload = jsonRpcToolResultSchema.parse(await response.json()).result;
        const result = inspectRunResultSchema.parse(JSON.parse(payload.content[0]?.text ?? ""));

        expect(payload.isError).toBe(false);
        expect(result).toMatchObject({
          diagnosis: null,
          ok: true,
          request: { prompt: runInput.prompt },
          retention: {
            availableUntil: expect.any(String),
            output: {
              retainedCharacters: TEST_REPLY.length,
              truncated: false,
            },
          },
          run: {
            output: TEST_REPLY,
            outputTruncated: false,
            runId: started.run.runId,
            status: "completed",
          },
          timelinePage: {
            nextCursor: null,
            startSequence: 0,
            totalEvents: expect.any(Number),
          },
          usage: {
            modelCalls: { used: 1 },
          },
        });

        return result;
      },
      { interval: 25, timeout: 5_000 },
    );
    const inboxResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 32,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { action: "list", limit: 10 },
            name: MCP_AGENT_INBOX_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const inboxPayload = jsonRpcToolResultSchema.parse(await inboxResponse.json()).result;
    const inbox = agentInboxResultSchema.parse(JSON.parse(inboxPayload.content[0]?.text ?? ""));

    expect(inboxPayload.isError).toBe(false);
    expect(inbox).toMatchObject({
      action: "list",
      items: [
        {
          agentId: created.agent.id,
          agentName: "MCP run Agent",
          configuration: {
            agentRevision: created.agent.revision,
            fleetRevision: 1,
            scheduleRevision: null,
          },
          kind: "outcome",
          needsAction: false,
          nextAction: "review_output",
          requestPreview: runInput.prompt,
          resultPreview: TEST_REPLY,
          runId: started.run.runId,
          runStatus: "completed",
          severity: "info",
        },
      ],
      ok: true,
    });
    const overviewResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 321,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { action: "overview" },
            name: MCP_AGENT_INBOX_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const overviewPayload = jsonRpcToolResultSchema.parse(await overviewResponse.json()).result;

    expect(
      agentInboxResultSchema.parse(JSON.parse(overviewPayload.content[0]?.text ?? "")),
    ).toMatchObject({
      action: "overview",
      counts: {
        actionRequired: 0,
        deferred: 0,
        exceptions: 0,
        outcomes: 1,
        total: 1,
      },
      ok: true,
    });

    if (!inbox.ok || inbox.action !== "list" || inbox.items[0] === undefined) {
      throw new Error("Expected completed run in Agent inbox.");
    }

    const item = inbox.items[0];
    const maximumPage = agentInboxResultSchema.parse({
      action: "list",
      generatedAt: new Date().toISOString(),
      items: Array.from({ length: MAXIMUM_AGENT_INBOX_ITEMS }, (_, index) => {
        const suffix = (index + 1).toString(16).padStart(12, "0");
        const runId = `run_00000000-0000-4000-8000-${suffix}`;

        return {
          ...item,
          itemId: `inbox_${runId}`,
          requestPreview: "r".repeat(MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS),
          resultPreview: "o".repeat(MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS),
          runId,
          summary: "s".repeat(MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS),
        };
      }),
      nextCursor: null,
      ok: true,
      pollAfterSeconds: 30,
    });

    expect(new TextEncoder().encode(JSON.stringify(maximumPage)).byteLength).toBeLessThan(
      64 * 1_024,
    );

    const acknowledgeResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 33,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              action: "acknowledge",
              itemId: item.itemId,
              version: item.version,
            },
            name: MCP_AGENT_INBOX_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const acknowledgePayload = jsonRpcToolResultSchema.parse(
      await acknowledgeResponse.json(),
    ).result;

    expect(
      agentInboxResultSchema.parse(JSON.parse(acknowledgePayload.content[0]?.text ?? "")),
    ).toMatchObject({
      acknowledged: true,
      action: "acknowledge",
      itemId: item.itemId,
      ok: true,
      version: item.version,
    });
    const acknowledgedListResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 34,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { action: "list", limit: 10 },
            name: MCP_AGENT_INBOX_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const acknowledgedListPayload = jsonRpcToolResultSchema.parse(
      await acknowledgedListResponse.json(),
    ).result;

    expect(
      agentInboxResultSchema.parse(JSON.parse(acknowledgedListPayload.content[0]?.text ?? "")),
    ).toMatchObject({
      action: "list",
      items: [],
      ok: true,
    });

    const replayResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 35,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: runInput,
            name: MCP_START_RUN_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const replayPayload = jsonRpcToolResultSchema.parse(await replayResponse.json()).result;
    const replay = startRunResultSchema.parse(JSON.parse(replayPayload.content[0]?.text ?? ""));

    expect(replayPayload.isError).toBe(false);
    expect(replay).toEqual({
      created: false,
      ok: true,
      run: inspected.ok ? inspected.run : undefined,
    });
  });

  it("returns a fixed insufficient-scope result for read-only Agent creation", async () => {
    const authority = await ownerAuthority("mcp-read-only-owner");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 12,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              executionLimits: {
                maxDurationSeconds: 120,
                maxModelTokens: 8_000,
                maxToolCalls: 0,
                maxTurns: 3,
              },
              idempotencyKey: "mcp-read-only-create",
              instructions: "This request must not create state.",
              name: "Denied Agent",
            },
            name: MCP_CREATE_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(response.status).toBe(200);
    expect(createAgentResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
  });

  it("does not widen legacy control read into full Agent-definition access", async () => {
    const authority = await ownerAuthority("mcp-legacy-control-read-owner", [OWNER_READ_SCOPE]);
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 13,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { id: "agent_00000000-0000-4000-8000-000000000000" },
            name: MCP_GET_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(result.isError).toBe(true);
    expect(getAgentResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
  });

  it("does not widen legacy control write into Agent revision access", async () => {
    const authority = await ownerAuthority("mcp-legacy-control-write-owner", [OWNER_WRITE_SCOPE]);
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 14,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              executionLimits: {
                maxDurationSeconds: 120,
                maxModelTokens: 8_000,
                maxToolCalls: 0,
                maxTurns: 3,
              },
              capabilities: [
                {
                  configuration: {
                    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
                  },
                  id: "inference.workers-ai",
                  schemaVersion: 1,
                },
              ],
              expectedRevision: 1,
              id: "agent_00000000-0000-4000-8000-000000000000",
              idempotencyKey: "mcp-legacy-update",
              instructions: "This request must not update state.",
              name: "Denied update",
            },
            name: MCP_UPDATE_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(result.isError).toBe(true);
    expect(updateAgentResultSchema.parse(JSON.parse(text ?? ""))).toEqual(
      fixedAgentFailure("insufficient_scope"),
    );
  });

  it("searches the complete Composio integration catalog with read scope", async () => {
    const authority = await ownerAuthority("mcp-catalog-owner", [INTEGRATIONS_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        items: [
          {
            auth_schemes: ["OAUTH2"],
            meta: {
              description: "Search and scrape the web.",
              tools_count: 18,
              version: "20260701_00",
            },
            name: "Firecrawl",
            no_auth: false,
            slug: "firecrawl",
          },
        ],
        next_cursor: null,
      }),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 13,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { limit: 20, query: "web research" },
            name: MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(result.isError).toBe(false);
    expect(integrationCatalogSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      integrations: [
        {
          authSchemes: ["oauth2"],
          description: "Search and scrape the web.",
          name: "Firecrawl",
          noAuth: false,
          slug: "firecrawl",
          toolsCount: 18,
          version: "20260701_00",
        },
      ],
      nextCursor: null,
      ok: true,
    });
  });

  it("lists enabled Composio auth configurations for connection configuration", async () => {
    const authority = await ownerAuthority("mcp-auth-config-owner", [
      CONNECTION_CONFIGS_READ_SCOPE,
      INTEGRATIONS_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        items: [
          {
            auth_scheme: "API_KEY",
            credentials: { api_key: "provider-secret" },
            id: "ac_posthog_project",
            is_composio_managed: false,
            name: "PostHog project",
            status: "ENABLED",
            toolkit: { slug: "posthog" },
          },
        ],
        next_cursor: null,
      }),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 14,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { integrationSlug: "posthog", limit: 20 },
            name: MCP_LIST_INTEGRATION_AUTH_CONFIGS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text ?? "";

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(integrationAuthConfigListResultSchema.parse(JSON.parse(text))).toEqual({
      authConfigs: [
        {
          authConfigId: "ac_posthog_project",
          authScheme: "api_key",
          managed: false,
          name: "PostHog project",
        },
      ],
      nextCursor: null,
      ok: true,
    });
    expect(text).not.toContain("provider-secret");
  });

  it("enables and exactly replays Composio-managed authentication through MCP", async () => {
    const authority = await ownerAuthority("mcp-enable-github-owner", [
      CONNECTION_CONFIGS_WRITE_SCOPE,
    ]);
    const authConfig = {
      auth_scheme: "OAUTH2",
      id: "ac_github_managed",
      is_composio_managed: true,
      status: "ENABLED",
      toolkit: { slug: "github" },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(
        Response.json(
          {
            auth_config: {
              auth_scheme: authConfig.auth_scheme,
              id: authConfig.id,
              is_composio_managed: authConfig.is_composio_managed,
            },
            toolkit: { slug: "github" },
          },
          { status: 201 },
        ),
      );
    const requestBody = JSON.stringify({
      id: 139,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          idempotencyKey: "mcp-enable-github",
          integrationSlug: "github",
        },
        name: MCP_ENABLE_INTEGRATION_TOOL_NAME,
      },
    });
    const firstResponse = await handleAuthenticatedMcpRequest(toolRequest(requestBody), env, {
      authority,
    });
    const firstPayload = jsonRpcToolResultSchema.parse(await firstResponse.json()).result;
    const first = enableIntegrationResultSchema.parse(
      JSON.parse(firstPayload.content[0]?.text ?? ""),
    );
    const replayResponse = await handleAuthenticatedMcpRequest(toolRequest(requestBody), env, {
      authority,
    });
    const replayPayload = jsonRpcToolResultSchema.parse(await replayResponse.json()).result;
    const replay = enableIntegrationResultSchema.parse(
      JSON.parse(replayPayload.content[0]?.text ?? ""),
    );

    expect(firstPayload.isError).toBe(false);
    expect(first).toEqual({
      authConfigId: "ac_github_managed",
      authScheme: "oauth2",
      created: true,
      integrationSlug: "github",
      managed: true,
      ok: true,
    });
    expect(replay).toEqual({ ...first, created: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const listEndpoint = fetchMock.mock.calls[0]?.[0];

    if (!(listEndpoint instanceof URL)) {
      throw new TypeError("Expected a Composio auth-config URL.");
    }

    expect(listEndpoint.href).toContain("/api/v3.1/auth_configs?is_composio_managed=true");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://backend.composio.dev/api/v3.1/auth_configs");
  });

  it("does not widen an existing all-scope token into integration enablement", async () => {
    const authority = await ownerAuthority("mcp-enable-github-denied-owner", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
      CONNECTION_CONFIGS_READ_SCOPE,
      INTEGRATIONS_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 140,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              idempotencyKey: "mcp-enable-github-denied",
              integrationSlug: "github",
            },
            name: MCP_ENABLE_INTEGRATION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload = jsonRpcToolResultSchema.parse(await response.json()).result;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.isError).toBe(true);
    expect(enableIntegrationResultSchema.parse(JSON.parse(payload.content[0]?.text ?? ""))).toEqual(
      {
        error: {
          code: "insufficient_scope",
          message: "Integration enablement request denied.",
        },
        ok: false,
      },
    );
    await expect(
      runInDurableObject(
        env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey),
        (_instance, state) =>
          state.storage.sql
            .exec("SELECT count(*) AS count FROM integration_enablement_requests")
            .one(),
      ),
    ).resolves.toEqual({ count: 0 });
  });

  it("does not widen an existing all-scope token into auth-config discovery", async () => {
    const authority = await ownerAuthority("mcp-auth-config-denied-owner", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
      INTEGRATIONS_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 15,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { integrationSlug: "posthog", limit: 20 },
            name: MCP_LIST_INTEGRATION_AUTH_CONFIGS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(
      integrationAuthConfigListResultSchema.parse(JSON.parse(result.content[0]?.text ?? "")),
    ).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("creates and exactly replays a private Composio Connect Link through MCP", async () => {
    const authority = await ownerAuthority("mcp-connection-link-owner", [CONNECTIONS_WRITE_SCOPE]);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          connected_account_id: "ca_mcp_connection",
          expires_at: expiresAt,
          experimental: {
            account_type: "PRIVATE",
          },
          link_token: "ln_mcp_connection",
          redirect_url: "https://connect.composio.dev/link/ln_mcp_connection",
        },
        { status: 201 },
      ),
    );
    const requestBody = JSON.stringify({
      id: 140,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          authConfigId: "ac_github_managed",
          idempotencyKey: "mcp-connection-link-key",
        },
        name: MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
      },
    });
    const firstResponse = await handleAuthenticatedMcpRequest(toolRequest(requestBody), env, {
      authority,
    });
    const firstPayload = jsonRpcToolResultSchema.parse(await firstResponse.json()).result;
    const first = createConnectionLinkResultSchema.parse(
      JSON.parse(firstPayload.content[0]?.text ?? ""),
    );
    const replayResponse = await handleAuthenticatedMcpRequest(toolRequest(requestBody), env, {
      authority,
    });
    const replayPayload = jsonRpcToolResultSchema.parse(await replayResponse.json()).result;
    const replay = createConnectionLinkResultSchema.parse(
      JSON.parse(replayPayload.content[0]?.text ?? ""),
    );

    expect(firstPayload.isError).toBe(false);
    expect(first).toMatchObject({
      connectionLink: {
        connectionId: expect.stringMatching(/^connection_/),
        expiresAt,
        url: "https://connect.composio.dev/link/ln_mcp_connection",
      },
      created: true,
      ok: true,
    });
    expect(replay).toEqual({
      ...(first.ok ? { connectionLink: first.connectionLink } : {}),
      created: false,
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];

    expect(endpoint).toBe("https://backend.composio.dev/api/v3.1/connected_accounts/link");
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a serialized Composio request body.");
    }

    expect(JSON.parse(init.body)).toEqual({
      auth_config_id: "ac_github_managed",
      callback_url: expect.stringMatching(
        /^https:\/\/crewhelm\.test\/connections\/composio\/callback\/owner_[A-Za-z0-9_-]{43}\/connection_link_[0-9a-f-]{36}\/[1-9][0-9]{12}\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/,
      ),
      experimental: {
        account_type: "PRIVATE",
      },
      user_id: authority.ownerKey,
    });
  });

  it("lists only local connection summaries with the dedicated read scope", async () => {
    const authority = await ownerAuthority("mcp-list-connections-owner", [CONNECTIONS_READ_SCOPE]);
    const insufficient = await ownerAuthority("mcp-list-connections-owner", [
      CONNECTIONS_WRITE_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await runInDurableObject(
      env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey),
      (_instance, state) => {
        state.storage.sql.exec(`
          INSERT INTO connections
            (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
          VALUES
            ('connection_00000000-0000-4000-8000-000000000003',
             'composio', 'ca_private_mcp', 'ac_linear_managed', 'initiated', 3)
        `);
      },
    );
    const requestBody = JSON.stringify({
      id: 145,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: MCP_LIST_CONNECTIONS_TOOL_NAME,
      },
    });
    const response = await handleAuthenticatedMcpRequest(toolRequest(requestBody), env, {
      authority,
    });
    const payload = jsonRpcToolResultSchema.parse(await response.json()).result;
    const text = payload.content[0]?.text ?? "";

    expect(payload.isError).toBe(false);
    expect(listConnectionsResultSchema.parse(JSON.parse(text))).toEqual({
      connections: [
        {
          accountLabel: null,
          authorizationOutcome: "untracked",
          authConfigId: "ac_linear_managed",
          connectionId: "connection_00000000-0000-4000-8000-000000000003",
          createdAt: "1970-01-01T00:00:00.003Z",
          integrationSlug: null,
          providerConnectionId: "ca_private_mcp",
          status: "initiated",
        },
      ],
      nextCursor: null,
      ok: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const deniedResponse = await handleAuthenticatedMcpRequest(toolRequest(requestBody), env, {
      authority: insufficient,
    });
    const deniedPayload = jsonRpcToolResultSchema.parse(await deniedResponse.json()).result;

    expect(deniedPayload.isError).toBe(true);
    expect(
      listConnectionsResultSchema.parse(JSON.parse(deniedPayload.content[0]?.text ?? "")),
    ).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Connection request denied.",
      },
      ok: false,
    });
    fetchMock.mockRestore();
  });

  it("does not widen catalog or control reads into connection-link mutation", async () => {
    const scopeSets: OwnerScope[][] = [[OWNER_READ_SCOPE], [INTEGRATIONS_READ_SCOPE]];

    for (const scopes of scopeSets) {
      const authority = await ownerAuthority(`mcp-connection-denied-${scopes[0]}`, scopes);
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const response = await handleAuthenticatedMcpRequest(
        toolRequest(
          JSON.stringify({
            id: 141,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              arguments: {
                authConfigId: "ac_github_managed",
                idempotencyKey: "mcp-denied-connection-link",
              },
              name: MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
            },
          }),
        ),
        env,
        { authority },
      );
      const payload = jsonRpcToolResultSchema.parse(await response.json()).result;

      expect(fetchMock).not.toHaveBeenCalled();
      expect(payload.isError).toBe(true);
      expect(
        createConnectionLinkResultSchema.parse(JSON.parse(payload.content[0]?.text ?? "")),
      ).toEqual({
        error: {
          code: "insufficient_scope",
          message: "Connection link request denied.",
        },
        ok: false,
      });
      fetchMock.mockRestore();
    }
  });

  it("does not reserve an intent when Composio connection linking is unconfigured", async () => {
    const authority = await ownerAuthority("mcp-unconfigured-connection-owner", [
      CONNECTIONS_WRITE_SCOPE,
    ]);
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 142,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              authConfigId: "ac_github_managed",
              idempotencyKey: "mcp-unconfigured-link",
            },
            name: MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
          },
        }),
      ),
      {
        BETTER_AUTH_SECRET: signingSecret,
        OWNER_CONTROL_PLANE: env.OWNER_CONTROL_PLANE,
        PUBLIC_ORIGIN: origin,
      },
      { authority },
    );
    const payload = jsonRpcToolResultSchema.parse(await response.json()).result;

    expect(payload.isError).toBe(true);
    expect(
      createConnectionLinkResultSchema.parse(JSON.parse(payload.content[0]?.text ?? "")),
    ).toEqual({
      error: {
        code: "connection_link_unavailable",
        message: "Connection link request denied.",
      },
      ok: false,
    });
    await expect(
      runInDurableObject(
        env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey),
        (_instance, state) =>
          state.storage.sql.exec("SELECT COUNT(*) AS count FROM connection_link_requests").one(),
      ),
    ).resolves.toEqual({ count: 0 });
  });

  it("pins an unknown provider outcome without redispatching the same intent", async () => {
    const authority = await ownerAuthority("mcp-unknown-connection-owner", [
      CONNECTIONS_WRITE_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret timeout"));
    const requestBody = JSON.stringify({
      id: 143,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          authConfigId: "ac_github_managed",
          idempotencyKey: "mcp-unknown-link",
        },
        name: MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
      },
    });

    for (const requestId of [143, 144]) {
      const response = await handleAuthenticatedMcpRequest(
        toolRequest(requestBody.replace(`"id":143`, `"id":${requestId}`)),
        env,
        { authority },
      );
      const payload = jsonRpcToolResultSchema.parse(await response.json()).result;
      const result = createConnectionLinkResultSchema.parse(
        JSON.parse(payload.content[0]?.text ?? ""),
      );

      expect(payload.isError).toBe(true);
      expect(result).toEqual({
        error: {
          code: "connection_link_outcome_unknown",
          message: "Connection link request denied.",
          operation: {
            nextAction: "retry_same_request",
            recoverAfter: expect.any(String),
            reservationId: expect.stringMatching(/^connection_link_/),
          },
        },
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    }

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports an unknown outcome when durable finalization fails after provider success", async () => {
    const authority = await ownerAuthority("mcp-finalization-failure-owner", [
      CONNECTIONS_WRITE_SCOPE,
    ]);
    const finalizationFailureEnv = {
      BETTER_AUTH_SECRET: signingSecret,
      COMPOSIO_API_KEY: "test-composio-api-key",
      OWNER_CONTROL_PLANE: {
        getByName: () => ({
          agentInbox: unavailableControlPlane,
          batchDisableAgents: unavailableControlPlane,
          cancelRun: unavailableControlPlane,
          changeAuthority: unavailableControlPlane,
          completeConnectionLink: unavailableControlPlane,
          completeIntegrationEnablement: unavailableControlPlane,
          configureAgentConnection: unavailableControlPlane,
          configureAgentSchedule: unavailableControlPlane,
          configureFleetConfiguration: unavailableControlPlane,
          createAgent: unavailableControlPlane,
          getAgent: unavailableControlPlane,
          getAgentRevision: unavailableControlPlane,
          getAgentSchedule: unavailableControlPlane,
          getFleetConfiguration: unavailableControlPlane,
          inspectRun: unavailableControlPlane,
          decideRunToolApproval: unavailableControlPlane,
          listAgentRevisions: unavailableControlPlane,
          listAgentRuns: unavailableControlPlane,
          listAgents: unavailableControlPlane,
          listConnections: unavailableControlPlane,
          listUnresolvedToolEffects: unavailableControlPlane,
          listRunToolApprovals: unavailableControlPlane,
          lookupAgentConnectionConfiguration: unavailableControlPlane,
          reserveConnectionLink: async () => ({
            authorizationExpiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
            authorizationToken: "a".repeat(43),
            ok: true,
            recoverAfter: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
            reservationId: "connection_link_00000000-0000-4000-8000-000000000000",
            state: "dispatch",
          }),
          reserveIntegrationEnablement: unavailableControlPlane,
          reconcileToolExecution: unavailableControlPlane,
          resolveConnectionForAttachment: unavailableControlPlane,
          status: unavailableControlPlane,
          startRun: unavailableControlPlane,
          updateAgent: unavailableControlPlane,
        }),
      },
      PUBLIC_ORIGIN: origin,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          connected_account_id: "ca_unfinalized",
          expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
          experimental: {
            account_type: "PRIVATE",
          },
          link_token: "ln_unfinalized",
          redirect_url: "https://connect.composio.dev/link/ln_unfinalized",
        },
        { status: 201 },
      ),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 145,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              authConfigId: "ac_github_managed",
              idempotencyKey: "mcp-finalization-failure",
            },
            name: MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
          },
        }),
      ),
      finalizationFailureEnv,
      { authority },
    );
    const payload = jsonRpcToolResultSchema.parse(await response.json()).result;
    const result = createConnectionLinkResultSchema.parse(
      JSON.parse(payload.content[0]?.text ?? ""),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(payload.isError).toBe(true);
    expect(result).toEqual({
      error: {
        code: "connection_link_outcome_unknown",
        message: "Connection link request denied.",
        operation: {
          nextAction: "retry_same_request",
          recoverAfter: expect.any(String),
          reservationId: "connection_link_00000000-0000-4000-8000-000000000000",
        },
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not redispatch after completion audit persistence fails", async () => {
    const authority = await ownerAuthority("mcp-completion-audit-failure-owner", [
      CONNECTIONS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_mcp_connection_completion_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'connection.link_created'
        BEGIN
          SELECT RAISE(ABORT, 'forced MCP completion audit failure');
        END
      `);
    });
    const auditFailureEnv = {
      BETTER_AUTH_SECRET: signingSecret,
      COMPOSIO_API_KEY: "test-composio-api-key",
      OWNER_CONTROL_PLANE: {
        getByName: () => ({
          agentInbox: unavailableControlPlane,
          batchDisableAgents: unavailableControlPlane,
          cancelRun: unavailableControlPlane,
          changeAuthority: unavailableControlPlane,
          completeConnectionLink: (authorityInput: unknown, input: unknown) =>
            runInDurableObject(stub, (instance) =>
              instance.completeConnectionLink(authorityInput, input),
            ),
          completeIntegrationEnablement: unavailableControlPlane,
          configureAgentConnection: unavailableControlPlane,
          configureAgentSchedule: unavailableControlPlane,
          configureFleetConfiguration: unavailableControlPlane,
          createAgent: unavailableControlPlane,
          getAgent: unavailableControlPlane,
          getAgentRevision: unavailableControlPlane,
          getAgentSchedule: unavailableControlPlane,
          getFleetConfiguration: unavailableControlPlane,
          inspectRun: unavailableControlPlane,
          decideRunToolApproval: unavailableControlPlane,
          listAgentRevisions: unavailableControlPlane,
          listAgentRuns: unavailableControlPlane,
          listAgents: unavailableControlPlane,
          listConnections: unavailableControlPlane,
          listUnresolvedToolEffects: unavailableControlPlane,
          listRunToolApprovals: unavailableControlPlane,
          lookupAgentConnectionConfiguration: unavailableControlPlane,
          reserveConnectionLink: (authorityInput: unknown, input: unknown) =>
            runInDurableObject(stub, (instance) =>
              instance.reserveConnectionLink(authorityInput, input),
            ),
          reserveIntegrationEnablement: unavailableControlPlane,
          reconcileToolExecution: unavailableControlPlane,
          resolveConnectionForAttachment: unavailableControlPlane,
          status: unavailableControlPlane,
          startRun: unavailableControlPlane,
          updateAgent: unavailableControlPlane,
        }),
      },
      PUBLIC_ORIGIN: origin,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          connected_account_id: "ca_mcp_audit_failure",
          expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
          experimental: {
            account_type: "PRIVATE",
          },
          link_token: "ln_mcp_audit_failure",
          redirect_url: "https://connect.composio.dev/link/ln_mcp_audit_failure",
        },
        { status: 201 },
      ),
    );
    const requestBody = JSON.stringify({
      id: 146,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          authConfigId: "ac_github_managed",
          idempotencyKey: "mcp-completion-audit-failure",
        },
        name: MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
      },
    });

    for (const requestId of [146, 147]) {
      const response = await handleAuthenticatedMcpRequest(
        toolRequest(requestBody.replace(`"id":146`, `"id":${requestId}`)),
        auditFailureEnv,
        { authority },
      );
      const payload = jsonRpcToolResultSchema.parse(await response.json()).result;

      expect(payload.isError).toBe(true);
      expect(
        createConnectionLinkResultSchema.parse(JSON.parse(payload.content[0]?.text ?? "")),
      ).toEqual({
        error: {
          code: "connection_link_outcome_unknown",
          message: "Connection link request denied.",
          operation: {
            nextAction: "retry_same_request",
            recoverAfter: expect.any(String),
            reservationId: expect.stringMatching(/^connection_link_/),
          },
        },
        ok: false,
      });
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        audit: state.storage.sql
          .exec("SELECT action FROM audit_events ORDER BY event_id")
          .toArray(),
        connections: state.storage.sql.exec("SELECT COUNT(*) AS count FROM connections").one(),
        request: state.storage.sql
          .exec(
            `SELECT status, connection_id, redirect_url, expires_at, completed_at
             FROM connection_link_requests
             WHERE idempotency_key = 'mcp-completion-audit-failure'`,
          )
          .one(),
      })),
    ).resolves.toEqual({
      audit: [{ action: "connection.link_reserved" }],
      connections: { count: 0 },
      request: {
        completed_at: null,
        connection_id: null,
        expires_at: null,
        redirect_url: null,
        status: "pending",
      },
    });
  });

  it("does not widen control read into integration catalog egress", async () => {
    const authority = await ownerAuthority("mcp-control-read-catalog-owner", [OWNER_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 14,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(integrationCatalogSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("discovers exact Composio tools with integration read scope", async () => {
    const authority = await ownerAuthority("mcp-tool-catalog-owner", [INTEGRATIONS_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        items: [
          {
            description: "Crawl a URL.",
            is_deprecated: false,
            name: "Scrape",
            no_auth: false,
            scopes: [],
            slug: "FIRECRAWL_SCRAPE",
            tags: ["web"],
            toolkit: {
              name: "Firecrawl",
              slug: "firecrawl",
            },
            version: "20260701_00",
          },
        ],
        next_cursor: null,
      }),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 15,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              integrationSlug: "firecrawl",
              query: "crawl web",
            },
            name: MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(integrationToolSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      nextCursor: null,
      ok: true,
      tools: [
        {
          description: "Crawl a URL.",
          integration: {
            name: "Firecrawl",
            slug: "firecrawl",
          },
          name: "Scrape",
          noAuth: false,
          requiredScopes: [],
          slug: "FIRECRAWL_SCRAPE",
          tags: ["web"],
          version: "20260701_00",
        },
      ],
    });
  });

  it("does not widen control read into integration tool egress", async () => {
    const authority = await ownerAuthority("mcp-control-read-tool-catalog-owner", [
      OWNER_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 16,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { integrationSlug: "github" },
            name: MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(integrationToolSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("inspects one exact Composio tool schema with integration read scope", async () => {
    const authority = await ownerAuthority("mcp-tool-inspection-owner", [INTEGRATIONS_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        input_parameters: {
          url: { type: "string" },
        },
        is_deprecated: false,
        name: "Scrape",
        no_auth: false,
        output_parameters: {
          markdown: { type: "string" },
        },
        scopes: [],
        slug: "FIRECRAWL_SCRAPE",
        tags: ["web"],
        toolkit: {
          name: "Firecrawl",
          slug: "firecrawl",
        },
        version: "20260701_00",
      }),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 17,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              slug: "FIRECRAWL_SCRAPE",
              version: "20260701_00",
            },
            name: MCP_INSPECT_INTEGRATION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(inspectIntegrationToolResultSchema.parse(JSON.parse(text ?? ""))).toMatchObject({
      ok: true,
      tool: {
        inputParameters: {
          url: { type: "string" },
        },
        outputParameters: {
          markdown: { type: "string" },
        },
        slug: "FIRECRAWL_SCRAPE",
        version: "20260701_00",
      },
    });
  });

  it("configures an Agent from one active Composio connection and exact dynamic schemas", async () => {
    const authority = await ownerAuthority("mcp-configure-connection-owner", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      CONNECTIONS_READ_SCOPE,
      INTEGRATIONS_READ_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      executionLimits: {
        maxDurationSeconds: 300,
        maxModelTokens: 20_000,
        maxToolCalls: 4,
        maxTurns: 4,
      },
      idempotencyKey: "mcp-configure-agent",
      instructions: "Read project items with the attached connection.",
      name: "Project reader",
    });

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const connectionId = "connection_91999999-9999-4999-8999-999999999999";

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO connections
           (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
         VALUES (?, 'composio', 'ca_project_919', 'ac_project_919', 'initiated', ?)`,
        connectionId,
        Date.now(),
      );
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          id: "ca_project_919",
          state: { val: { access_token: "provider-secret" } },
          status: "ACTIVE",
          toolkit: { slug: "project_toolkit" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          description: "Read one exact project item.",
          input_parameters: {
            itemId: { required: true, type: "string" },
          },
          is_deprecated: false,
          name: "Read item",
          no_auth: false,
          output_parameters: { itemId: { type: "string" } },
          scopes: ["items:read"],
          slug: "PROJECT_TOOLKIT_READ_ITEM",
          tags: ["readOnlyHint"],
          toolkit: {
            name: "Project toolkit",
            slug: "project_toolkit",
          },
          version: "20260727_00",
        }),
      );
    const configurationArguments = {
      agentId: created.agent.id,
      connectionId,
      expectedRevision: 1,
      expiresAt: null,
      idempotencyKey: "mcp-configure-connection",
      limits: {
        maxCallsPerRun: 4,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 5_000,
        maxDurationMs: 20_000,
        maxOutputBytes: 64_000,
      },
      tools: [
        {
          authorization: "approval_required",
          slug: "PROJECT_TOOLKIT_READ_ITEM",
          version: "20260727_00",
        },
      ],
    };
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 20,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: configurationArguments,
            name: MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;
    const configured = configureAgentConnectionResultSchema.parse(JSON.parse(text ?? ""));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(false);
    expect(configured).toMatchObject({
      agent: { id: created.agent.id, revision: 2 },
      configured: true,
      ok: true,
    });
    expect(text).not.toContain("ca_project_919");
    expect(text).not.toContain("provider-secret");

    const standingResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 21,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              ...configurationArguments,
              expectedRevision: 2,
              idempotencyKey: "mcp-configure-standing-without-autonomy",
              tools: configurationArguments.tools.map((tool) => ({
                ...tool,
                authorization: "standing",
              })),
            },
            name: MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const standingPayload: unknown = await standingResponse.json();
    const standingResult = jsonRpcToolResultSchema.parse(standingPayload).result;
    const standingText = standingResult.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(standingResult.isError).toBe(true);
    expect(
      configureAgentConnectionResultSchema.parse(JSON.parse(standingText ?? "")),
    ).toMatchObject({
      error: { code: "insufficient_scope" },
      ok: false,
    });

    fetchMock.mockRejectedValue(new Error("Composio is unavailable."));
    const replayResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 22,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: configurationArguments,
            name: MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const replayPayload: unknown = await replayResponse.json();
    const replayResult = jsonRpcToolResultSchema.parse(replayPayload).result;
    const replayText = replayResult.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(replayResult.isError).toBe(false);
    expect(configureAgentConnectionResultSchema.parse(JSON.parse(replayText ?? ""))).toMatchObject({
      agent: { id: created.agent.id, revision: 2 },
      configured: false,
      ok: true,
    });

    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          id: "ca_project_919",
          status: "ACTIVE",
          toolkit: { slug: "project_toolkit" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          description: "Retrieve one stored credential.",
          input_parameters: { name: { required: true, type: "string" } },
          is_deprecated: false,
          name: "Read secret",
          no_auth: false,
          output_parameters: { value: { type: "string" } },
          scopes: ["secrets:read"],
          slug: "PROJECT_TOOLKIT_GET_SECRET",
          tags: ["readOnlyHint"],
          toolkit: {
            name: "Project toolkit",
            slug: "project_toolkit",
          },
          version: "20260727_00",
        }),
      );
    const credentialToolResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 22,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              ...configurationArguments,
              expectedRevision: 2,
              idempotencyKey: "mcp-configure-credential-tool",
              tools: [
                {
                  authorization: "approval_required",
                  slug: "PROJECT_TOOLKIT_GET_SECRET",
                  version: "20260727_00",
                },
              ],
            },
            name: MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const credentialToolPayload: unknown = await credentialToolResponse.json();
    const credentialToolResult = jsonRpcToolResultSchema.parse(credentialToolPayload).result;
    const credentialToolText = credentialToolResult.content[0]?.text;
    const deniedCredentialTool = configureAgentConnectionResultSchema.parse(
      JSON.parse(credentialToolText ?? ""),
    );
    const unchangedAgent = await controlPlane.getAgent(authority, { id: created.agent.id });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentialToolResult.isError).toBe(true);
    expect(deniedCredentialTool).toEqual({
      error: {
        code: "invalid_request",
        message: "Connection attachment request denied.",
      },
      ok: false,
    });
    expect(unchangedAgent).toMatchObject({
      agent: {
        capabilityGrants: configured.ok ? configured.agent.capabilityGrants : [],
        revision: 2,
      },
      ok: true,
    });
  });

  it("does not widen control read into exact tool inspection egress", async () => {
    const authority = await ownerAuthority("mcp-control-read-tool-inspection-owner", [
      OWNER_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 18,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              slug: "GITHUB_CREATE_ISSUE",
              version: "20260720_00",
            },
            name: MCP_INSPECT_INTEGRATION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(inspectIntegrationToolResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("rejects a too-short integration search before provider egress", async () => {
    const authority = await ownerAuthority("mcp-short-catalog-query-owner", [
      INTEGRATIONS_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 19,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { query: "ab" },
            name: MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});
