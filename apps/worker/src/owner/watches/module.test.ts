import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES,
  crewAgentObjectName,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
} from "@crewhelm/contracts";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vitest";

import { TestCrewAgent } from "../../agent/admitted-runs/test-agent.js";
import { AgentSchedules } from "../schedules/index.js";
import { controlPlaneSchema } from "../schema.js";
import { agentInput, authorityFor } from "../testkit.js";

const WATCH_SCOPES = [
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
] as const;

describe("OwnerControlPlane Agent Watches", () => {
  it("presents scheduled checks as a plain lifecycle with exact replay and deletion", async () => {
    const authority = await authorityFor("watch-lifecycle-owner", [...WATCH_SCOPES]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("watch-lifecycle-agent", "Watch lifecycle Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected Watch lifecycle Agent fixture.");
    }

    await expect(controlPlane.agentWatches(authority, { action: "sources" })).resolves.toEqual({
      action: "sources",
      ok: true,
      sources: [
        expect.objectContaining({
          description: expect.stringContaining("no webhook or bearer token"),
          id: "scheduled_check",
          kind: "scheduled_check",
          limits: expect.objectContaining({
            minimumEveryMinutes: 1,
            retainedOccurrences: MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES,
          }),
          name: "Scheduled check",
        }),
      ],
    });

    const createInput = {
      action: "create" as const,
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      idempotencyKey: "create-inbox-watch",
      watch: {
        instruction: "Check the approved inbox and report only work that needs attention.",
        name: "Inbox attention",
        source: {
          kind: "scheduled_check" as const,
          trigger: { intervalSeconds: 600, type: "interval" as const },
        },
      },
    };
    const configured = await controlPlane.agentWatches(authority, createInput);

    expect(configured).toMatchObject({
      action: "create",
      changed: true,
      ok: true,
      watch: {
        definition: createInput.watch,
        id: expect.stringMatching(/^schedule_/),
        nextCheckAt: expect.any(String),
        revision: 1,
        status: "active",
      },
    });
    await expect(controlPlane.agentWatches(authority, createInput)).resolves.toMatchObject({
      action: "create",
      changed: false,
      ok: true,
      watch: { revision: 1 },
    });

    if (!configured.ok || !("watch" in configured)) {
      throw new Error("Expected configured Watch fixture.");
    }

    const watchId = configured.watch.id;
    const updatedDefinition = {
      instruction: "Check the approved inbox and return a prioritized attention list.",
      name: "Prioritized inbox attention",
      source: {
        kind: "scheduled_check" as const,
        trigger: { intervalSeconds: 1_200, type: "interval" as const },
      },
    };
    const updated = await controlPlane.agentWatches(authority, {
      action: "update",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: configured.watch.revision,
      idempotencyKey: "update-inbox-watch",
      watch: updatedDefinition,
      watchId,
    });

    expect(updated).toMatchObject({
      action: "update",
      changed: true,
      ok: true,
      watch: { definition: updatedDefinition, revision: 2, status: "active" },
    });

    if (!updated.ok || !("watch" in updated)) {
      throw new Error("Expected updated Watch fixture.");
    }

    const pendingScheduledAt = Date.now();
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO agent_schedule_occurrences (
           schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
           next_attempt_at, attempts, status, run_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
        watchId,
        created.agent.id,
        updated.watch.revision,
        pendingScheduledAt,
        pendingScheduledAt,
        pendingScheduledAt + 60_000,
      );
    });
    await expect(
      controlPlane.agentWatches(authority, {
        action: "pause",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedWatchRevision: updated.watch.revision,
        idempotencyKey: "pause-busy-inbox-watch",
        watchId,
      }),
    ).resolves.toEqual({
      error: { code: "watch_busy", message: "Agent Watch request denied." },
      ok: false,
    });
    await expect(
      controlPlane.agentWatches(authority, {
        action: "delete",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedWatchRevision: updated.watch.revision,
        idempotencyKey: "delete-busy-inbox-watch",
        watchId,
      }),
    ).resolves.toEqual({
      error: { code: "watch_busy", message: "Agent Watch request denied." },
      ok: false,
    });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM agent_schedule_occurrences WHERE schedule_id = ? AND scheduled_at = ?",
        watchId,
        pendingScheduledAt,
      );
    });

    const paused = await controlPlane.agentWatches(authority, {
      action: "pause",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: updated.watch.revision,
      idempotencyKey: "pause-inbox-watch",
      watchId,
    });

    expect(paused).toMatchObject({
      action: "pause",
      changed: true,
      ok: true,
      watch: {
        definition: updatedDefinition,
        nextCheckAt: null,
        revision: 3,
        status: "paused",
      },
    });

    if (!paused.ok || !("watch" in paused)) {
      throw new Error("Expected paused Watch fixture.");
    }

    const resumed = await controlPlane.agentWatches(authority, {
      action: "resume",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: paused.watch.revision,
      idempotencyKey: "resume-inbox-watch",
      watchId,
    });

    expect(resumed).toMatchObject({
      action: "resume",
      changed: true,
      ok: true,
      watch: {
        definition: updatedDefinition,
        nextCheckAt: expect.any(String),
        revision: 4,
        status: "active",
      },
    });

    if (!resumed.ok || !("watch" in resumed)) {
      throw new Error("Expected resumed Watch fixture.");
    }

    const deleteInput = {
      action: "delete" as const,
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: resumed.watch.revision,
      idempotencyKey: "delete-inbox-watch",
      watchId,
    };

    await expect(controlPlane.agentWatches(authority, deleteInput)).resolves.toEqual({
      action: "delete",
      deleted: true,
      ok: true,
      watchId,
    });
    await expect(controlPlane.agentWatches(authority, deleteInput)).resolves.toEqual({
      action: "delete",
      deleted: false,
      ok: true,
      watchId,
    });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ definitions: number; names: number }>(
            `SELECT
               sum(CASE WHEN configuration IS NOT NULL THEN 1 ELSE 0 END) AS definitions,
               sum(CASE WHEN name <> 'Deleted Watch' THEN 1 ELSE 0 END) AS names
             FROM agent_schedule_revisions
             WHERE schedule_id = ?`,
            watchId,
          )
          .one(),
      ),
    ).resolves.toEqual({ definitions: 0, names: 0 });
    await expect(
      controlPlane.agentWatches(authority, {
        action: "inspect",
        agentId: created.agent.id,
        watchId,
      }),
    ).resolves.toEqual({
      error: { code: "watch_not_found", message: "Agent Watch request denied." },
      ok: false,
    });
  });

  it("records one duplicate-safe occurrence and exposes its dispatched Run", async () => {
    const authority = await authorityFor("watch-occurrence-owner", [...WATCH_SCOPES]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("watch-occurrence-agent", "Watch occurrence Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected Watch occurrence Agent fixture.");
    }

    await runInDurableObject(
      env.CREW_AGENT.getByName(
        crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewAgent)) {
          throw new Error("Expected Watch occurrence test Agent.");
        }

        instance.enableDurableSessionsForTest();
      },
    );

    const configured = await controlPlane.agentWatches(authority, {
      action: "create",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      idempotencyKey: "create-occurrence-watch",
      watch: {
        instruction: "Check for new work and return a concise summary.",
        name: "New work",
        source: {
          kind: "scheduled_check",
          trigger: { intervalSeconds: 60, type: "interval" },
        },
      },
    });

    if (!configured.ok || !("watch" in configured)) {
      throw new Error("Expected occurrence Watch fixture.");
    }

    await runInDurableObject(controlPlane, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE schedule_id = ?",
        Date.now() - 1,
        configured.watch.id,
      );
    });
    await runDurableObjectAlarm(controlPlane);

    const history = await vi.waitFor(
      async () => {
        const result = await controlPlane.agentWatches(authority, {
          action: "history",
          agentId: created.agent.id,
          limit: 10,
          watchId: configured.watch.id,
        });

        expect(result).toMatchObject({
          action: "history",
          occurrences: [
            {
              outcome: "dispatched",
              reason: null,
              runId: expect.stringMatching(/^run_/),
              watchRevision: configured.watch.revision,
            },
          ],
          ok: true,
        });
        return result;
      },
      { interval: 25, timeout: 5_000 },
    );

    if (!history.ok || !("occurrences" in history)) {
      throw new Error("Expected Watch occurrence history.");
    }

    const runId = history.occurrences[0]?.runId;
    if (runId === null || runId === undefined) {
      throw new Error("Expected Watch Run identity.");
    }

    await expect(controlPlane.inspectRun(authority, { runId })).resolves.toMatchObject({
      ok: true,
      run: {
        runId,
        schedule: { id: configured.watch.id, revision: configured.watch.revision },
        trigger: "schedule",
      },
    });

    await vi.waitFor(
      async () => {
        const inspected = await controlPlane.inspectRun(authority, { runId });
        expect(inspected).toMatchObject({
          ok: true,
          run: { status: expect.stringMatching(/^(?:cancelled|completed|failed)$/) },
        });
      },
      { interval: 25, timeout: 5_000 },
    );

    const recoveredScheduledAt = Date.now() - 2;
    await runInDurableObject(controlPlane, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO agent_schedule_occurrences (
           schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
           next_attempt_at, attempts, status, run_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
        configured.watch.id,
        created.agent.id,
        configured.watch.revision,
        recoveredScheduledAt,
        recoveredScheduledAt,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(controlPlane);

    const recovered = await vi.waitFor(
      async () => {
        const result = await controlPlane.agentWatches(authority, {
          action: "history",
          agentId: created.agent.id,
          limit: 10,
          watchId: configured.watch.id,
        });

        if (!result.ok || result.action !== "history") {
          throw new Error("Expected recovered Watch history.");
        }
        expect(result.occurrences.filter(({ outcome }) => outcome === "dispatched")).toHaveLength(
          2,
        );
        expect(result.occurrences.filter(({ outcome }) => outcome === "pending")).toHaveLength(0);
        expect(result.occurrences).toHaveLength(2);
        return result;
      },
      { interval: 25, timeout: 5_000 },
    );

    if (!recovered.ok || !("occurrences" in recovered)) {
      throw new Error("Expected recovered Watch occurrence.");
    }

    const recoveredRunId = recovered.occurrences.find(
      (occurrence) => occurrence.outcome === "dispatched" && occurrence.runId !== runId,
    )?.runId;
    expect(recoveredRunId).toMatch(/^run_/);
    expect(recoveredRunId).not.toBe(runId);
    await runDurableObjectAlarm(controlPlane);
    await expect(
      controlPlane.agentWatches(authority, {
        action: "history",
        agentId: created.agent.id,
        limit: 10,
        watchId: configured.watch.id,
      }),
    ).resolves.toMatchObject({
      occurrences: [
        expect.objectContaining({ runId: recoveredRunId }),
        expect.objectContaining({ runId }),
      ],
      ok: true,
    });

    if (recoveredRunId === undefined || recoveredRunId === null) {
      throw new Error("Expected recovered Watch Run identity.");
    }

    await vi.waitFor(
      async () => {
        const inspected = await controlPlane.inspectRun(authority, { runId: recoveredRunId });
        expect(inspected).toMatchObject({
          ok: true,
          run: { status: expect.stringMatching(/^(?:cancelled|completed|failed)$/) },
        });
      },
      { interval: 25, timeout: 5_000 },
    );

    await runInDurableObject(controlPlane, (_instance, state) => {
      const currentTime = Date.now();
      const firstPendingAt = currentTime - 2_000_000;
      const secondPendingAt = firstPendingAt - 1;

      for (const scheduledAt of [firstPendingAt, secondPendingAt]) {
        state.storage.sql.exec(
          `INSERT INTO agent_schedule_occurrences (
             schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
             next_attempt_at, attempts, status, run_id, reason
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
          configured.watch.id,
          created.agent.id,
          configured.watch.revision,
          scheduledAt,
          scheduledAt,
          currentTime - 1,
        );
      }
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE schedule_id = ?",
        currentTime - 1,
        configured.watch.id,
      );
      const schedules = new AgentSchedules(
        drizzle(state.storage, { schema: controlPlaneSchema }),
        state.storage,
        () => {
          throw new Error("Due occurrence claiming does not read fleet configuration.");
        },
      );
      const due = schedules.claimDue(currentTime);

      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({ scheduleId: configured.watch.id });
      expect(
        state.storage.sql
          .exec<{ pending: number }>(
            `SELECT count(*) AS pending
             FROM agent_schedule_occurrences
             WHERE schedule_id = ? AND status = 'pending'`,
            configured.watch.id,
          )
          .one(),
      ).toEqual({ pending: 2 });
      expect(
        state.storage.sql
          .exec<{ nextRunAt: number }>(
            "SELECT next_run_at AS nextRunAt FROM agent_schedules WHERE schedule_id = ?",
            configured.watch.id,
          )
          .one().nextRunAt,
      ).toBeLessThanOrEqual(currentTime);
      state.storage.sql.exec(
        "DELETE FROM agent_schedule_occurrences WHERE schedule_id = ? AND status = 'pending'",
        configured.watch.id,
      );
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE schedule_id = ?",
        currentTime + 60_000,
        configured.watch.id,
      );
    });

    const retentionPendingAt = Date.now() - 1;
    const retentionHistoryAt = retentionPendingAt - 1_000_000;
    await runInDurableObject(controlPlane, (_instance, state) => {
      for (let index = 1; index <= MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES + 1; index += 1) {
        const occurredAt = retentionHistoryAt - index;
        state.storage.sql.exec(
          `INSERT INTO agent_schedule_occurrences (
             schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
             next_attempt_at, attempts, status, run_id, reason
           ) VALUES (?, ?, ?, ?, ?, NULL, 1, 'skipped', NULL, 'dispatch_exception')`,
          configured.watch.id,
          created.agent.id,
          configured.watch.revision,
          occurredAt,
          occurredAt,
        );
      }
      state.storage.sql.exec(
        `INSERT INTO agent_schedule_occurrences (
           schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
           next_attempt_at, attempts, status, run_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
        configured.watch.id,
        created.agent.id,
        configured.watch.revision,
        retentionPendingAt,
        retentionPendingAt,
        retentionPendingAt,
      );
      new AgentSchedules(
        drizzle(state.storage, { schema: controlPlaneSchema }),
        state.storage,
        () => {
          throw new Error("Retention pruning does not read fleet configuration.");
        },
      ).recordSkipped(
        {
          scheduleId: configured.watch.id,
          scheduleRevision: configured.watch.revision,
          scheduledAt: retentionPendingAt,
        },
        Date.now(),
        "agent_unavailable",
      );
    });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ pending: number; terminal: number }>(
            `SELECT
               sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
               sum(CASE WHEN status <> 'pending' THEN 1 ELSE 0 END) AS terminal
             FROM agent_schedule_occurrences
             WHERE schedule_id = ?`,
            configured.watch.id,
          )
          .one(),
      ),
    ).resolves.toEqual({ pending: 0, terminal: MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES });
  });
});
