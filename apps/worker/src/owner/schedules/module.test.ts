import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  crewAgentObjectName,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  type OutputContract,
} from "@crewhelm/contracts";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { agentInput, authorityFor } from "../testkit.js";
import { JSON_OUTPUT_TEST_PROMPT, TestCrewAgent } from "../../agent/admitted-runs/test-agent.js";

const scheduledJsonOutputContract = {
  kind: "json",
  schema: {
    jsonSchema: {
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object",
    },
    name: "ScheduledAnswer",
    version: "1",
  },
} as const satisfies OutputContract;

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
      controlPlane.configureAgentSchedule(authority, {
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "schedule-missing-brief",
        schedule: {
          briefs: [{ id: "brief_00000000-0000-4000-8000-000000000001", revision: 1 }],
          name: "Missing Brief schedule",
          prompt: "Use context that is not available.",
          trigger: { intervalSeconds: 120, type: "interval" },
        },
      }),
    ).resolves.toMatchObject({ error: { code: "brief_unavailable" }, ok: false });

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

  it("keeps multiple named calendar responsibilities independently addressable", async () => {
    const authority = await authorityFor("multiple-schedule-owner", [
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      OWNER_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("multiple-schedule-agent", "Multiple Schedule Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected multiple-schedule Agent fixture.");
    }

    const morningInput = {
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedScheduleRevision: null,
      idempotencyKey: "create-morning-responsibility",
      schedule: {
        name: "Morning brief",
        prompt: "Prepare the morning brief.",
        trigger: {
          at: "07:00",
          frequency: "daily" as const,
          timeZone: "America/Sao_Paulo",
          type: "calendar" as const,
        },
      },
      scheduleId: null,
    };
    const morning = await controlPlane.configureAgentSchedule(authority, morningInput);
    const evening = await controlPlane.configureAgentSchedule(authority, {
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedScheduleRevision: null,
      idempotencyKey: "create-evening-responsibility",
      schedule: {
        name: "Evening wrap-up",
        prompt: "Prepare the evening wrap-up.",
        trigger: {
          at: "21:00",
          frequency: "daily",
          timeZone: "America/Sao_Paulo",
          type: "calendar",
        },
      },
      scheduleId: null,
    });

    expect([morning, evening]).toEqual([
      expect.objectContaining({
        configured: true,
        ok: true,
        schedule: expect.objectContaining({
          id: expect.stringMatching(/^schedule_/),
          name: "Morning brief",
          nextRunAt: expect.any(String),
          revision: 1,
        }),
      }),
      expect.objectContaining({
        configured: true,
        ok: true,
        schedule: expect.objectContaining({
          id: expect.stringMatching(/^schedule_/),
          name: "Evening wrap-up",
          nextRunAt: expect.any(String),
          revision: 2,
        }),
      }),
    ]);
    await expect(
      controlPlane.getAgentSchedule(authority, { agentId: created.agent.id }),
    ).resolves.toEqual({
      error: {
        code: "schedule_selection_required",
        message: "Agent schedule request denied.",
      },
      ok: false,
    });

    const listed = await controlPlane.listAgentSchedules(authority, {
      agentId: created.agent.id,
    });

    expect(listed).toMatchObject({
      ok: true,
      schedules: [
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ status: "active" }),
      ],
    });

    if (!morning.ok || morning.schedule.id === undefined) {
      throw new Error("Expected exact morning schedule identity.");
    }

    const pauseInput = {
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedScheduleRevision: morning.schedule.revision,
      idempotencyKey: "pause-morning-responsibility",
      schedule: null,
      scheduleId: morning.schedule.id,
    };
    await expect(controlPlane.configureAgentSchedule(authority, pauseInput)).resolves.toMatchObject(
      {
        configured: true,
        ok: true,
        schedule: {
          id: morning.schedule.id,
          name: "Morning brief",
          revision: 3,
          status: "paused",
        },
      },
    );
    await expect(controlPlane.configureAgentSchedule(authority, pauseInput)).resolves.toMatchObject(
      {
        configured: false,
        ok: true,
        schedule: { id: morning.schedule.id, revision: 3, status: "paused" },
      },
    );

    if (!evening.ok || evening.schedule.id === undefined) {
      throw new Error("Expected exact evening schedule identity.");
    }

    await expect(
      controlPlane.getAgentSchedule(authority, {
        agentId: created.agent.id,
        scheduleId: evening.schedule.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      schedule: { id: evening.schedule.id, revision: 2, status: "active" },
    });
  });

  it("bounds the number of independently configured schedules per Agent", async () => {
    const authority = await authorityFor("schedule-capacity-owner", [
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      OWNER_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("schedule-capacity-agent", "Schedule Capacity Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected schedule-capacity Agent fixture.");
    }

    for (let index = 0; index < 8; index += 1) {
      await expect(
        controlPlane.configureAgentSchedule(authority, {
          agentId: created.agent.id,
          expectedAgentRevision: created.agent.revision,
          expectedScheduleRevision: null,
          idempotencyKey: `create-capacity-schedule-${index}`,
          schedule: {
            name: `Responsibility ${index + 1}`,
            prompt: `Run responsibility ${index + 1}.`,
            trigger: { intervalSeconds: 60, type: "interval" },
          },
          scheduleId: null,
        }),
      ).resolves.toMatchObject({ configured: true, ok: true });
    }

    await expect(
      controlPlane.configureAgentSchedule(authority, {
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "create-capacity-schedule-overflow",
        schedule: {
          name: "Overflow responsibility",
          prompt: "This schedule exceeds the per-Agent bound.",
          trigger: { intervalSeconds: 60, type: "interval" },
        },
        scheduleId: null,
      }),
    ).resolves.toEqual({
      error: {
        code: "schedule_limit_exceeded",
        message: "Agent schedule request denied.",
      },
      ok: false,
    });

    const listed = await controlPlane.listAgentSchedules(authority, {
      agentId: created.agent.id,
    });

    if (!listed.ok || listed.schedules[0] === undefined) {
      throw new Error("Expected a reusable schedule slot.");
    }

    const reusable = listed.schedules[0];
    const paused = await controlPlane.configureAgentSchedule(authority, {
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedScheduleRevision: reusable.revision,
      idempotencyKey: "pause-capacity-schedule-slot",
      schedule: null,
      scheduleId: reusable.id,
    });

    if (!paused.ok) {
      throw new Error("Expected a paused reusable schedule slot.");
    }

    await expect(
      controlPlane.configureAgentSchedule(authority, {
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedScheduleRevision: paused.schedule.revision,
        idempotencyKey: "reuse-capacity-schedule-slot",
        schedule: {
          name: "Replacement responsibility",
          prompt: "Reuse the bounded schedule slot.",
          trigger: { intervalSeconds: 120, type: "interval" },
        },
        scheduleId: reusable.id,
      }),
    ).resolves.toMatchObject({
      configured: true,
      ok: true,
      schedule: {
        id: reusable.id,
        name: "Replacement responsibility",
        status: "active",
      },
    });
    const reused = await controlPlane.listAgentSchedules(authority, { agentId: created.agent.id });
    const reusedScheduleCount = reused.ok ? reused.schedules.length : -1;

    expect(reused).toMatchObject({ ok: true });
    expect(reusedScheduleCount).toBe(8);
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
    const brief = await controlPlane.createBrief(authority, {
      content: "Use the owner's weekly priorities when preparing this result.",
      idempotencyKey: "schedule-context-brief",
      mediaType: "text/plain",
      name: "Weekly priorities",
    });
    if (!brief.ok) throw new Error("Expected scheduled Brief fixture.");

    await runInDurableObject(
      env.CREW_AGENT.getByName(
        crewAgentObjectName({ agentId: first.agent.id, ownerKey: authority.ownerKey }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewAgent)) {
          throw new Error("Expected scheduled test Agent.");
        }

        instance.enableDurableSessionsForTest();
      },
    );

    const configured = await Promise.all([
      controlPlane.configureAgentSchedule(authority, {
        agentId: first.agent.id,
        expectedAgentRevision: first.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "configure-schedule-1",
        schedule: {
          briefs: [{ id: brief.brief.id, revision: brief.version.revision }],
          name: "Typed scheduled responsibility",
          outputContract: scheduledJsonOutputContract,
          prompt: JSON_OUTPUT_TEST_PROMPT,
          trigger: { intervalSeconds: 60, type: "interval" },
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

    const firstSchedule = configured[0];
    const secondSchedule = configured[1];

    if (!firstSchedule?.ok || !secondSchedule?.ok) {
      throw new Error("Expected exact scheduled Run provenance fixtures.");
    }

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

    const firstRunId = schedules[0].schedule.lastRunId;
    if (firstRunId === null) throw new Error("Expected first scheduled Run ID.");
    expect(schedules[0].schedule.lastRunId).not.toBe(schedules[1].schedule.lastRunId);
    await expect(
      controlPlane.listAgentSessions(authority, { agentId: first.agent.id, limit: 10 }),
    ).resolves.toEqual({ nextCursor: null, ok: true, sessions: [] });

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
            schedule: {
              id: firstSchedule.schedule.id,
              revision: 1,
            },
            trigger: "schedule",
          }),
        ],
      }),
      expect.objectContaining({
        ok: true,
        runs: [
          expect.objectContaining({
            runId: schedules[1].schedule.lastRunId,
            schedule: {
              id: secondSchedule.schedule.id,
              revision: 1,
            },
            trigger: "schedule",
          }),
        ],
      }),
    ]);
    await expect(controlPlane.inspectRun(authority, { runId: firstRunId })).resolves.toMatchObject({
      briefs: [{ id: brief.brief.id, revision: brief.version.revision }],
      ok: true,
      run: { schedule: { id: firstSchedule.schedule.id, revision: 1 } },
    });
    await expect(
      controlPlane.deleteBrief(authority, {
        expectedRevision: brief.version.revision,
        id: brief.brief.id,
        idempotencyKey: "delete-scheduled-brief",
      }),
    ).resolves.toMatchObject({ error: { code: "brief_busy" }, ok: false });
    await vi.waitFor(
      async () => {
        const inspected = await controlPlane.inspectRun(authority, {
          includeDeliverable: true,
          runId: firstRunId,
        });
        expect(inspected).toMatchObject({
          deliverableContent: { answer: expect.any(String) },
          ok: true,
          run: { deliverable: { state: "valid" }, status: "completed" },
        });
      },
      { interval: 25, timeout: 5_000 },
    );

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
        configuration: expect.objectContaining({
          scheduleId: firstSchedule.schedule.id,
          scheduleRevision: 1,
        }),
        runId: schedules[0].schedule.lastRunId,
      }),
      expect.objectContaining({
        configuration: expect.objectContaining({
          scheduleId: secondSchedule.schedule.id,
          scheduleRevision: 1,
        }),
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
    const created = await controlPlane.createAgent(authority, {
      ...agentInput("schedule-inbox-agent", "Deferred Schedule Agent"),
      capabilities: [
        {
          configuration: { model: "@cf/zai-org/glm-4.7-flash" },
          id: "inference.workers-ai",
          schemaVersion: 1,
        },
      ],
    });
    const configuration = await controlPlane.getFleetConfiguration(authority, {
      target: { kind: "fleet" },
    });

    if (!created.ok || !configuration.ok) {
      throw new Error("Expected deferred schedule fixtures.");
    }
    const restrictedConfiguration = await controlPlane.configureFleetConfiguration(authority, {
      expectedRevision: configuration.configuration.revision,
      idempotencyKey: "restrict-deferred-schedule-models",
      mode: "apply",
      patch: {
        models: {
          allowed: ["@cf/meta/llama-4-scout-17b-16e-instruct"],
          default: "@cf/meta/llama-4-scout-17b-16e-instruct",
        },
      },
      target: { kind: "fleet" },
    });

    if (!restrictedConfiguration.ok) {
      throw new Error("Expected restricted model policy.");
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
            fleetRevision: restrictedConfiguration.configuration.revision,
            scheduleRevision: 1,
          },
          kind: "deferred",
          needsAction: true,
          policy: {
            layer: "fleet",
            reason: "model_unavailable",
            retryAt: expect.any(String),
          },
          severity: "attention_required",
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
