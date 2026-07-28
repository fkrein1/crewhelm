import {
  AGENTS_WRITE_SCOPE,
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  ownerAuthoritySchema,
  type ComposioToolCapabilityGrant,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { deriveOwnerKey } from "../identity.js";
import { digestRunPrompt } from "../../agent/admitted-runs/protocol.js";

const connectionId = "connection_22222222-2222-4222-8222-222222222222";
const grantId = "grant_33333333-3333-4333-8333-333333333333";
const targetDigest = "b".repeat(64);

async function authorityFor(subject: string): Promise<OwnerAuthority> {
  return ownerAuthoritySchema.parse({
    clientId: "https://client.example/mcp.json",
    ownerKey: await deriveOwnerKey({ issuer: "https://github.com", subject }),
    scopes: [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE],
  });
}

describe("admitted tool execution", () => {
  it("reserves, completes, and exhausts an exact read grant", async () => {
    const authority = await authorityFor("tool-execution-701");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      executionLimits: {
        maxDurationSeconds: 45,
        maxModelTokens: 2_000,
        maxToolCalls: 1,
        maxTurns: 2,
      },
      idempotencyKey: "tool-agent-701",
      instructions: "Use only explicitly admitted tools.",
      model: "@cf/meta/llama-4-scout-17b-16e-instruct",
      name: "Tool execution fixture",
    });

    if (!created.ok) {
      throw new Error("Expected tool execution fixture Agent.");
    }

    const grant: ComposioToolCapabilityGrant = {
      agentId: created.agent.id,
      agentRevision: created.agent.revision,
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      effect: "read",
      expiresAt: null,
      grantId,
      integrationSlug: "project_toolkit",
      limits: {
        maxCallsPerRun: 1,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 5_000,
        maxDurationMs: 20_000,
        maxOutputBytes: 64_000,
      },
      ownerKey: authority.ownerKey,
      targetDigests: [targetDigest],
      tool: {
        description: "Read one item.",
        inputParametersJson: '{"itemId":{"required":true,"type":"string"}}',
        name: "Read item",
        outputParametersJson: '{"itemId":{"type":"string"}}',
        tags: ["readOnlyHint"],
      },
      toolkitVersion: "20260727_00",
      toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
    };

    await runInDurableObject(controlPlane, (_instance, state) => {
      const currentTime = Date.now();
      state.storage.sql.exec(
        `INSERT INTO connections
           (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
         VALUES (?, 'composio', ?, ?, 'active', ?)`,
        connectionId,
        "ca_tool_execution_701",
        "ac_tool_execution_701",
        currentTime,
      );
      state.storage.sql.exec(
        `INSERT INTO capability_grants
           (grant_id, agent_id, agent_revision, connection_id, grant, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        grantId,
        created.agent.id,
        created.agent.revision,
        connectionId,
        JSON.stringify(grant),
        currentTime,
      );
      state.storage.sql.exec(
        `UPDATE agent_revisions
         SET capability_grants = ?
         WHERE agent_id = ? AND revision = ?`,
        JSON.stringify([grantId]),
        created.agent.id,
        created.agent.revision,
      );
    });

    const prompt = "Read the exact granted item.";
    const admission = await controlPlane.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "tool-run-701",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected tool execution run admission.");
    }

    expect(admission.permit.budgetReservation).toMatchObject({
      maxToolCalls: 1,
      toolGrants: [grant],
    });
    await expect(controlPlane.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });

    const reference = {
      agentId: admission.permit.agentId,
      agentRevision: admission.permit.agentRevision,
      budgetReservation: admission.permit.budgetReservation,
      clientId: admission.permit.clientId,
      idempotencyKey: admission.permit.idempotencyKey,
      ownerKey: admission.permit.ownerKey,
      promptDigest: admission.permit.promptDigest,
      runId: admission.permit.runId,
    };
    const action = {
      agentId: created.agent.id,
      agentRevision: created.agent.revision,
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      effect: "read" as const,
      estimatedCostMicrousd: 2_000,
      grantId,
      inputDigest: "a".repeat(64),
      integrationSlug: grant.integrationSlug,
      ownerKey: authority.ownerKey,
      runId: admission.permit.runId,
      targetDigests: [targetDigest],
      toolCallId: "tool_call_55555555-5555-4555-8555-555555555555",
      toolkitVersion: grant.toolkitVersion,
      toolSlug: grant.toolSlug,
    };

    await expect(
      controlPlane.evaluateToolExecution({ ...reference, action }),
    ).resolves.toMatchObject({
      decision: { decision: "allow" },
      ok: true,
    });
    const reserved = await controlPlane.reserveToolExecution({ ...reference, action });

    expect(reserved).toMatchObject({ ok: true, state: "allowed" });

    if (!reserved.ok || reserved.state !== "allowed") {
      throw new Error("Expected exact tool execution permit.");
    }

    const extendedPermit = {
      ...reserved.permit,
      constraints: {
        ...reserved.permit.constraints,
        decisionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };

    await expect(controlPlane.resolveToolExecutionConnection(extendedPermit)).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await expect(controlPlane.resolveToolExecutionConnection(reserved.permit)).resolves.toEqual({
      ok: true,
      providerConnectionId: "ca_tool_execution_701",
    });
    await expect(controlPlane.resolveToolExecutionConnection(reserved.permit)).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });

    const retried = await controlPlane.reserveToolExecution({ ...reference, action });

    expect(retried).toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await expect(
      controlPlane.completeToolExecution({
        outcome: { outputBytes: 32, status: "completed" },
        permit: {
          ...reserved.permit,
          constraints: {
            ...reserved.permit.constraints,
            maxOutputBytes: reserved.permit.constraints.maxOutputBytes + 1,
          },
        },
      }),
    ).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await expect(
      controlPlane.completeToolExecution({
        outcome: { outputBytes: 32, status: "completed" },
        permit: reserved.permit,
      }),
    ).resolves.toEqual({ completed: true, ok: true });
    await expect(controlPlane.resolveToolExecutionConnection(reserved.permit)).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await expect(controlPlane.reserveToolExecution({ ...reference, action })).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await expect(
      controlPlane.reserveToolExecution({
        ...reference,
        action: {
          ...action,
          toolCallId: "tool_call_66666666-6666-4666-8666-666666666666",
        },
      }),
    ).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await runInDurableObject(controlPlane, async (instance, state) => {
      const consumed = [
        ...state.storage.sql.exec<{ tool_calls_consumed: number }>(
          "SELECT tool_calls_consumed FROM run_admissions WHERE run_id = ?",
          admission.permit.runId,
        ),
      ];
      const auditActions = [
        ...state.storage.sql.exec<{ action: string }>(
          "SELECT action FROM audit_events WHERE subject_id = ? ORDER BY event_id",
          action.toolCallId,
        ),
      ].map((row) => row.action);

      expect(consumed).toEqual([{ tool_calls_consumed: 1 }]);
      expect(auditActions).toEqual(["tool.execution_reserved", "tool.execution_completed"]);

      const currentTime = Date.now();
      state.storage.sql.exec(
        `UPDATE run_admissions
         SET expires_at = ?, cleanup_at = ?
         WHERE run_id = ?`,
        currentTime - 2,
        currentTime - 1,
        admission.permit.runId,
      );
      await instance.alarm();

      expect([
        ...state.storage.sql.exec(
          "SELECT run_id FROM run_admissions WHERE run_id = ?",
          admission.permit.runId,
        ),
      ]).toEqual([]);
      expect([
        ...state.storage.sql.exec(
          "SELECT tool_call_id FROM tool_executions WHERE run_id = ?",
          admission.permit.runId,
        ),
      ]).toEqual([]);
    });
  });
});
