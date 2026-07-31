import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  MAXIMUM_SESSION_CONTEXT_CHARACTERS,
  crewAgentObjectName,
  crewSessionObjectName,
  ownerAuthoritySchema,
  type CreateAgentInput,
  type OwnerAuthority,
  type Run,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { workersAiCapabilityConfiguration } from "../agent-capabilities/workers-ai.js";
import { deriveOwnerKey } from "../owner/identity.js";
import {
  REJECTED_SESSION_PROMPT,
  SLOW_TEST_PROMPT,
  TestCrewAgent,
  TestCrewSession,
} from "./admitted-runs/test-agent.js";
import { admittedRunRecordSchema } from "./admitted-runs/schema.js";
import { digestRunPrompt } from "./admitted-runs/protocol.js";

async function authorityFor(subject: string): Promise<OwnerAuthority> {
  return ownerAuthoritySchema.parse({
    clientId: "https://client.example/mcp.json",
    ownerKey: await deriveOwnerKey({ issuer: "https://github.com", subject }),
    scopes: [OWNER_WRITE_SCOPE, AGENTS_READ_SCOPE, AGENTS_WRITE_SCOPE, RUNS_WRITE_SCOPE],
  });
}

function agentInput(idempotencyKey: string): CreateAgentInput {
  return {
    capabilities: [workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct")],
    executionLimits: {
      maxDurationSeconds: 45,
      maxModelTokens: 2_000,
      maxToolCalls: 0,
      maxTurns: 4,
    },
    idempotencyKey,
    instructions: "Return one concise, plain-text answer.",
    name: "Durable session fixture",
  };
}

async function enableSessions(ownerKey: string, agentId: string): Promise<void> {
  const stub = env.CREW_AGENT.getByName(crewAgentObjectName({ agentId, ownerKey }));
  await runInDurableObject(stub, (instance) => {
    if (!(instance instanceof TestCrewAgent)) {
      throw new Error("Expected the test CrewAgent implementation.");
    }

    instance.enableDurableSessionsForTest();
  });
}

async function completedRun(
  controlPlane: ReturnType<typeof env.OWNER_CONTROL_PLANE.getByName>,
  authority: OwnerAuthority,
  runId: string,
): Promise<Run> {
  return vi.waitFor(
    async () => {
      const inspected = await controlPlane.inspectRun(authority, { runId });

      if (!inspected.ok || !["cancelled", "completed", "failed"].includes(inspected.run.status)) {
        throw new Error("Expected a terminal session run.");
      }

      return inspected.run;
    },
    { interval: 25, timeout: 5_000 },
  );
}

describe("CrewAgent durable session directory", () => {
  it("creates, exactly continues, inspects, and deletes an isolated conversation", async () => {
    const authority = await authorityFor("crew-session-801");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("session-agent-801"));

    if (!created.ok) {
      throw new Error("Expected durable session fixture Agent.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    const firstPrompt = "Remember the project codename is Juniper.";
    const first = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-801-first",
      prompt: firstPrompt,
    });

    expect(first).toMatchObject({
      created: true,
      ok: true,
      run: { session: { branchRevision: 1 } },
    });

    if (!first.ok || first.run.session === undefined || first.continuation === undefined) {
      throw new Error("Expected first durable session run.");
    }

    await completedRun(controlPlane, authority, first.run.runId);
    const continued = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      continuation: first.continuation,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-801-second",
      prompt: "What codename did I give you?",
    });

    expect(continued).toMatchObject({
      ok: true,
      run: {
        session: {
          branchRevision: 2,
          sessionId: first.run.session.sessionId,
        },
      },
    });

    if (!continued.ok || continued.run.session === undefined) {
      throw new Error("Expected continued durable session run.");
    }

    await completedRun(controlPlane, authority, continued.run.runId);
    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        continuation: {
          branchId: first.run.session.branchId,
          expectedBranchRevision: 1,
          sessionId: first.run.session.sessionId,
        },
        expectedRevision: created.agent.revision,
        idempotencyKey: "session-run-801-stale",
        prompt: "This stale continuation must not run.",
      }),
    ).resolves.toEqual({
      error: { code: "branch_revision_conflict", message: "Run request denied." },
      ok: false,
    });

    const listed = await controlPlane.listAgentSessions(authority, {
      agentId: created.agent.id,
      limit: 10,
    });
    expect(listed).toMatchObject({
      nextCursor: null,
      ok: true,
      sessions: [
        {
          branchRevision: 2,
          sessionId: first.run.session.sessionId,
          status: "idle",
        },
      ],
    });

    const inspected = await controlPlane.inspectAgentSession(authority, {
      agentId: created.agent.id,
      sessionId: first.run.session.sessionId,
    });
    expect(inspected).toMatchObject({
      ok: true,
      session: { branchRevision: 2, sessionId: first.run.session.sessionId },
    });
    if (!inspected.ok) {
      throw new Error("Expected durable session inspection.");
    }
    expect(inspected.messages.map((message) => message.text).join(" ")).toContain(firstPrompt);

    const child = env.CREW_SESSION.getByName(
      crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: first.run.session.sessionId,
      }),
    );
    await runInDurableObject(child, async (instance, state) => {
      if (!(instance instanceof TestCrewSession)) {
        throw new Error("Expected test CrewSession implementation.");
      }

      const prompts = JSON.stringify(instance.modelCallsForTest());
      expect(prompts).toContain(firstPrompt);
      expect(prompts).toContain("What codename did I give you?");

      const stored = admittedRunRecordSchema.parse(
        await state.storage.get(`crewhelm:run:${continued.run.runId}`),
      );
      expect(stored.sessionContext).toMatchObject({
        truncated: false,
      });
      expect(stored.sessionContext?.characters).toBeLessThanOrEqual(
        MAXIMUM_SESSION_CONTEXT_CHARACTERS,
      );
      expect(JSON.stringify(stored.sessionContext?.messages)).toContain(firstPrompt);
      expect(stored.sessionContext?.digest).toBe(
        await digestRunPrompt(JSON.stringify(stored.sessionContext?.messages ?? [])),
      );
    });
    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, async (_instance, state) => {
      const indexes = Object.fromEntries(
        Array.from({ length: 1_001 }, () => [
          `crewhelm:session-run:${first.run.session!.sessionId}:run_${crypto.randomUUID()}`,
          true,
        ]),
      );
      await state.storage.put(indexes);
    });

    await expect(
      controlPlane.deleteAgentSession(authority, {
        agentId: created.agent.id,
        expectedBranchRevision: 1,
        idempotencyKey: "session-delete-801-stale",
        sessionId: first.run.session.sessionId,
      }),
    ).resolves.toMatchObject({ error: { code: "revision_conflict" }, ok: false });

    await expect(
      controlPlane.deleteAgentSession(
        { ...authority, scopes: [AGENTS_READ_SCOPE] },
        {
          agentId: created.agent.id,
          expectedBranchRevision: 2,
          idempotencyKey: "session-delete-801-read-only",
          sessionId: first.run.session.sessionId,
        },
      ),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });

    const deleted = await controlPlane.deleteAgentSession(authority, {
      agentId: created.agent.id,
      expectedBranchRevision: 2,
      idempotencyKey: "session-delete-801",
      sessionId: first.run.session.sessionId,
    });
    expect(deleted).toEqual({ deleted: true, ok: true, sessionId: first.run.session.sessionId });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT prompt FROM run_admissions WHERE run_id IN (?, ?) ORDER BY run_id",
            first.run.runId,
            continued.run.runId,
          )
          .toArray(),
      ),
    ).resolves.toEqual([{ prompt: null }, { prompt: null }]);
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT action, client_id, subject_id FROM audit_events WHERE action = 'session.deleted'",
          )
          .toArray(),
      ),
    ).resolves.toEqual([
      {
        action: "session.deleted",
        client_id: authority.clientId,
        subject_id: first.run.session.sessionId,
      },
    ]);
    await expect(
      controlPlane.agentInbox(authority, { action: "list", agentId: created.agent.id, limit: 10 }),
    ).resolves.toMatchObject({ items: [], ok: true });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_admissions SET prompt = 'simulated-lost-redaction' WHERE run_id IN (?, ?)",
        first.run.runId,
        continued.run.runId,
      );
    });
    await expect(
      controlPlane.deleteAgentSession(authority, {
        agentId: created.agent.id,
        expectedBranchRevision: 2,
        idempotencyKey: "session-delete-801",
        sessionId: first.run.session.sessionId,
      }),
    ).resolves.toEqual(deleted);
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT prompt FROM run_admissions WHERE run_id IN (?, ?) ORDER BY run_id",
            first.run.runId,
            continued.run.runId,
          )
          .toArray(),
      ),
    ).resolves.toEqual([{ prompt: null }, { prompt: null }]);
    await expect(
      controlPlane.inspectAgentSession(authority, {
        agentId: created.agent.id,
        sessionId: first.run.session.sessionId,
      }),
    ).resolves.toMatchObject({ error: { code: "session_not_found" }, ok: false });
  });

  it("keeps conversations independent and denies concurrent turns on one branch", async () => {
    const authority = await authorityFor("crew-session-802");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("session-agent-802"));

    if (!created.ok) {
      throw new Error("Expected durable session isolation fixture Agent.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    const slow = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-802-slow",
      prompt: SLOW_TEST_PROMPT,
    });

    if (!slow.ok || slow.run.session === undefined) {
      throw new Error("Expected slow durable session run.");
    }
    const slowSession = slow.run.session;

    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        continuation: {
          branchId: slowSession.branchId,
          expectedBranchRevision: slowSession.branchRevision,
          sessionId: slowSession.sessionId,
        },
        expectedRevision: created.agent.revision,
        idempotencyKey: "session-run-802-busy",
        prompt: "Do not race the active turn.",
      }),
    ).resolves.toEqual({
      error: { code: "session_busy", message: "Run request denied." },
      ok: false,
    });
    await expect(
      controlPlane.deleteAgentSession(authority, {
        agentId: created.agent.id,
        expectedBranchRevision: slowSession.branchRevision,
        idempotencyKey: "session-delete-802-busy",
        sessionId: slowSession.sessionId,
      }),
    ).resolves.toMatchObject({ error: { code: "session_busy" }, ok: false });

    const independent = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-802-independent",
      prompt: "Complete in a separate conversation.",
    });

    expect(independent).toMatchObject({ ok: true, run: { session: { branchRevision: 1 } } });
    if (!independent.ok || independent.run.session === undefined) {
      throw new Error("Expected independent durable session run.");
    }
    const independentSession = independent.run.session;
    await completedRun(controlPlane, authority, independent.run.runId);
    await completedRun(controlPlane, authority, slow.run.runId);

    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, async (_instance, state) => {
      const key = `crewhelm:session:${independentSession.sessionId}`;
      const record = await state.storage.get<Record<string, unknown>>(key);

      if (record === undefined) {
        throw new Error("Expected approval-waiting session directory record.");
      }

      await state.storage.put(key, { ...record, activeRunId: independent.run.runId });
    });
    const independentChild = env.CREW_SESSION.getByName(
      crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: independentSession.sessionId,
      }),
    );
    await runInDurableObject(independentChild, async (_instance, state) => {
      await state.storage.delete(`crewhelm:session-run-terminal:${independent.run.runId}`);
      await state.storage.put(
        `crewhelm:tool-approval:${independent.run.runId}:simulated-pending`,
        true,
      );
    });
    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        continuation: {
          branchId: independentSession.branchId,
          expectedBranchRevision: independentSession.branchRevision,
          sessionId: independentSession.sessionId,
        },
        expectedRevision: created.agent.revision,
        idempotencyKey: "session-run-802-approval-busy",
        prompt: "Do not continue while approval is pending.",
      }),
    ).resolves.toEqual({
      error: { code: "session_busy", message: "Run request denied." },
      ok: false,
    });
    await expect(
      controlPlane.deleteAgentSession(authority, {
        agentId: created.agent.id,
        expectedBranchRevision: independentSession.branchRevision,
        idempotencyKey: "session-delete-802-approval-busy",
        sessionId: independentSession.sessionId,
      }),
    ).resolves.toMatchObject({ error: { code: "session_busy" }, ok: false });
    await runInDurableObject(independentChild, async (_instance, state) => {
      await state.storage.delete(
        `crewhelm:tool-approval:${independent.run.runId}:simulated-pending`,
      );
      await state.storage.put(
        `crewhelm:session-run-terminal:${independent.run.runId}`,
        "completed",
      );
    });
    await runInDurableObject(parent, async (_instance, state) => {
      const key = `crewhelm:session:${slowSession.sessionId}`;
      const record = await state.storage.get<Record<string, unknown>>(key);

      if (record === undefined) {
        throw new Error("Expected retained session directory record.");
      }

      await state.storage.put(key, { ...record, activeRunId: slow.run.runId });
    });
    const recovered = await Promise.all(
      ["a", "b"].map((suffix) =>
        controlPlane.startRun(authority, {
          agentId: created.agent.id,
          continuation: {
            branchId: slowSession.branchId,
            expectedBranchRevision: slowSession.branchRevision,
            sessionId: slowSession.sessionId,
          },
          expectedRevision: created.agent.revision,
          idempotencyKey: `session-run-802-recovered-${suffix}`,
          prompt: `Continue after a missed completion callback (${suffix}).`,
        }),
      ),
    );
    expect(recovered.filter((result) => result.ok)).toHaveLength(1);
    expect(recovered).toContainEqual(
      expect.objectContaining({
        ok: true,
        run: expect.objectContaining({
          session: {
            branchRevision: 2,
            branchId: slowSession.branchId,
            sessionId: slowSession.sessionId,
          },
        }),
      }),
    );
    expect(recovered.find((result) => !result.ok)).toMatchObject({
      error: { code: expect.stringMatching(/branch_revision_conflict|session_busy/) },
      ok: false,
    });
  });

  it("rolls back an explicitly rejected session submission", async () => {
    const authority = await authorityFor("crew-session-rejected-803");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("session-agent-rejected-803"),
    );

    if (!created.ok) {
      throw new Error("Expected rejected session fixture Agent.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "session-run-rejected-803",
        prompt: REJECTED_SESSION_PROMPT,
      }),
    ).resolves.toEqual({
      error: { code: "run_unavailable", message: "Run request denied." },
      ok: false,
    });
    await expect(
      controlPlane.listAgentSessions(authority, { agentId: created.agent.id, limit: 10 }),
    ).resolves.toEqual({ nextCursor: null, ok: true, sessions: [] });
    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "session-run-after-rejection-803",
        prompt: "Start normally after the rejected submission.",
      }),
    ).resolves.toMatchObject({ ok: true, run: { session: { branchRevision: 1 } } });
  });

  it("reserves deletion before clearing the session runtime", async () => {
    const authority = await authorityFor("crew-session-delete-race-806");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("session-agent-delete-race-806"),
    );

    if (!created.ok) {
      throw new Error("Expected deletion race fixture Agent.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-delete-race-806",
      prompt: "Create a session for the deletion race.",
    });

    if (!started.ok || started.run.session === undefined) {
      throw new Error("Expected deletion race session.");
    }

    await completedRun(controlPlane, authority, started.run.runId);
    const child = env.CREW_SESSION.getByName(
      crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: started.run.session.sessionId,
      }),
    );
    await runInDurableObject(child, (instance) => {
      if (!(instance instanceof TestCrewSession)) {
        throw new Error("Expected deletion race CrewSession.");
      }

      instance.delayNextDeletionForTest();
    });
    const deletion = controlPlane.deleteAgentSession(authority, {
      agentId: created.agent.id,
      expectedBranchRevision: started.run.session.branchRevision,
      idempotencyKey: "session-delete-race-806",
      sessionId: started.run.session.sessionId,
    });
    await vi.waitFor(
      () =>
        runInDurableObject(child, (instance) => {
          if (!(instance instanceof TestCrewSession) || !instance.deletionWaitingForTest()) {
            throw new Error("Expected deletion to wait at the child boundary.");
          }
        }),
      { interval: 25, timeout: 5_000 },
    );
    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        continuation: {
          branchId: started.run.session.branchId,
          expectedBranchRevision: started.run.session.branchRevision,
          sessionId: started.run.session.sessionId,
        },
        expectedRevision: created.agent.revision,
        idempotencyKey: "session-run-delete-race-continuation-806",
        prompt: "Do not race an in-progress deletion.",
      }),
    ).resolves.toEqual({
      error: { code: "session_busy", message: "Run request denied." },
      ok: false,
    });
    await runInDurableObject(child, (instance) => {
      if (!(instance instanceof TestCrewSession)) {
        throw new Error("Expected deletion race CrewSession.");
      }

      instance.releaseDeletionForTest();
    });
    await expect(deletion).resolves.toEqual({
      deleted: true,
      ok: true,
      sessionId: started.run.session.sessionId,
    });
  });

  it("keeps an ambiguous deletion sealed until the exact retry finalizes it", async () => {
    const authority = await authorityFor("crew-session-delete-retry-807");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("session-agent-delete-retry-807"),
    );

    if (!created.ok) {
      throw new Error("Expected deletion retry fixture Agent.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-delete-retry-807",
      prompt: "Create a session for ambiguous deletion recovery.",
    });

    if (!started.ok || started.run.session === undefined) {
      throw new Error("Expected deletion retry session.");
    }

    await completedRun(controlPlane, authority, started.run.runId);
    const independent = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-delete-key-isolation-807",
      prompt: "Create another session to test deletion key isolation.",
    });

    if (!independent.ok || independent.run.session === undefined) {
      throw new Error("Expected deletion key isolation session.");
    }

    await completedRun(controlPlane, authority, independent.run.runId);
    const child = env.CREW_SESSION.getByName(
      crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: started.run.session.sessionId,
      }),
    );
    await runInDurableObject(child, (instance) => {
      if (!(instance instanceof TestCrewSession)) {
        throw new Error("Expected deletion retry CrewSession.");
      }

      instance.failNextDeletionResponseForTest();
    });

    const deletion = {
      agentId: created.agent.id,
      expectedBranchRevision: started.run.session.branchRevision,
      idempotencyKey: "session-delete-retry-807",
      sessionId: started.run.session.sessionId,
    };
    await expect(controlPlane.deleteAgentSession(authority, deletion)).resolves.toEqual({
      error: { code: "session_unavailable", message: "Session deletion denied." },
      ok: false,
    });
    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, async (instance, state) => {
      if (!(instance instanceof TestCrewAgent)) {
        throw new Error("Expected deletion retry CrewAgent.");
      }

      const key = `crewhelm:session:${started.run.session!.sessionId}`;
      const record = await state.storage.get<Record<string, unknown>>(key);

      if (record === undefined) {
        throw new Error("Expected sealed deletion record.");
      }

      await state.storage.put(key, { ...record, availableUntil: Date.now() - 1 });
      await instance.cleanupExpiredSessions();
    });
    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        continuation: {
          branchId: started.run.session.branchId,
          expectedBranchRevision: started.run.session.branchRevision,
          sessionId: started.run.session.sessionId,
        },
        expectedRevision: created.agent.revision,
        idempotencyKey: "session-run-after-ambiguous-delete-807",
        prompt: "The sealed session must not reopen empty.",
      }),
    ).resolves.toEqual({
      error: { code: "session_busy", message: "Run request denied." },
      ok: false,
    });
    await expect(
      controlPlane.deleteAgentSession(authority, {
        ...deletion,
        idempotencyKey: "session-delete-competing-807",
      }),
    ).resolves.toEqual({
      error: { code: "session_busy", message: "Session deletion denied." },
      ok: false,
    });
    await expect(
      controlPlane.deleteAgentSession(authority, {
        ...deletion,
        expectedBranchRevision: independent.run.session.branchRevision,
        sessionId: independent.run.session.sessionId,
      }),
    ).resolves.toEqual({
      error: { code: "invalid_request", message: "Session deletion denied." },
      ok: false,
    });
    await expect(
      controlPlane.inspectAgentSession(authority, {
        agentId: created.agent.id,
        sessionId: independent.run.session.sessionId,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(controlPlane.deleteAgentSession(authority, deletion)).resolves.toEqual({
      deleted: true,
      ok: true,
      sessionId: started.run.session.sessionId,
    });
    await expect(
      controlPlane.inspectAgentSession(authority, {
        agentId: created.agent.id,
        sessionId: started.run.session.sessionId,
      }),
    ).resolves.toMatchObject({ error: { code: "session_not_found" }, ok: false });
  });

  it("keeps the retained legacy runtime readable after session enablement", async () => {
    const authority = await authorityFor("crew-session-803");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("session-agent-803"));

    if (!created.ok) {
      throw new Error("Expected durable session migration fixture Agent.");
    }

    const legacy = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-803-legacy",
      prompt: "Complete on the retained Agent runtime.",
    });
    if (!legacy.ok) {
      throw new Error("Expected retained legacy run.");
    }
    await completedRun(controlPlane, authority, legacy.run.runId);
    await enableSessions(authority.ownerKey, created.agent.id);

    await expect(
      controlPlane.inspectRun(authority, { runId: legacy.run.runId }),
    ).resolves.toMatchObject({ ok: true, run: { runId: legacy.run.runId, status: "completed" } });
    const sessionRun = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-803-new",
      prompt: "Complete on the isolated session runtime.",
    });
    expect(sessionRun).toMatchObject({ ok: true, run: { session: { branchRevision: 1 } } });

    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, (instance) => {
      expect(instance).toBeInstanceOf(TestCrewAgent);
    });
  });

  it("retains transcript context after operational run cleanup", async () => {
    const authority = await authorityFor("crew-session-transcript-805");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("session-agent-transcript-805"),
    );

    if (!created.ok) {
      throw new Error("Expected transcript retention fixture Agent.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    const prompt = "Remember that the retained context marker is Sequoia.";
    const first = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-transcript-805",
      prompt,
    });

    if (!first.ok || first.run.session === undefined) {
      throw new Error("Expected transcript retention session.");
    }

    await completedRun(controlPlane, authority, first.run.runId);
    const child = env.CREW_SESSION.getByName(
      crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: first.run.session.sessionId,
      }),
    );
    await runInDurableObject(child, async (instance, state) => {
      if (!(instance instanceof TestCrewSession)) {
        throw new Error("Expected transcript retention CrewSession.");
      }

      const key = `crewhelm:run:${first.run.runId}`;
      const record = admittedRunRecordSchema.parse(await state.storage.get(key));
      await state.storage.put(key, { ...record, cleanupAt: Date.now() - 1 });
      await instance.cleanupAdmittedRun({ runId: first.run.runId });
    });
    const continued = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      continuation: {
        branchId: first.run.session.branchId,
        expectedBranchRevision: first.run.session.branchRevision,
        sessionId: first.run.session.sessionId,
      },
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-transcript-continued-805",
      prompt: "Which retained context marker did I provide?",
    });
    expect(continued).toMatchObject({ ok: true, run: { session: { branchRevision: 2 } } });
    await runInDurableObject(child, (instance) => {
      if (!(instance instanceof TestCrewSession)) {
        throw new Error("Expected transcript retention CrewSession.");
      }

      expect(JSON.stringify(instance.modelCallsForTest().at(-1)?.prompt)).toContain(prompt);
    });
  });

  it("removes expired idle sessions from discovery and runtime storage", async () => {
    const authority = await authorityFor("crew-session-804");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("session-agent-804"));

    if (!created.ok) {
      throw new Error("Expected durable session retention fixture Agent.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "session-run-804",
      prompt: "Create a session that will expire in the test.",
    });
    if (!started.ok || started.run.session === undefined) {
      throw new Error("Expected retained session run.");
    }
    await completedRun(controlPlane, authority, started.run.runId);

    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, async (_instance, state) => {
      const key = `crewhelm:session:${started.run.session?.sessionId}`;
      const record = await state.storage.get<Record<string, unknown>>(key);

      if (record === undefined) {
        throw new Error("Expected retained session directory record.");
      }

      await state.storage.put(key, { ...record, availableUntil: Date.now() - 1 });
    });

    await expect(
      controlPlane.listAgentSessions(authority, { agentId: created.agent.id, limit: 10 }),
    ).resolves.toEqual({ nextCursor: null, ok: true, sessions: [] });
    await expect(
      controlPlane.inspectAgentSession(authority, {
        agentId: created.agent.id,
        sessionId: started.run.session.sessionId,
      }),
    ).resolves.toMatchObject({ error: { code: "session_not_found" }, ok: false });
  });

  it("denies untracked or cross-directory Workflow entrypoints", async () => {
    const authority = await authorityFor("crew-workflow-boundary-806");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("workflow-boundary-agent"),
    );

    if (!created.ok) {
      throw new Error("Expected Workflow boundary Agent fixture.");
    }

    await enableSessions(authority.ownerKey, created.agent.id);
    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    const workflowId = "workflow_00000000-0000-4000-8000-000000000806";

    await runInDurableObject(parent, async (instance) => {
      if (!(instance instanceof TestCrewAgent)) {
        throw new Error("Expected Workflow boundary CrewAgent.");
      }

      await expect(
        instance.ensureAgentTaskWorkflow({
          agentId: created.agent.id,
          ownerKey: `${authority.ownerKey}-other`,
          stageCount: 2,
          workflowId,
        }),
      ).resolves.toBe(false);
      const callback = Reflect.get(instance, "_workflow_handleCallback");
      await expect(
        Reflect.apply(callback, instance, [
          {
            type: "complete",
            workflowId,
            workflowName: "AGENT_TASK_WORKFLOW",
          },
        ]),
      ).rejects.toThrow("CrewAgent workflow callback denied.");
    });
  });
});
