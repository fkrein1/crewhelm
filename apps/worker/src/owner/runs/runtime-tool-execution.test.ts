import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNTIME_TOOL_EXECUTION_PERMIT_LIFETIME_MS,
  RUNTIME_TOOL_LATE_OPEN_CLEANUP_HORIZON_MS,
  RUNS_WRITE_SCOPE,
  completeRuntimeToolExecutionResultSchema,
  dispatchRuntimeToolExecutionResultSchema,
  reserveRuntimeToolExecutionResultSchema,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { digestRunPrompt } from "../../agent/admitted-runs/index.js";
import { digestToolInput } from "../../agent/admitted-runs/protocol.js";
import { sandboxCodeCapabilityConfiguration } from "../../agent-capabilities/sandbox-code.js";
import { workersAiCapabilityConfiguration } from "../../agent-capabilities/workers-ai.js";
import { agentInput, authorityFor } from "../testkit.js";

async function fixture(subject: string, maximumDurationMs = 5_000) {
  const authority = await authorityFor(subject, [
    OWNER_READ_SCOPE,
    OWNER_WRITE_SCOPE,
    AGENTS_READ_SCOPE,
    AGENTS_WRITE_SCOPE,
    AUTONOMY_WRITE_SCOPE,
    RUNS_WRITE_SCOPE,
  ]);
  const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
  const created = await controlPlane.createAgent(authority, {
    ...agentInput(`${subject}-agent`),
    capabilities: [
      workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
      sandboxCodeCapabilityConfiguration({
        languages: ["python"],
        maxCodeBytes: 4_096,
        maxDurationMs: maximumDurationMs,
        maxOutputBytes: 16_384,
      }),
    ].toSorted((left, right) => left.id.localeCompare(right.id)),
    executionLimits: {
      maxDurationSeconds: 45,
      maxModelTokens: 2_000,
      maxToolCalls: 2,
      maxTurns: 4,
    },
  });

  if (!created.ok) {
    throw new Error("Expected a Sandbox-enabled Agent.");
  }

  const prompt = "Calculate the result with Python.";
  const admission = await controlPlane.createRunAdmission(authority, {
    agentId: created.agent.id,
    expectedRevision: created.agent.revision,
    idempotencyKey: `${subject}-run`,
    promptCharacters: prompt.length,
    promptDigest: await digestRunPrompt(prompt),
  });

  if (!admission.ok || admission.state !== "issued") {
    throw new Error("Expected Sandbox run admission.");
  }

  await expect(controlPlane.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
    confirmed: true,
    ok: true,
  });
  const tool = admission.permit.budgetReservation.runtimePlan.tools?.[0];

  if (tool?.kind !== "sandbox-code") {
    throw new Error("Expected an admitted Sandbox runtime tool.");
  }

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
  const code = "print(6 * 7)";

  return {
    action: {
      agentId: created.agent.id,
      agentRevision: created.agent.revision,
      codeDigest: await digestToolInput({ code }),
      language: "python" as const,
      ownerKey: authority.ownerKey,
      runId: admission.permit.runId,
      tool,
      toolCallId: `tool_call_${crypto.randomUUID()}`,
    },
    authority,
    controlPlane,
    created,
    reference,
  };
}

describe("OwnerControlPlane runtime tool execution", () => {
  it("reserves, dispatches, and completes an exact admitted Sandbox call", async () => {
    const current = await fixture("runtime-tool-complete");
    const reserved = reserveRuntimeToolExecutionResultSchema.parse(
      await current.controlPlane.reserveRuntimeToolExecution({
        ...current.reference,
        action: current.action,
      }),
    );

    expect(reserved).toMatchObject({
      ok: true,
      permit: {
        action: current.action,
        audience: "crew_session_runtime_tool",
        constraints: { maxDurationMs: 5_000, maxOutputBytes: 16_384 },
      },
    });
    if (!reserved.ok) {
      throw new Error("Expected runtime tool reservation.");
    }

    await expect(
      current.controlPlane.dispatchRuntimeToolExecution({ permit: reserved.permit }),
    ).resolves.toMatchObject({ dispatched: true, ok: true });
    await expect(
      current.controlPlane.completeRuntimeToolExecution({
        outcome: { outputBytes: 42, status: "completed" },
        permit: reserved.permit,
      }),
    ).resolves.toMatchObject({ completed: true, ok: true });

    await runInDurableObject(current.controlPlane, (_instance, state) => {
      const rows = [
        ...state.storage.sql.exec("SELECT status, output_bytes FROM runtime_tool_executions"),
      ];
      expect(rows).toEqual([{ output_bytes: 42, status: "completed" }]);
    });
  });

  it("keeps dispatch strict while allowing only bounded completion reporting grace", async () => {
    const current = await fixture("runtime-tool-completion-grace");
    let currentTime = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    try {
      const reserved = reserveRuntimeToolExecutionResultSchema.parse(
        await current.controlPlane.reserveRuntimeToolExecution({
          ...current.reference,
          action: current.action,
        }),
      );

      if (!reserved.ok) throw new Error("Expected runtime tool reservation.");
      await expect(
        current.controlPlane.dispatchRuntimeToolExecution({ permit: reserved.permit }),
      ).resolves.toMatchObject({ dispatched: true, ok: true });
      currentTime += reserved.permit.constraints.maxDurationMs + 1;
      await expect(
        current.controlPlane.completeRuntimeToolExecution({
          outcome: { outputBytes: 42, status: "completed" },
          permit: reserved.permit,
        }),
      ).resolves.toMatchObject({ completed: true, ok: true });
      await runInDurableObject(current.controlPlane, (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{ status: string }>(
              "SELECT status FROM runtime_tool_executions WHERE tool_call_id = ?",
              current.action.toolCallId,
            )
            .one(),
        ).toEqual({ status: "completed" });
      });

      const delayedDispatch = await fixture("runtime-tool-delayed-dispatch", 1);
      const delayedReservation = reserveRuntimeToolExecutionResultSchema.parse(
        await delayedDispatch.controlPlane.reserveRuntimeToolExecution({
          ...delayedDispatch.reference,
          action: delayedDispatch.action,
        }),
      );
      if (!delayedReservation.ok) throw new Error("Expected delayed runtime tool reservation.");
      currentTime =
        Date.parse(delayedReservation.permit.constraints.decisionExpiresAt) -
        RUNTIME_TOOL_EXECUTION_PERMIT_LIFETIME_MS +
        delayedReservation.permit.constraints.maxDurationMs;
      expect(currentTime).toBeLessThan(
        Date.parse(delayedReservation.permit.constraints.decisionExpiresAt),
      );
      await expect(
        delayedDispatch.controlPlane.dispatchRuntimeToolExecution({
          permit: delayedReservation.permit,
        }),
      ).resolves.toMatchObject({ ok: false });

      const lateCompletion = await fixture("runtime-tool-late-completion");
      const lateReservation = reserveRuntimeToolExecutionResultSchema.parse(
        await lateCompletion.controlPlane.reserveRuntimeToolExecution({
          ...lateCompletion.reference,
          action: lateCompletion.action,
        }),
      );
      if (!lateReservation.ok) throw new Error("Expected late runtime tool reservation.");
      await expect(
        lateCompletion.controlPlane.dispatchRuntimeToolExecution({
          permit: lateReservation.permit,
        }),
      ).resolves.toMatchObject({ dispatched: true, ok: true });
      currentTime += lateReservation.permit.constraints.maxDurationMs + 5_001;
      await expect(
        lateCompletion.controlPlane.completeRuntimeToolExecution({
          outcome: { outputBytes: 42, status: "completed" },
          permit: lateReservation.permit,
        }),
      ).resolves.toMatchObject({ completed: true, ok: true });
      await runInDurableObject(lateCompletion.controlPlane, (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{ status: string }>(
              "SELECT status FROM runtime_tool_executions WHERE tool_call_id = ?",
              lateCompletion.action.toolCallId,
            )
            .one(),
        ).toEqual({ status: "unknown" });
      });
    } finally {
      now.mockRestore();
    }
  });

  it("denies stale revisions, altered tool plans, duplicate calls, and completion before dispatch", async () => {
    const current = await fixture("runtime-tool-denials");

    await expect(
      current.controlPlane.reserveRuntimeToolExecution({
        ...current.reference,
        agentRevision: current.reference.agentRevision + 1,
        action: current.action,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      current.controlPlane.reserveRuntimeToolExecution({
        ...current.reference,
        action: {
          ...current.action,
          tool: {
            ...current.action.tool,
            limits: { ...current.action.tool.limits, maxDurationMs: 5_001 },
          },
        },
      }),
    ).resolves.toMatchObject({ ok: false });

    const reserved = reserveRuntimeToolExecutionResultSchema.parse(
      await current.controlPlane.reserveRuntimeToolExecution({
        ...current.reference,
        action: current.action,
      }),
    );

    if (!reserved.ok) {
      throw new Error("Expected runtime tool reservation.");
    }

    expect(
      completeRuntimeToolExecutionResultSchema.parse(
        await current.controlPlane.completeRuntimeToolExecution({
          outcome: { outputBytes: 2, status: "completed" },
          permit: reserved.permit,
        }),
      ).ok,
    ).toBe(false);
    expect(
      reserveRuntimeToolExecutionResultSchema.parse(
        await current.controlPlane.reserveRuntimeToolExecution({
          ...current.reference,
          action: { ...current.action, toolCallId: `tool_call_${crypto.randomUUID()}` },
        }),
      ).ok,
    ).toBe(false);
    expect(
      dispatchRuntimeToolExecutionResultSchema.parse(
        await current.controlPlane.dispatchRuntimeToolExecution({
          permit: { ...reserved.permit, actionDigest: "0".repeat(64) },
        }),
      ).ok,
    ).toBe(false);
  });

  it("invalidates reserved dispatch authority after disablement, fleet change, or cancellation", async () => {
    const disabled = await fixture("runtime-tool-disable-race");
    const disabledReservation = reserveRuntimeToolExecutionResultSchema.parse(
      await disabled.controlPlane.reserveRuntimeToolExecution({
        ...disabled.reference,
        action: disabled.action,
      }),
    );

    if (!disabledReservation.ok) throw new Error("Expected disable-race reservation.");
    await expect(
      disabled.controlPlane.changeAuthority(disabled.authority, {
        agentId: disabled.created.agent.id,
        target: "agent",
      }),
    ).resolves.toMatchObject({ changed: true, ok: true });
    await expect(
      disabled.controlPlane.dispatchRuntimeToolExecution({ permit: disabledReservation.permit }),
    ).resolves.toMatchObject({ ok: false });

    const changedFleet = await fixture("runtime-tool-fleet-race");
    const fleetReservation = reserveRuntimeToolExecutionResultSchema.parse(
      await changedFleet.controlPlane.reserveRuntimeToolExecution({
        ...changedFleet.reference,
        action: changedFleet.action,
      }),
    );

    if (!fleetReservation.ok) throw new Error("Expected fleet-race reservation.");
    const fleet = await changedFleet.controlPlane.getFleetConfiguration(changedFleet.authority, {
      target: { kind: "fleet" },
    });
    if (!fleet.ok) throw new Error("Expected current fleet configuration.");
    await expect(
      changedFleet.controlPlane.configureFleetConfiguration(changedFleet.authority, {
        expectedRevision: fleet.configuration.revision,
        idempotencyKey: "runtime-tool-fleet-race-change",
        mode: "apply",
        patch: { schedules: { minimumIntervalSeconds: 120 } },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    await expect(
      changedFleet.controlPlane.dispatchRuntimeToolExecution({ permit: fleetReservation.permit }),
    ).resolves.toMatchObject({ ok: false });

    const cancelled = await fixture("runtime-tool-cancel-race");
    const cancellationReservation = reserveRuntimeToolExecutionResultSchema.parse(
      await cancelled.controlPlane.reserveRuntimeToolExecution({
        ...cancelled.reference,
        action: cancelled.action,
      }),
    );

    if (!cancellationReservation.ok) throw new Error("Expected cancellation-race reservation.");
    await runInDurableObject(cancelled.controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_admissions SET cancellation_requested_at = ? WHERE run_id = ?",
        Date.now(),
        cancelled.reference.runId,
      );
    });
    await expect(
      cancelled.controlPlane.dispatchRuntimeToolExecution({
        permit: cancellationReservation.permit,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("reconciles abandoned reservations as failed and dispatched calls as unknown", async () => {
    const current = await fixture("runtime-tool-recovery");
    const reserved = reserveRuntimeToolExecutionResultSchema.parse(
      await current.controlPlane.reserveRuntimeToolExecution({
        ...current.reference,
        action: current.action,
      }),
    );

    if (!reserved.ok) {
      throw new Error("Expected runtime tool reservation.");
    }

    await runInDurableObject(current.controlPlane, async (instance, state) => {
      const expiredAt = Date.now() - 10;
      state.storage.sql.exec(
        "UPDATE runtime_tool_executions SET started_at = ?, expires_at = ? WHERE tool_call_id = ?",
        expiredAt - 1,
        expiredAt,
        current.action.toolCallId,
      );
      await instance.alarm();
      expect(
        state.storage.sql
          .exec<{ status: string }>(
            "SELECT status FROM runtime_tool_executions WHERE tool_call_id = ?",
            current.action.toolCallId,
          )
          .one(),
      ).toEqual({ status: "failed" });
    });

    const dispatchedAction = {
      ...current.action,
      codeDigest: await digestToolInput({ code: "print(7 * 8)" }),
      toolCallId: `tool_call_${crypto.randomUUID()}`,
    };
    const dispatched = reserveRuntimeToolExecutionResultSchema.parse(
      await current.controlPlane.reserveRuntimeToolExecution({
        ...current.reference,
        action: dispatchedAction,
      }),
    );

    if (!dispatched.ok) {
      throw new Error("Expected second runtime tool reservation.");
    }

    await expect(
      current.controlPlane.dispatchRuntimeToolExecution({ permit: dispatched.permit }),
    ).resolves.toMatchObject({ dispatched: true, ok: true });
    await runInDurableObject(current.controlPlane, async (instance, state) => {
      const expiredAt = Date.now() - 10;
      state.storage.sql.exec(
        "UPDATE runtime_tool_executions SET started_at = ?, dispatched_at = ?, expires_at = ? WHERE tool_call_id = ?",
        expiredAt - 2,
        expiredAt - 1,
        expiredAt,
        dispatchedAction.toolCallId,
      );
      await instance.alarm();
      expect(
        state.storage.sql
          .exec<{ status: string }>(
            "SELECT status FROM runtime_tool_executions WHERE tool_call_id = ?",
            dispatchedAction.toolCallId,
          )
          .one(),
      ).toEqual({ status: "unknown" });
      expect(
        [
          ...state.storage.sql.exec<{ action: string }>(
            "SELECT action FROM audit_events WHERE subject_id = ? ORDER BY event_id",
            dispatchedAction.toolCallId,
          ),
        ].map((row) => row.action),
      ).toEqual(["tool.execution_reserved", "tool.execution_dispatched", "tool.execution_unknown"]);
    });

    await runInDurableObject(current.controlPlane, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE runtime_tool_executions SET cleanup_retry_at = ? WHERE run_id = ?",
        Date.now() - 1,
        current.reference.runId,
      );
      await instance.alarm();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM runtime_tool_executions WHERE run_id = ? AND cleanup_at IS NOT NULL",
            current.reference.runId,
          )
          .one(),
      ).toEqual({ count: 0 });

      const beyondLateOpenHorizon = Date.now() - RUNTIME_TOOL_LATE_OPEN_CLEANUP_HORIZON_MS - 1;
      state.storage.sql.exec(
        "UPDATE runtime_tool_executions SET started_at = ?, expires_at = ?, cleanup_retry_at = ? WHERE run_id = ?",
        beyondLateOpenHorizon - 1,
        beyondLateOpenHorizon,
        Date.now() - 1,
        current.reference.runId,
      );
      await instance.alarm();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM runtime_tool_executions WHERE run_id = ? AND cleanup_at IS NOT NULL",
            current.reference.runId,
          )
          .one(),
      ).toEqual({ count: 2 });
    });

    const activePrompt = "Keep this admitted Sandbox run active.";
    const activeAdmission = await current.controlPlane.createRunAdmission(current.authority, {
      agentId: current.created.agent.id,
      expectedRevision: current.created.agent.revision,
      idempotencyKey: "runtime-tool-recovery-active-run",
      promptCharacters: activePrompt.length,
      promptDigest: await digestRunPrompt(activePrompt),
    });

    if (!activeAdmission.ok || activeAdmission.state !== "issued") {
      throw new Error("Expected an unrelated active Sandbox admission.");
    }
    await expect(
      current.controlPlane.confirmRunAdmission(activeAdmission.permit),
    ).resolves.toMatchObject({ confirmed: true, ok: true });
    const activeTool = activeAdmission.permit.budgetReservation.runtimePlan.tools?.[0];

    if (activeTool?.kind !== "sandbox-code") {
      throw new Error("Expected the active admission to include Sandbox.");
    }
    const activeAction = {
      agentId: activeAdmission.permit.agentId,
      agentRevision: activeAdmission.permit.agentRevision,
      codeDigest: await digestToolInput({ code: "print('active')" }),
      language: "python" as const,
      ownerKey: activeAdmission.permit.ownerKey,
      runId: activeAdmission.permit.runId,
      tool: activeTool,
      toolCallId: `tool_call_${crypto.randomUUID()}`,
    };
    await expect(
      current.controlPlane.reserveRuntimeToolExecution({
        action: activeAction,
        agentId: activeAdmission.permit.agentId,
        agentRevision: activeAdmission.permit.agentRevision,
        budgetReservation: activeAdmission.permit.budgetReservation,
        clientId: activeAdmission.permit.clientId,
        idempotencyKey: activeAdmission.permit.idempotencyKey,
        ownerKey: activeAdmission.permit.ownerKey,
        promptDigest: activeAdmission.permit.promptDigest,
        runId: activeAdmission.permit.runId,
      }),
    ).resolves.toMatchObject({ ok: true });
    let activeCleanupAt = 0;
    await runInDurableObject(current.controlPlane, (_instance, state) => {
      activeCleanupAt = state.storage.sql
        .exec<{ cleanup_at: number }>(
          "SELECT cleanup_at FROM run_admissions WHERE run_id = ?",
          activeAdmission.permit.runId,
        )
        .one().cleanup_at;
    });

    await runInDurableObject(current.controlPlane, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_admissions SET expires_at = ?, cleanup_at = ? WHERE run_id = ?",
        Date.now() - 2,
        Date.now() - 1,
        current.reference.runId,
      );
      await instance.alarm();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM runtime_tool_executions WHERE run_id = ?",
            current.reference.runId,
          )
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM run_admissions WHERE run_id = ?",
            current.reference.runId,
          )
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec<{ cleanup_at: number }>(
            "SELECT cleanup_at FROM run_admissions WHERE run_id = ?",
            activeAdmission.permit.runId,
          )
          .one(),
      ).toEqual({ cleanup_at: activeCleanupAt });
    });
  });
});
