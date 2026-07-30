import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
} from "@crewhelm/contracts";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { agentInput, authorityFor } from "../testkit.js";

describe("OwnerControlPlane Agent schedules", () => {
  it("enforces the current fleet minimum when configuring a recurring schedule", async () => {
    const authority = await authorityFor("schedule-minimum-owner", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("schedule-minimum-agent", "Minimum Schedule Agent"),
    );
    const configuration = await controlPlane.getFleetConfiguration(authority, {
      target: { kind: "fleet" },
    });

    if (!created.ok || !configuration.ok) {
      throw new Error("Expected schedule configuration fixtures.");
    }

    await expect(
      controlPlane.configureFleetConfiguration(authority, {
        expectedRevision: configuration.configuration.revision,
        idempotencyKey: "schedule-minimum-fleet",
        mode: "apply",
        patch: { schedules: { minimumIntervalSeconds: 120 } },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    await expect(
      controlPlane.configureAgentSchedule(authority, {
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "schedule-minimum-denied",
        schedule: {
          intervalSeconds: 60,
          prompt: "This schedule is too frequent for the fleet policy.",
        },
      }),
    ).resolves.toMatchObject({ error: { code: "invalid_request" }, ok: false });
    await expect(
      controlPlane.configureAgentSchedule(authority, {
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "schedule-minimum-allowed",
        schedule: {
          intervalSeconds: 120,
          prompt: "This schedule matches the fleet minimum.",
        },
      }),
    ).resolves.toMatchObject({ configured: true, ok: true });
  });

  it("dispatches multiple due Agents independently and exposes their scheduled run history", async () => {
    const authority = await authorityFor("schedule-owner-1", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const first = await controlPlane.createAgent(
      authority,
      agentInput("schedule-agent-1", "Scheduled Agent One"),
    );
    const second = await controlPlane.createAgent(
      authority,
      agentInput("schedule-agent-2", "Scheduled Agent Two"),
    );

    if (!first.ok || !second.ok) {
      throw new Error("Expected scheduled Agent fixtures.");
    }

    const configured = await Promise.all([
      controlPlane.configureAgentSchedule(authority, {
        agentId: first.agent.id,
        expectedAgentRevision: first.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "configure-schedule-1",
        schedule: {
          intervalSeconds: 60,
          prompt: "Summarize the first scheduled responsibility.",
        },
      }),
      controlPlane.configureAgentSchedule(authority, {
        agentId: second.agent.id,
        expectedAgentRevision: second.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "configure-schedule-2",
        schedule: {
          intervalSeconds: 60,
          prompt: "Summarize the second scheduled responsibility.",
        },
      }),
    ]);

    expect(configured).toEqual([
      expect.objectContaining({ configured: true, ok: true }),
      expect.objectContaining({ configured: true, ok: true }),
    ]);

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE status = 'active'",
        Date.now() - 1,
      );
    });
    await runDurableObjectAlarm(controlPlane);

    const schedules = await vi.waitFor(
      async () => {
        const results = await Promise.all([
          controlPlane.getAgentSchedule(authority, { agentId: first.agent.id }),
          controlPlane.getAgentSchedule(authority, { agentId: second.agent.id }),
        ]);

        expect(results).toEqual([
          expect.objectContaining({
            ok: true,
            schedule: expect.objectContaining({ lastRunId: expect.any(String) }),
          }),
          expect.objectContaining({
            ok: true,
            schedule: expect.objectContaining({ lastRunId: expect.any(String) }),
          }),
        ]);
        return results;
      },
      { interval: 25, timeout: 5_000 },
    );

    if (!schedules[0]?.ok || !schedules[1]?.ok) {
      throw new Error("Expected dispatched Agent schedules.");
    }

    expect(schedules[0].schedule.lastRunId).not.toBe(schedules[1].schedule.lastRunId);

    const histories = await Promise.all([
      controlPlane.listAgentRuns(authority, { agentId: first.agent.id, limit: 10 }),
      controlPlane.listAgentRuns(authority, { agentId: second.agent.id, limit: 10 }),
    ]);

    expect(histories).toEqual([
      expect.objectContaining({
        ok: true,
        runs: [
          expect.objectContaining({
            runId: schedules[0].schedule.lastRunId,
            trigger: "schedule",
          }),
        ],
      }),
      expect.objectContaining({
        ok: true,
        runs: [
          expect.objectContaining({
            runId: schedules[1].schedule.lastRunId,
            trigger: "schedule",
          }),
        ],
      }),
    ]);

    const outcomes = await vi.waitFor(
      async () =>
        Promise.all(
          [first, second].map(async (created) => {
            const inbox = await controlPlane.agentInbox(authority, {
              action: "list",
              agentId: created.agent.id,
              includeAcknowledged: true,
              kinds: ["outcome"],
              limit: 1,
            });

            if (!inbox.ok || inbox.action !== "list" || inbox.items[0] === undefined) {
              throw new Error("Expected scheduled Agent inbox outcome.");
            }

            return inbox.items[0];
          }),
        ),
      { interval: 25, timeout: 5_000 },
    );

    expect(outcomes).toEqual([
      expect.objectContaining({
        configuration: expect.objectContaining({ scheduleRevision: 1 }),
        runId: schedules[0].schedule.lastRunId,
      }),
      expect.objectContaining({
        configuration: expect.objectContaining({ scheduleRevision: 1 }),
        runId: schedules[1].schedule.lastRunId,
      }),
    ]);
  });

  it("surfaces deferred scheduled work with the limiting policy and retry time", async () => {
    const authority = await authorityFor("schedule-inbox-owner", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("schedule-inbox-agent", "Deferred Schedule Agent"),
    );
    const configuration = await controlPlane.getFleetConfiguration(authority, {
      target: { kind: "fleet" },
    });

    if (!created.ok || !configuration.ok) {
      throw new Error("Expected deferred schedule fixtures.");
    }

    await expect(
      controlPlane.configureAgentSchedule(authority, {
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "configure-deferred-schedule",
        schedule: {
          intervalSeconds: 60,
          prompt: "This work should be deferred by the fleet model policy.",
        },
      }),
    ).resolves.toMatchObject({ configured: true, ok: true });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_revisions SET model = ? WHERE agent_id = ? AND revision = ?",
        "unavailable/test-model",
        created.agent.id,
        created.agent.revision,
      );
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE agent_id = ?",
        Date.now() - 1,
        created.agent.id,
      );
    });
    await runDurableObjectAlarm(controlPlane);
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE agent_id = ?",
        Date.now() - 1,
        created.agent.id,
      );
    });
    await runDurableObjectAlarm(controlPlane);

    const inbox = await controlPlane.agentInbox(authority, {
      action: "list",
      limit: 10,
    });

    expect(inbox).toMatchObject({
      action: "list",
      items: [
        {
          agentId: created.agent.id,
          agentName: "Deferred Schedule Agent",
          configuration: {
            agentRevision: created.agent.revision,
            fleetRevision: configuration.configuration.revision,
            scheduleRevision: 1,
          },
          kind: "deferred",
          policy: {
            layer: "fleet",
            reason: "model_unavailable",
            retryAt: expect.any(String),
          },
        },
      ],
      ok: true,
    });
    await expect(
      controlPlane.getAgentSchedule(authority, { agentId: created.agent.id }),
    ).resolves.toMatchObject({
      ok: true,
      schedule: {
        lastAttempt: {
          occurredAt: expect.any(String),
          outcome: "deferred",
          reason: "model_unavailable",
          retryAt: expect.any(String),
          runId: null,
        },
      },
    });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ value: number }>(
            "SELECT count(*) AS value FROM agent_inbox_items WHERE kind = 'deferred'",
          )
          .one(),
      ),
    ).resolves.toEqual({ value: 1 });
  });

  it("versions schedule policy and pauses a schedule when its bound Agent revision becomes stale", async () => {
    const authority = await authorityFor("schedule-owner-2", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("schedule-version-agent", "Versioned Schedule Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected versioned schedule Agent.");
    }

    const input = {
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedScheduleRevision: null,
      idempotencyKey: "configure-versioned-schedule",
      schedule: {
        intervalSeconds: 60,
        prompt: "Run only under the exact configured Agent revision.",
      },
    };
    await expect(
      controlPlane.configureAgentSchedule(
        {
          ...authority,
          scopes: authority.scopes.filter((scope) => scope !== AUTONOMY_WRITE_SCOPE),
        },
        input,
      ),
    ).resolves.toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent schedule request denied.",
      },
      ok: false,
    });
    const configured = await controlPlane.configureAgentSchedule(authority, input);

    expect(configured).toMatchObject({
      configured: true,
      ok: true,
      schedule: { revision: 1, status: "active" },
    });
    await expect(
      controlPlane.configureAgentSchedule(
        {
          ...authority,
          scopes: authority.scopes.filter((scope) => scope !== AUTONOMY_WRITE_SCOPE),
        },
        {
          ...input,
          expectedScheduleRevision: 1,
          idempotencyKey: "pause-versioned-schedule-without-autonomy",
          schedule: null,
        },
      ),
    ).resolves.toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent schedule request denied.",
      },
      ok: false,
    });
    await runInDurableObject(controlPlane, async (_instance, state) => {
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await expect(controlPlane.configureAgentSchedule(authority, input)).resolves.toMatchObject({
      configured: false,
      ok: true,
      schedule: { revision: 1 },
    });
    await runInDurableObject(controlPlane, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
    });

    const updated = await controlPlane.updateAgent(authority, {
      ...agentInput("unused"),
      expectedRevision: created.agent.revision,
      id: created.agent.id,
      idempotencyKey: "revise-scheduled-agent",
      name: "Revised Schedule Agent",
    });

    if (!updated.ok) {
      throw new Error("Expected scheduled Agent revision.");
    }

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE agent_id = ?",
        Date.now() - 1,
        created.agent.id,
      );
    });
    await runDurableObjectAlarm(controlPlane);

    await expect(
      controlPlane.getAgentSchedule(authority, { agentId: created.agent.id }),
    ).resolves.toMatchObject({
      ok: true,
      schedule: {
        agentRevision: created.agent.revision,
        lastRunId: null,
        nextRunAt: null,
        status: "paused",
      },
    });
  });

  it("continues after the previous completed run admission ages out", async () => {
    const authority = await authorityFor("schedule-owner-3", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("schedule-retention-agent", "Retention Schedule Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected retention schedule Agent.");
    }

    const configured = await controlPlane.configureAgentSchedule(authority, {
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedScheduleRevision: null,
      idempotencyKey: "configure-retention-schedule",
      schedule: {
        intervalSeconds: 60,
        prompt: "Continue after retained history expires.",
      },
    });

    if (!configured.ok) {
      throw new Error("Expected retention schedule configuration.");
    }

    const retainedRunId = "run_33333333-3333-4333-8333-333333333333";
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE agent_schedules
         SET last_run_id = ?, last_dispatched_at = ?, next_run_at = ?
         WHERE agent_id = ?`,
        retainedRunId,
        Date.now(),
        Date.now() - 1,
        created.agent.id,
      );
    });
    await runDurableObjectAlarm(controlPlane);

    const schedule = await controlPlane.getAgentSchedule(authority, {
      agentId: created.agent.id,
    });

    expect(schedule).toMatchObject({
      ok: true,
      schedule: { lastRunId: expect.any(String) },
    });

    if (!schedule.ok) {
      throw new Error("Expected the retained schedule to dispatch.");
    }

    expect(schedule.schedule.lastRunId).not.toBe(retainedRunId);
  });
});
