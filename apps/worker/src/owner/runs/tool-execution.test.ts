import {
  AGENTS_WRITE_SCOPE,
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  CONNECTIONS_WRITE_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUN_ADMISSION_RETENTION_MS,
  classifiedComposioToolActionSchema,
  ownerAuthoritySchema,
  type ComposioToolCapabilityGrant,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { deriveOwnerKey } from "../identity.js";
import { digestRunPrompt } from "../../agent/admitted-runs/protocol.js";
import { digestExternalEffect } from "./tool-execution.js";

const connectionId = "connection_22222222-2222-4222-8222-222222222222";
const grantId = "grant_33333333-3333-4333-8333-333333333333";
const targetDigest = "b".repeat(64);

async function authorityFor(subject: string): Promise<OwnerAuthority> {
  return ownerAuthoritySchema.parse({
    clientId: "https://client.example/mcp.json",
    ownerKey: await deriveOwnerKey({ issuer: "https://github.com", subject }),
    scopes: [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE, CONNECTIONS_WRITE_SCOPE],
  });
}

async function toolExecutionFixture(subject: string, effect: "read" | "write") {
  const authority = await authorityFor(subject);
  const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
  const created = await controlPlane.createAgent(authority, {
    executionLimits: {
      maxDurationSeconds: 45,
      maxModelTokens: 2_000,
      maxToolCalls: 4,
      maxTurns: 4,
    },
    idempotencyKey: `${subject}-agent`,
    instructions: "Use only explicitly admitted recovery tools.",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name: "Recovery tool execution fixture",
  });

  if (!created.ok) {
    throw new Error("Expected recovery tool execution Agent.");
  }

  const fixtureConnectionId = `connection_${crypto.randomUUID()}`;
  const fixtureGrantId = `grant_${crypto.randomUUID()}`;
  const fixtureTargetDigest = "d".repeat(64);
  const grant: ComposioToolCapabilityGrant = {
    agentId: created.agent.id,
    agentRevision: created.agent.revision,
    capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
    connectionId: fixtureConnectionId,
    effect,
    expiresAt: null,
    grantId: fixtureGrantId,
    integrationSlug: "recovery_toolkit",
    limits: {
      maxCallsPerRun: 4,
      maxConcurrency: 1,
      maxCostMicrousdPerCall: 5_000,
      maxDurationMs: 20_000,
      maxOutputBytes: 64_000,
    },
    ownerKey: authority.ownerKey,
    targetDigests: [fixtureTargetDigest],
    tool: {
      description: effect === "read" ? "Read one recovery item." : "Update one recovery item.",
      inputParametersJson: '{"itemId":{"required":true,"type":"string"}}',
      name: effect === "read" ? "Read recovery item" : "Update recovery item",
      outputParametersJson: '{"itemId":{"type":"string"}}',
      tags: [effect === "read" ? "readOnlyHint" : "write"],
    },
    toolkitVersion: "20260728_00",
    toolSlug: effect === "read" ? "RECOVERY_READ_ITEM" : "RECOVERY_UPDATE_ITEM",
  };

  await runInDurableObject(controlPlane, (_instance, state) => {
    const currentTime = Date.now();
    state.storage.sql.exec(
      `INSERT INTO connections
         (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
       VALUES (?, 'composio', ?, ?, 'active', ?)`,
      fixtureConnectionId,
      `ca_${subject}`,
      `ac_${subject}`,
      currentTime,
    );
    state.storage.sql.exec(
      `INSERT INTO capability_grants
         (grant_id, agent_id, agent_revision, connection_id, grant, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      fixtureGrantId,
      created.agent.id,
      created.agent.revision,
      fixtureConnectionId,
      JSON.stringify(grant),
      currentTime,
    );
    state.storage.sql.exec(
      `UPDATE agent_revisions
       SET capability_grants = ?
       WHERE agent_id = ? AND revision = ?`,
      JSON.stringify([fixtureGrantId]),
      created.agent.id,
      created.agent.revision,
    );
  });

  const prompt = "Execute the exact recovery action.";
  const admission = await controlPlane.createRunAdmission(authority, {
    agentId: created.agent.id,
    expectedRevision: created.agent.revision,
    idempotencyKey: `${subject}-run`,
    promptCharacters: prompt.length,
    promptDigest: await digestRunPrompt(prompt),
  });

  if (!admission.ok || admission.state !== "issued") {
    throw new Error("Expected recovery tool execution admission.");
  }

  await expect(controlPlane.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
    confirmed: true,
    ok: true,
  });

  return {
    action: {
      agentId: created.agent.id,
      agentRevision: created.agent.revision,
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId: fixtureConnectionId,
      effect,
      estimatedCostMicrousd: 2_000,
      grantId: fixtureGrantId,
      inputDigest: "e".repeat(64),
      integrationSlug: grant.integrationSlug,
      ownerKey: authority.ownerKey,
      runId: admission.permit.runId,
      targetDigests: [fixtureTargetDigest],
      toolCallId: `tool_call_${crypto.randomUUID()}`,
      toolkitVersion: grant.toolkitVersion,
      toolSlug: grant.toolSlug,
    },
    agentId: created.agent.id,
    authority,
    connectionId: fixtureConnectionId,
    controlPlane,
    grantId: fixtureGrantId,
    reference: {
      agentId: admission.permit.agentId,
      agentRevision: admission.permit.agentRevision,
      budgetReservation: admission.permit.budgetReservation,
      clientId: admission.permit.clientId,
      idempotencyKey: admission.permit.idempotencyKey,
      ownerKey: admission.permit.ownerKey,
      promptDigest: admission.permit.promptDigest,
      runId: admission.permit.runId,
    },
  };
}

async function approveFixtureAction(
  fixture: Awaited<ReturnType<typeof toolExecutionFixture>>,
  action: Awaited<ReturnType<typeof toolExecutionFixture>>["action"],
) {
  const evaluated = await fixture.controlPlane.evaluateToolExecution({
    ...fixture.reference,
    action,
  });

  if (!evaluated.ok) {
    throw new Error("Expected a write action requiring approval.");
  }
  const decision = evaluated.decision;
  if (decision.decision !== "requires_approval") {
    throw new Error("Expected a write action requiring approval.");
  }

  await runInDurableObject(fixture.controlPlane, (_instance, state) => {
    const currentTime = Date.now();
    state.storage.sql.exec(
      `INSERT INTO tool_approvals
         (execution_id, run_id, tool_call_id, grant_id, action_digest, client_id, decision,
          expires_at, requested_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
      `approval:${action.toolCallId}`,
      fixture.reference.runId,
      action.toolCallId,
      fixture.grantId,
      decision.actionDigest,
      fixture.authority.clientId,
      currentTime + 60_000,
      currentTime,
      currentTime,
    );
  });
}

describe("admitted tool execution", () => {
  it("identifies an external effect independently of run and grant policy", async () => {
    const fixture = await toolExecutionFixture("effect-identity", "write");
    const action = classifiedComposioToolActionSchema.parse(fixture.action);
    const original = await digestExternalEffect(action);

    await expect(
      digestExternalEffect({
        ...action,
        effect: "destructive",
        grantId: `grant_${crypto.randomUUID()}`,
        runId: `run_${crypto.randomUUID()}`,
        targetDigests: ["f".repeat(64)],
        toolCallId: `tool_call_${crypto.randomUUID()}`,
      }),
    ).resolves.toBe(original);
    await expect(
      digestExternalEffect({ ...action, inputDigest: "f".repeat(64) }),
    ).resolves.not.toBe(original);
  });

  it("reserves, completes, and exhausts an exact read grant", async () => {
    const authority = await authorityFor("tool-execution-701");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      executionLimits: {
        maxDurationSeconds: 45,
        maxModelTokens: 2_000,
        maxToolCalls: 3,
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
        maxCallsPerRun: 3,
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
      maxToolCalls: 3,
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
    const abandonedAction = {
      ...action,
      toolCallId: "tool_call_77777777-7777-4777-8777-777777777777",
    };
    const abandoned = await controlPlane.reserveToolExecution({
      ...reference,
      action: abandonedAction,
    });

    expect(abandoned).toMatchObject({ ok: true, state: "allowed" });

    if (!abandoned.ok || abandoned.state !== "allowed") {
      throw new Error("Expected abandoned tool execution permit.");
    }

    await expect(controlPlane.resolveToolExecutionConnection(abandoned.permit)).resolves.toEqual({
      ok: true,
      providerConnectionId: "ca_tool_execution_701",
    });
    await runInDurableObject(controlPlane, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE tool_executions SET expires_at = ? WHERE tool_call_id = ?",
        Date.now() - 1,
        abandonedAction.toolCallId,
      );
      await instance.alarm();

      expect(
        state.storage.sql
          .exec<{
            completed_at: number;
            output_bytes: number;
            status: string;
          }>(
            `SELECT status, output_bytes, completed_at
             FROM tool_executions
             WHERE tool_call_id = ?`,
            abandonedAction.toolCallId,
          )
          .one(),
      ).toEqual({
        completed_at: expect.any(Number),
        output_bytes: 0,
        status: "unknown",
      });
      expect(
        [
          ...state.storage.sql.exec<{ action: string }>(
            "SELECT action FROM audit_events WHERE subject_id = ? ORDER BY event_id",
            abandonedAction.toolCallId,
          ),
        ].map((row) => row.action),
      ).toEqual(["tool.execution_reserved", "tool.execution_dispatched", "tool.execution_unknown"]);
    });
    await expect(
      controlPlane.reconcileToolExecution(authority, {
        resolution: "not_applied",
        toolCallId: abandonedAction.toolCallId,
      }),
    ).resolves.toMatchObject({ ok: true, reconciled: true });
    const cancellationAction = {
      ...action,
      toolCallId: "tool_call_66666666-6666-4666-8666-666666666666",
    };
    const cancellationReserved = await controlPlane.reserveToolExecution({
      ...reference,
      action: cancellationAction,
    });

    expect(cancellationReserved).toMatchObject({ ok: true, state: "allowed" });

    if (!cancellationReserved.ok || cancellationReserved.state !== "allowed") {
      throw new Error("Expected a pre-dispatch tool execution reservation.");
    }

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE run_admissions
         SET cancellation_requested_at = ?
         WHERE run_id = ?`,
        Date.now(),
        admission.permit.runId,
      );
    });

    await expect(
      controlPlane.resolveToolExecutionConnection(cancellationReserved.permit),
    ).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await expect(
      controlPlane.completeToolExecution({
        outcome: { outputBytes: 0, status: "failed" },
        permit: cancellationReserved.permit,
      }),
    ).resolves.toEqual({ completed: true, ok: true });
    await expect(
      controlPlane.reserveToolExecution({
        ...reference,
        action: {
          ...action,
          toolCallId: "tool_call_88888888-8888-4888-8888-888888888888",
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

      expect(consumed).toEqual([{ tool_calls_consumed: 3 }]);
      expect(auditActions).toEqual([
        "tool.execution_reserved",
        "tool.execution_dispatched",
        "tool.execution_completed",
      ]);
      expect(
        [
          ...state.storage.sql.exec<{ action: string }>(
            "SELECT action FROM audit_events WHERE subject_id = ? ORDER BY event_id",
            cancellationAction.toolCallId,
          ),
        ].map((row) => row.action),
      ).toEqual(["tool.execution_reserved", "tool.execution_failed"]);

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

  it.each(["agent", "connection", "capability"] as const)(
    "rechecks a revoked %s immediately before provider dispatch",
    async (target) => {
      const fixture = await toolExecutionFixture(`dispatch-${target}`, "read");
      const reserved = await fixture.controlPlane.reserveToolExecution({
        ...fixture.reference,
        action: fixture.action,
      });

      if (!reserved.ok || reserved.state !== "allowed") {
        throw new Error("Expected pre-revocation reservation.");
      }

      const change =
        target === "agent"
          ? { agentId: fixture.agentId, target }
          : target === "connection"
            ? { connectionId: fixture.connectionId, target }
            : { grantId: fixture.grantId, target };

      await expect(
        fixture.controlPlane.changeAuthority(fixture.authority, change),
      ).resolves.toMatchObject({
        changed: true,
        ok: true,
      });
      await expect(
        fixture.controlPlane.resolveToolExecutionConnection(reserved.permit),
      ).resolves.toEqual({
        error: { code: "invalid_execution", message: "Tool execution denied." },
        ok: false,
      });
      await expect(
        fixture.controlPlane.completeToolExecution({
          outcome: { outputBytes: 0, status: "failed" },
          permit: reserved.permit,
        }),
      ).resolves.toEqual({ completed: true, ok: true });
    },
  );

  it("blocks an equivalent mutating effect until an unknown outcome is reconciled", async () => {
    const fixture = await toolExecutionFixture("unknown-reconciliation", "write");

    await approveFixtureAction(fixture, fixture.action);
    const reserved = await fixture.controlPlane.reserveToolExecution({
      ...fixture.reference,
      action: fixture.action,
    });

    if (!reserved.ok || reserved.state !== "allowed") {
      throw new Error("Expected approved recovery execution.");
    }

    await expect(
      fixture.controlPlane.resolveToolExecutionConnection(reserved.permit),
    ).resolves.toMatchObject({ ok: true });
    await runInDurableObject(fixture.controlPlane, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE tool_executions SET expires_at = ? WHERE tool_call_id = ?",
        Date.now() - 1,
        fixture.action.toolCallId,
      );
      await instance.alarm();
    });
    const retentionCheckAt = Date.now();
    await runInDurableObject(fixture.controlPlane, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_admissions SET expires_at = ?, cleanup_at = ? WHERE run_id = ?",
        retentionCheckAt - 2,
        retentionCheckAt - 1,
        fixture.reference.runId,
      );
      await instance.alarm();

      expect(
        state.storage.sql
          .exec<{ cleanup_at: number; status: string }>(
            `SELECT run_admissions.cleanup_at, tool_executions.status
             FROM run_admissions
             INNER JOIN tool_executions USING (run_id)
             WHERE tool_executions.tool_call_id = ?`,
            fixture.action.toolCallId,
          )
          .one(),
      ).toEqual({
        cleanup_at: expect.any(Number),
        status: "unknown",
      });
      expect(
        state.storage.sql
          .exec<{ cleanup_at: number }>(
            "SELECT cleanup_at FROM run_admissions WHERE run_id = ?",
            fixture.reference.runId,
          )
          .one().cleanup_at,
      ).toBeGreaterThanOrEqual(retentionCheckAt + RUN_ADMISSION_RETENTION_MS);
    });

    const retryAction = {
      ...fixture.action,
      toolCallId: `tool_call_${crypto.randomUUID()}`,
    };

    await expect(
      fixture.controlPlane.evaluateToolExecution({
        ...fixture.reference,
        action: retryAction,
      }),
    ).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    await expect(
      fixture.controlPlane.reserveToolExecution({
        ...fixture.reference,
        action: retryAction,
      }),
    ).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });

    await expect(
      fixture.controlPlane.reconcileToolExecution(fixture.authority, {
        resolution: "not_applied",
        toolCallId: fixture.action.toolCallId,
      }),
    ).resolves.toEqual({
      ok: true,
      reconciled: true,
      resolution: "not_applied",
      runId: fixture.reference.runId,
      toolCallId: fixture.action.toolCallId,
    });
    await expect(
      fixture.controlPlane.reconcileToolExecution(fixture.authority, {
        resolution: "not_applied",
        toolCallId: fixture.action.toolCallId,
      }),
    ).resolves.toMatchObject({ ok: true, reconciled: false });
    await expect(
      fixture.controlPlane.reconcileToolExecution(fixture.authority, {
        resolution: "applied",
        toolCallId: fixture.action.toolCallId,
      }),
    ).resolves.toEqual({
      error: {
        code: "execution_not_reconcilable",
        message: "Tool execution reconciliation denied.",
      },
      ok: false,
    });

    await approveFixtureAction(fixture, retryAction);
    const retryReservation = await fixture.controlPlane.reserveToolExecution({
      ...fixture.reference,
      action: retryAction,
    });

    expect(retryReservation).toMatchObject({ ok: true, state: "allowed" });
    if (!retryReservation.ok || retryReservation.state !== "allowed") {
      throw new Error("Expected the reconciled effect to be retryable.");
    }
    await expect(
      fixture.controlPlane.completeToolExecution({
        outcome: { outputBytes: 0, status: "failed" },
        permit: retryReservation.permit,
      }),
    ).resolves.toEqual({ completed: true, ok: true });

    await runInDurableObject(fixture.controlPlane, (_instance, state) => {
      expect(
        [
          ...state.storage.sql.exec<{ action: string }>(
            "SELECT action FROM audit_events WHERE subject_id = ? ORDER BY event_id",
            fixture.action.toolCallId,
          ),
        ].map((row) => row.action),
      ).toEqual([
        "tool.execution_reserved",
        "tool.execution_dispatched",
        "tool.execution_unknown",
        "tool.execution_reconciled_not_applied",
      ]);
    });
  });
});
