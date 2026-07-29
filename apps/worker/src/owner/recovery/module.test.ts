import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  MAXIMUM_BATCH_AGENT_DISABLE_ITEMS,
  MAXIMUM_BATCH_AGENT_DISABLE_RESPONSE_BYTES,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  type ComposioToolCapabilityGrant,
} from "@crewhelm/contracts";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { digestRunPrompt } from "../../agent/admitted-runs/protocol.js";
import { agentInput, agentUpdate, authorityFor, fixedRunAdmissionFailure } from "../testkit.js";

const connectionId = "connection_90000000-0000-4000-8000-000000000001";
const firstGrantId = "grant_90000000-0000-4000-8000-000000000002";
const secondGrantId = "grant_90000000-0000-4000-8000-000000000003";

describe("owner recovery controls", () => {
  it("disables an Agent idempotently and invalidates issued and new admissions", async () => {
    const authority = await authorityFor("recovery-agent", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("recovery-agent"));

    if (!created.ok) {
      throw new Error("Expected recovery Agent.");
    }

    const prompt = "Run only while this Agent remains active.";
    const issued = await controlPlane.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "recovery-issued",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!issued.ok || issued.state !== "issued") {
      throw new Error("Expected issued recovery admission.");
    }

    await expect(
      controlPlane.changeAuthority(authority, {
        agentId: created.agent.id,
        target: "agent",
      }),
    ).resolves.toEqual({
      changed: true,
      ok: true,
      state: {
        agentId: created.agent.id,
        status: "disabled",
        target: "agent",
      },
    });
    await expect(
      controlPlane.changeAuthority(authority, {
        agentId: created.agent.id,
        target: "agent",
      }),
    ).resolves.toMatchObject({ changed: false, ok: true });
    await expect(controlPlane.getAgent(authority, { id: created.agent.id })).resolves.toMatchObject(
      {
        agent: { status: "disabled" },
        ok: true,
      },
    );
    await expect(controlPlane.verifyRunAdmission(issued.permit)).resolves.toEqual({
      error: { code: "invalid_admission", message: "Run admission denied." },
      ok: false,
    });
    await expect(
      controlPlane.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "recovery-new",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("agent_unavailable"));

    await runInDurableObject(controlPlane, (_instance, state) => {
      expect(
        [
          ...state.storage.sql.exec<{ action: string }>(
            "SELECT action FROM audit_events WHERE subject_id = ? ORDER BY event_id",
            created.agent.id,
          ),
        ].map((row) => row.action),
      ).toEqual(["agent.created", "agent.disabled"]);
    });
  });

  it("returns ordered mixed receipts and preserves exact-revision run and schedule safety", async () => {
    const authority = await authorityFor("recovery-agent-batch", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const [disable, conflict, alreadyDisabled] = await Promise.all([
      controlPlane.createAgent(authority, agentInput("recovery-batch-disable")),
      controlPlane.createAgent(authority, agentInput("recovery-batch-conflict")),
      controlPlane.createAgent(authority, agentInput("recovery-batch-already")),
    ]);

    if (!disable.ok || !conflict.ok || !alreadyDisabled.ok) {
      throw new Error("Expected batch recovery Agents.");
    }

    const updatedConflict = await controlPlane.updateAgent(
      authority,
      agentUpdate(conflict.agent, "recovery-batch-conflict-update"),
    );

    if (!updatedConflict.ok) {
      throw new Error("Expected revised conflict Agent.");
    }

    await expect(
      controlPlane.changeAuthority(authority, {
        agentId: alreadyDisabled.agent.id,
        target: "agent",
      }),
    ).resolves.toMatchObject({ changed: true, ok: true });
    await expect(
      controlPlane.configureAgentSchedule(authority, {
        agentId: disable.agent.id,
        expectedAgentRevision: disable.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "recovery-batch-schedule",
        schedule: {
          intervalSeconds: 60,
          prompt: "Run only while this exact Agent revision remains active.",
        },
      }),
    ).resolves.toMatchObject({ configured: true, ok: true });

    const prompt = "Keep this work bound to the exact active Agent revision.";
    const [disableAdmission, conflictAdmission] = await Promise.all([
      controlPlane.createRunAdmission(authority, {
        agentId: disable.agent.id,
        expectedRevision: disable.agent.revision,
        idempotencyKey: "recovery-batch-disable-admission",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
      controlPlane.createRunAdmission(authority, {
        agentId: updatedConflict.agent.id,
        expectedRevision: updatedConflict.agent.revision,
        idempotencyKey: "recovery-batch-conflict-admission",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ]);

    if (
      !disableAdmission.ok ||
      disableAdmission.state !== "issued" ||
      !conflictAdmission.ok ||
      conflictAdmission.state !== "issued"
    ) {
      throw new Error("Expected batch recovery admissions.");
    }

    const missingAgentId = "agent_90000000-0000-4000-8000-000000000004";
    const input = {
      agents: [
        { agentId: disable.agent.id, expectedRevision: disable.agent.revision },
        { agentId: missingAgentId, expectedRevision: 1 },
        { agentId: conflict.agent.id, expectedRevision: conflict.agent.revision },
        {
          agentId: alreadyDisabled.agent.id,
          expectedRevision: alreadyDisabled.agent.revision,
        },
      ],
    };

    await expect(controlPlane.batchDisableAgents(authority, input)).resolves.toEqual({
      ok: true,
      receipts: [
        {
          agentId: disable.agent.id,
          expectedRevision: disable.agent.revision,
          outcome: "disabled",
        },
        {
          agentId: missingAgentId,
          expectedRevision: 1,
          outcome: "agent_not_found",
        },
        {
          agentId: conflict.agent.id,
          expectedRevision: conflict.agent.revision,
          outcome: "revision_conflict",
        },
        {
          agentId: alreadyDisabled.agent.id,
          expectedRevision: alreadyDisabled.agent.revision,
          outcome: "already_disabled",
        },
      ],
    });
    await expect(controlPlane.verifyRunAdmission(disableAdmission.permit)).resolves.toEqual({
      error: { code: "invalid_admission", message: "Run admission denied." },
      ok: false,
    });
    await expect(controlPlane.verifyRunAdmission(conflictAdmission.permit)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      controlPlane.createRunAdmission(authority, {
        agentId: disable.agent.id,
        expectedRevision: disable.agent.revision,
        idempotencyKey: "recovery-batch-new-admission",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("agent_unavailable"));

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE agent_id = ?",
        Date.now() - 1,
        disable.agent.id,
      );
    });
    await runDurableObjectAlarm(controlPlane);
    await expect(
      controlPlane.getAgentSchedule(authority, { agentId: disable.agent.id }),
    ).resolves.toMatchObject({
      ok: true,
      schedule: { lastRunId: null, nextRunAt: null, status: "paused" },
    });

    await evictDurableObject(controlPlane);
    await expect(controlPlane.batchDisableAgents(authority, input)).resolves.toEqual({
      ok: true,
      receipts: [
        {
          agentId: disable.agent.id,
          expectedRevision: disable.agent.revision,
          outcome: "already_disabled",
        },
        {
          agentId: missingAgentId,
          expectedRevision: 1,
          outcome: "agent_not_found",
        },
        {
          agentId: conflict.agent.id,
          expectedRevision: conflict.agent.revision,
          outcome: "revision_conflict",
        },
        {
          agentId: alreadyDisabled.agent.id,
          expectedRevision: alreadyDisabled.agent.revision,
          outcome: "already_disabled",
        },
      ],
    });
    await runInDurableObject(controlPlane, (_instance, state) => {
      const disabledAudits = [
        ...state.storage.sql.exec<{ subject_id: string; value: number }>(
          `SELECT subject_id, count(*) AS value
           FROM audit_events
           WHERE action = 'agent.disabled'
           GROUP BY subject_id
           ORDER BY subject_id`,
        ),
      ];

      expect(disabledAudits).toHaveLength(2);
      expect(disabledAudits).toEqual(
        expect.arrayContaining([
          { subject_id: alreadyDisabled.agent.id, value: 1 },
          { subject_id: disable.agent.id, value: 1 },
        ]),
      );
    });
  });

  it("rejects unauthorized and duplicate batch targets without changing Agents", async () => {
    const authority = await authorityFor("recovery-agent-batch-denied", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("recovery-batch-denied"));

    if (!created.ok) {
      throw new Error("Expected denied batch recovery Agent.");
    }

    const item = { agentId: created.agent.id, expectedRevision: created.agent.revision };

    await expect(
      controlPlane.batchDisableAgents(
        { ...authority, scopes: [OWNER_WRITE_SCOPE] },
        { agents: [item] },
      ),
    ).resolves.toEqual({
      error: {
        code: "insufficient_scope",
        message: "Batch Agent disable request denied.",
      },
      ok: false,
    });
    await expect(
      controlPlane.batchDisableAgents(authority, { agents: [item, item] }),
    ).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Batch Agent disable request denied.",
      },
      ok: false,
    });
    await expect(
      controlPlane.batchDisableAgents(authority, {
        agents: Array.from({ length: MAXIMUM_BATCH_AGENT_DISABLE_ITEMS + 1 }, (_, index) => ({
          agentId: `agent_90000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
          expectedRevision: 1,
        })),
      }),
    ).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Batch Agent disable request denied.",
      },
      ok: false,
    });
    await expect(controlPlane.getAgent(authority, { id: created.agent.id })).resolves.toMatchObject(
      {
        agent: { status: "active" },
        ok: true,
      },
    );
  });

  it("keeps a full bounded batch response compact and auditable", async () => {
    const authority = await authorityFor("recovery-agent-batch-maximum", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const agents = [];

    for (let index = 0; index < MAXIMUM_BATCH_AGENT_DISABLE_ITEMS; index += 1) {
      const created = await controlPlane.createAgent(
        authority,
        agentInput(`recovery-batch-maximum-${index}`),
      );

      if (!created.ok) {
        throw new Error("Expected maximum batch recovery Agent.");
      }
      agents.push({
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
      });
    }

    const result = await controlPlane.batchDisableAgents(authority, { agents });

    expect(result).toMatchObject({
      ok: true,
      receipts: agents.map((agent) => ({ ...agent, outcome: "disabled" })),
    });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAXIMUM_BATCH_AGENT_DISABLE_RESPONSE_BYTES,
    );
    await runInDurableObject(controlPlane, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ value: number }>(
            "SELECT count(*) AS value FROM audit_events WHERE action = 'agent.disabled'",
          )
          .one(),
      ).toEqual({ value: MAXIMUM_BATCH_AGENT_DISABLE_ITEMS });
    });
  });

  it("rolls back the complete batch when durable audit persistence is interrupted", async () => {
    const authority = await authorityFor("recovery-agent-batch-rollback", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const [first, second] = await Promise.all([
      controlPlane.createAgent(authority, agentInput("recovery-batch-rollback-first")),
      controlPlane.createAgent(authority, agentInput("recovery-batch-rollback-second")),
    ]);

    if (!first.ok || !second.ok) {
      throw new Error("Expected rollback batch recovery Agents.");
    }

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_second_agent_disable_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'agent.disabled' AND NEW.subject_id = '${second.agent.id}'
        BEGIN
          SELECT RAISE(ABORT, 'forced batch audit failure');
        END
      `);
    });
    const input = {
      agents: [first, second].map(({ agent }) => ({
        agentId: agent.id,
        expectedRevision: agent.revision,
      })),
    };

    await expect(
      runInDurableObject(controlPlane, (instance) => instance.batchDisableAgents(authority, input)),
    ).rejects.toThrow("forced batch audit failure");
    await runInDurableObject(controlPlane, (_instance, state) => {
      expect([
        ...state.storage.sql.exec<{ status: string }>(
          "SELECT status FROM agents ORDER BY agent_id",
        ),
      ]).toEqual([{ status: "active" }, { status: "active" }]);
      expect(
        state.storage.sql
          .exec<{ value: number }>(
            "SELECT count(*) AS value FROM audit_events WHERE action = 'agent.disabled'",
          )
          .one(),
      ).toEqual({ value: 0 });
      state.storage.sql.exec("DROP TRIGGER reject_second_agent_disable_audit");
    });
    await expect(controlPlane.batchDisableAgents(authority, input)).resolves.toMatchObject({
      ok: true,
      receipts: [
        { agentId: first.agent.id, outcome: "disabled" },
        { agentId: second.agent.id, outcome: "disabled" },
      ],
    });
  });

  it("revokes one capability narrowly and cascades a connection revocation", async () => {
    const authority = await authorityFor("recovery-connection", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      ...agentInput("recovery-connection"),
      executionLimits: {
        maxDurationSeconds: 60,
        maxModelTokens: 2_000,
        maxToolCalls: 2,
        maxTurns: 2,
      },
    });

    if (!created.ok) {
      throw new Error("Expected connection recovery Agent.");
    }

    const grant = (grantId: string, toolSlug: string): ComposioToolCapabilityGrant => ({
      agentId: created.agent.id,
      agentRevision: created.agent.revision,
      authorization: "approval_required",
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      effect: "read",
      expiresAt: null,
      grantId,
      integrationSlug: "recovery_toolkit",
      limits: {
        maxCallsPerRun: 1,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 1_000,
        maxDurationMs: 10_000,
        maxOutputBytes: 10_000,
      },
      ownerKey: authority.ownerKey,
      targetDigests: ["a".repeat(64)],
      tool: {
        description: "Read recovery state.",
        inputParametersJson: "{}",
        name: toolSlug,
        outputParametersJson: "{}",
        tags: ["readOnlyHint"],
      },
      toolkitVersion: "20260728_00",
      toolSlug,
    });
    const firstGrant = grant(firstGrantId, "RECOVERY_READ_FIRST");
    const secondGrant = grant(secondGrantId, "RECOVERY_READ_SECOND");

    await runInDurableObject(controlPlane, (_instance, state) => {
      const currentTime = Date.now();
      state.storage.sql.exec(
        `INSERT INTO connections
           (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
         VALUES (?, 'composio', ?, ?, 'active', ?)`,
        connectionId,
        "ca_recovery_connection",
        "ac_recovery_connection",
        currentTime,
      );

      for (const storedGrant of [firstGrant, secondGrant]) {
        state.storage.sql.exec(
          `INSERT INTO capability_grants
             (grant_id, agent_id, agent_revision, connection_id, grant, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
          storedGrant.grantId,
          storedGrant.agentId,
          storedGrant.agentRevision,
          storedGrant.connectionId,
          JSON.stringify(storedGrant),
          currentTime,
        );
      }

      state.storage.sql.exec(
        `UPDATE agent_revisions
         SET capability_grants = ?
         WHERE agent_id = ? AND revision = ?`,
        JSON.stringify([firstGrantId, secondGrantId]),
        created.agent.id,
        created.agent.revision,
      );
    });

    await expect(
      controlPlane.changeAuthority(authority, {
        grantId: firstGrantId,
        target: "capability",
      }),
    ).resolves.toMatchObject({
      changed: true,
      ok: true,
      state: { grantId: firstGrantId, status: "revoked", target: "capability" },
    });

    const prompt = "Use only the capability that remains active.";
    const admission = await controlPlane.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "recovery-scoped-grant",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    expect(admission).toMatchObject({
      ok: true,
      permit: { budgetReservation: { toolGrants: [secondGrant] } },
      state: "issued",
    });

    await expect(
      controlPlane.changeAuthority(authority, {
        connectionId,
        target: "connection",
      }),
    ).resolves.toMatchObject({
      changed: true,
      ok: true,
      state: { connectionId, status: "revoked", target: "connection" },
    });
    await expect(controlPlane.listConnections(authority, {})).resolves.toMatchObject({
      connections: [{ connectionId, status: "revoked" }],
      ok: true,
    });

    await runInDurableObject(controlPlane, (_instance, state) => {
      expect([
        ...state.storage.sql.exec<{ grant_id: string; status: string }>(
          `SELECT grant_id, status
           FROM capability_grants
           WHERE connection_id = ?
           ORDER BY grant_id`,
          connectionId,
        ),
      ]).toEqual([
        { grant_id: firstGrantId, status: "revoked" },
        { grant_id: secondGrantId, status: "revoked" },
      ]);
    });
  });
});
