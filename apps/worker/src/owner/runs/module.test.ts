import {
  AGENTS_WRITE_SCOPE,
  MAXIMUM_OWNER_RUN_MODEL_CALLS_PER_WINDOW,
  MAXIMUM_OWNER_RUN_OUTPUT_TOKENS_PER_WINDOW,
  MAXIMUM_RUN_ADMISSIONS_PER_OWNER,
  MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUN_ADMISSION_LIFETIME_MS,
} from "@crewhelm/contracts";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { digestRunPrompt } from "../../agent/admitted-runs/index.js";
import { agentInput, agentUpdate, authorityFor, fixedRunAdmissionFailure } from "../testkit.js";

describe("OwnerControlPlane runs", () => {
  it("issues, rotates, verifies, redeems, and audits an opaque run admission durably", async () => {
    const authority = await authorityFor("230", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-230"));
    const prompt = "Summarize the private inbox without exposing its contents.";

    if (!created.ok) {
      throw new Error("Expected run-admission fixture Agent.");
    }

    const input = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "admit-run-230",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    };
    const first = await stub.createRunAdmission(authority, input);

    expect(first).toMatchObject({
      created: true,
      ok: true,
      permit: {
        agentId: created.agent.id,
        agentRevision: created.agent.revision,
        budgetReservation: {
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + prompt.length,
          maxModelCalls: 1,
          model: created.agent.model,
          maxOutputTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
          maxToolCalls: 0,
          maxTurns: 1,
          reservationId: expect.stringMatching(/^budget_/),
        },
        clientId: authority.clientId,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        ownerKey: authority.ownerKey,
        promptDigest: input.promptDigest,
        runId: expect.stringMatching(/^run_/),
      },
      state: "issued",
    });
    if (!first.ok || first.state !== "issued") {
      throw new Error("Expected first run admission.");
    }
    expect(Date.parse(first.permit.expiresAt) - Date.now()).toBeGreaterThan(0);
    expect(Date.parse(first.permit.expiresAt) - Date.now()).toBeLessThanOrEqual(
      RUN_ADMISSION_LIFETIME_MS,
    );

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT
             client_id,
             idempotency_key,
             request_digest,
             run_id,
             agent_id,
             agent_revision,
             prompt_digest,
             budget_reservation,
             nonce_digest,
             status,
             expires_at,
             cleanup_at,
             created_at,
             redeemed_at
           FROM run_admissions`,
        )
        .one(),
    );

    expect(stored).toMatchObject({
      agent_id: created.agent.id,
      agent_revision: created.agent.revision,
      client_id: authority.clientId,
      idempotency_key: input.idempotencyKey,
      nonce_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      prompt_digest: input.promptDigest,
      request_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      run_id: first.permit.runId,
      status: "issued",
    });
    expect(JSON.stringify(stored)).not.toContain(first.permit.nonce);
    expect(JSON.stringify(stored)).not.toContain(prompt);

    const nearRetentionBoundary = Date.now() + 1_000;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE run_admissions
         SET expires_at = ?, cleanup_at = ?
         WHERE run_id = ?`,
        nearRetentionBoundary,
        nearRetentionBoundary + 1,
        first.permit.runId,
      );
    });
    await evictDurableObject(stub);
    const replay = await stub.createRunAdmission(authority, input);

    expect(replay).toMatchObject({
      created: false,
      ok: true,
      permit: { runId: first.permit.runId },
      state: "issued",
    });
    if (!replay.ok || replay.state !== "issued") {
      throw new Error("Expected issued run-admission replay.");
    }
    expect(replay.permit.nonce).not.toBe(first.permit.nonce);
    expect(replay.permit.expiresAt).toBe(new Date(nearRetentionBoundary).toISOString());
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               cleanup_at,
               cleanup_at > expires_at AS retained_after_expiry,
               created_at,
               expires_at
             FROM run_admissions
             WHERE run_id = ?`,
            replay.permit.runId,
          )
          .one(),
      ),
    ).resolves.toMatchObject({
      cleanup_at: nearRetentionBoundary + 1,
      created_at: stored.created_at,
      expires_at: nearRetentionBoundary,
      retained_after_expiry: 1,
    });
    await expect(stub.verifyRunAdmission(first.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(stub.verifyRunAdmission(replay.permit)).resolves.toEqual({
      configuration: {
        agentId: created.agent.id,
        capabilityGrants: [],
        executionLimits: created.agent.executionLimits,
        instructions: created.agent.instructions,
        model: created.agent.model,
        ownerKey: authority.ownerKey,
        revision: created.agent.revision,
      },
      ok: true,
      runId: first.permit.runId,
    });
    await expect(stub.confirmRunAdmission(replay.permit)).resolves.toEqual({
      confirmed: true,
      ok: true,
      runId: first.permit.runId,
    });
    await expect(stub.confirmRunAdmission(replay.permit)).resolves.toEqual({
      confirmed: false,
      ok: true,
      runId: first.permit.runId,
    });
    const activeVerification = {
      agentId: replay.permit.agentId,
      agentRevision: replay.permit.agentRevision,
      budgetReservation: replay.permit.budgetReservation,
      clientId: replay.permit.clientId,
      idempotencyKey: replay.permit.idempotencyKey,
      ownerKey: replay.permit.ownerKey,
      promptDigest: replay.permit.promptDigest,
      runId: replay.permit.runId,
    };

    await expect(stub.verifyActiveRunAdmission(activeVerification)).resolves.toEqual({
      ok: true,
      runId: first.permit.runId,
    });
    await expect(stub.verifyActiveRunAdmission(activeVerification)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT model_call_consumed_at IS NOT NULL AS consumed FROM run_admissions WHERE run_id = ?",
            first.permit.runId,
          )
          .one(),
      ),
    ).resolves.toEqual({ consumed: 1 });
    await expect(stub.createRunAdmission(authority, input)).resolves.toEqual({
      admission: {
        agentId: created.agent.id,
        agentRevision: created.agent.revision,
        expiresAt: replay.permit.expiresAt,
        runId: first.permit.runId,
        status: "redeemed",
      },
      created: false,
      ok: true,
      state: "redeemed",
    });
    await expect(stub.verifyRunAdmission(replay.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec("SELECT action, client_id, subject_id FROM audit_events ORDER BY event_id")
          .toArray(),
      ),
    ).resolves.toEqual([
      {
        action: "agent.created",
        client_id: authority.clientId,
        subject_id: created.agent.id,
      },
      {
        action: "run.admitted",
        client_id: authority.clientId,
        subject_id: first.permit.runId,
      },
      {
        action: "run.admission_redeemed",
        client_id: authority.clientId,
        subject_id: first.permit.runId,
      },
    ]);
  });

  it("admits explicitly supported models and rejects unlisted models", async () => {
    const authority = await authorityFor("236", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const supported = await stub.createAgent(authority, {
      ...agentInput("create-supported-model-agent-236"),
      model: "@cf/zai-org/glm-4.7-flash",
    });
    const unlisted = await stub.createAgent(authority, {
      ...agentInput("create-unlisted-model-agent-236"),
      model: "@cf/example/unlisted-model",
    });
    const prompt = "Perform the exact admitted task.";

    if (!supported.ok || !unlisted.ok) {
      throw new Error("Expected model-policy fixture Agents.");
    }

    await expect(
      stub.createRunAdmission(authority, {
        agentId: supported.agent.id,
        expectedRevision: supported.agent.revision,
        idempotencyKey: "admit-supported-model-236",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toMatchObject({
      ok: true,
      permit: {
        budgetReservation: {
          model: "@cf/zai-org/glm-4.7-flash",
        },
      },
      state: "issued",
    });
    await expect(
      stub.createRunAdmission(authority, {
        agentId: unlisted.agent.id,
        expectedRevision: unlisted.agent.revision,
        idempotencyKey: "deny-unlisted-model-236",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("model_unavailable"));
  });

  it("denies malformed, unauthorized, conflicting, cross-owner, stale, and expired admissions", async () => {
    const authority = await authorityFor("231", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const readOnly = await authorityFor("231", [OWNER_READ_SCOPE]);
    const other = await authorityFor("232", [OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const otherStub = env.OWNER_CONTROL_PLANE.getByName(other.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-231"));

    if (!created.ok) {
      throw new Error("Expected denied-admission fixture Agent.");
    }

    const promptDigest = await digestRunPrompt("Perform the exact admitted task.");
    const input = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "admit-run-231",
      promptCharacters: "Perform the exact admitted task.".length,
      promptDigest,
    };

    await expect(stub.createRunAdmission(readOnly, input)).resolves.toEqual(
      fixedRunAdmissionFailure("insufficient_scope"),
    );
    await expect(
      stub.createRunAdmission(authority, { ...input, unexpectedSecret: "must-not-reflect" }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_request"));
    await expect(
      stub.createRunAdmission(authority, { ...input, expectedRevision: 2 }),
    ).resolves.toEqual(fixedRunAdmissionFailure("revision_conflict"));

    const issued = await stub.createRunAdmission(authority, input);

    if (!issued.ok || issued.state !== "issued") {
      throw new Error("Expected denied-admission permit.");
    }

    await expect(
      stub.createRunAdmission(authority, {
        ...input,
        promptDigest: await digestRunPrompt("Conflicting task."),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("idempotency_conflict"));

    for (const permit of [
      { ...issued.permit, clientId: "https://other-client.example/mcp.json" },
      {
        ...issued.permit,
        budgetReservation: {
          ...issued.permit.budgetReservation,
          maxOutputTokens: issued.permit.budgetReservation.maxOutputTokens + 1,
        },
      },
      { ...issued.permit, nonce: "A".repeat(43) },
      { ...issued.permit, ownerKey: other.ownerKey },
      { ...issued.permit, promptDigest: "a".repeat(64) },
    ]) {
      await expect(stub.verifyRunAdmission(permit)).resolves.toEqual(
        fixedRunAdmissionFailure("invalid_admission"),
      );
    }
    await expect(
      otherStub.verifyRunAdmission({ ...issued.permit, ownerKey: other.ownerKey }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_admission"));

    const updated = await stub.updateAgent(
      authority,
      agentUpdate(created.agent, "update-run-agent-231"),
    );

    expect(updated).toMatchObject({ ok: true });
    await expect(stub.verifyRunAdmission(issued.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );

    const fresh = await stub.createRunAdmission(authority, {
      ...input,
      expectedRevision: 2,
      idempotencyKey: "expire-run-231",
    });

    if (!fresh.ok || fresh.state !== "issued") {
      throw new Error("Expected expiring run admission.");
    }
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_admissions SET expires_at = 1 WHERE run_id = ?",
        fresh.permit.runId,
      );
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(
      stub.confirmRunAdmission({
        ...fresh.permit,
        expiresAt: new Date(1).toISOString(),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_admission"));
    await expect(
      stub.createRunAdmission(authority, {
        ...input,
        expectedRevision: 2,
        idempotencyKey: "expire-run-231",
      }),
    ).resolves.toMatchObject({
      admission: { runId: fresh.permit.runId, status: "expired" },
      created: false,
      ok: true,
      state: "expired",
    });
  });

  it("bounds retained run admissions per owner", async () => {
    const authority = await authorityFor("233", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-233"));

    if (!created.ok) {
      throw new Error("Expected run-admission limit fixture Agent.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1
           UNION ALL
           SELECT value + 1
           FROM sequence
           WHERE value < ?
         )
         INSERT INTO run_admissions (
           client_id,
           idempotency_key,
           request_digest,
           run_id,
           agent_id,
           agent_revision,
           prompt_digest,
           budget_reservation,
           nonce_digest,
           status,
           expires_at,
           cleanup_at,
           created_at,
           redeemed_at
         )
         SELECT
           'fixture-client',
           'fixture-key-' || value,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'run_fixture_' || value,
           ?,
           1,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ?,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'redeemed',
           1,
           9999999999999,
           1,
           1
         FROM sequence`,
        MAXIMUM_RUN_ADMISSIONS_PER_OWNER,
        created.agent.id,
        JSON.stringify({
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + 1,
          maxModelCalls: 1,
          model: created.agent.model,
          maxOutputTokens: created.agent.executionLimits.maxModelTokens,
          maxToolCalls: 0,
          maxTurns: 1,
          reservationId: "budget_22222222-2222-4222-8222-222222222222",
        }),
      );
    });

    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "over-run-limit-233",
        promptCharacters: "This run exceeds the retained-record limit.".length,
        promptDigest: await digestRunPrompt("This run exceeds the retained-record limit."),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("admission_limit_exceeded"));
  });

  it("atomically reserves from a finite rolling owner model-call budget", async () => {
    const authority = await authorityFor("234", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-234"));

    if (!created.ok) {
      throw new Error("Expected run-budget fixture Agent.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1
           UNION ALL
           SELECT value + 1
           FROM sequence
           WHERE value < ?
         )
         INSERT INTO run_admissions (
           client_id,
           idempotency_key,
           request_digest,
           run_id,
           agent_id,
           agent_revision,
           prompt_digest,
           budget_reservation,
           nonce_digest,
           status,
           expires_at,
           cleanup_at,
           created_at,
           redeemed_at,
           model_call_consumed_at,
           model_calls_consumed
         )
         SELECT
           'fixture-client',
           'budget-key-' || value,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'run_budget_fixture_' || value,
           ?,
           1,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ?,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'redeemed',
           1,
           ?,
           ?,
           1,
           1,
           1
         FROM sequence`,
        MAXIMUM_OWNER_RUN_MODEL_CALLS_PER_WINDOW,
        created.agent.id,
        JSON.stringify({
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + 1,
          maxModelCalls: 1,
          model: created.agent.model,
          maxOutputTokens: 1,
          maxToolCalls: 0,
          maxTurns: 1,
          reservationId: "budget_22222222-2222-4222-8222-222222222222",
        }),
        Date.now() + 24 * 60 * 60 * 1_000,
        Date.now(),
      );
    });

    const prompt = "This run exceeds the rolling owner model-call budget.";

    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "over-run-budget-234",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("budget_exhausted"));
  });

  it("reserves the aggregate output allowance for every admitted model step", async () => {
    const authority = await authorityFor("235", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = agentInput("create-run-agent-235");
    const created = await stub.createAgent(authority, {
      ...input,
      executionLimits: {
        ...input.executionLimits,
        maxModelTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
        maxTurns: 100,
      },
    });

    if (!created.ok) {
      throw new Error("Expected aggregate output-budget fixture Agent.");
    }

    const reservedModelCalls = Math.floor(
      MAXIMUM_OWNER_RUN_OUTPUT_TOKENS_PER_WINDOW / MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
    );

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO run_admissions (
           client_id,
           idempotency_key,
           request_digest,
           run_id,
           agent_id,
           agent_revision,
           prompt_digest,
           budget_reservation,
           nonce_digest,
           status,
           expires_at,
           cleanup_at,
           created_at,
           redeemed_at
         ) VALUES (
           'fixture-client',
           'aggregate-output-budget',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'run_aggregate_output_budget',
           ?,
           1,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ?,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'redeemed',
           1,
           ?,
           ?,
           1
         )`,
        created.agent.id,
        JSON.stringify({
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + 1,
          maxModelCalls: reservedModelCalls,
          model: created.agent.model,
          maxOutputTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
          maxToolCalls: 0,
          maxTurns: reservedModelCalls,
          reservationId: "budget_23522222-2222-4222-8222-222222222222",
          toolGrants: [],
        }),
        Date.now() + 24 * 60 * 60 * 1_000,
        Date.now(),
      );
    });

    const prompt = "This additional step exceeds the aggregate owner output budget.";

    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "over-output-budget-235",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("budget_exhausted"));
  });
});
