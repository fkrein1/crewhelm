import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  type ComposioToolCapabilityGrant,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { digestRunPrompt } from "../../agent/admitted-runs/protocol.js";
import { agentInput, authorityFor, fixedRunAdmissionFailure } from "../testkit.js";

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
