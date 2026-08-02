import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  crewAgentObjectName,
  crewSessionObjectName,
  ownerAuthoritySchema,
  type CreateAgentInput,
  type OwnerAuthority,
  type OutputContract,
  type Run,
} from "@crewhelm/contracts";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { workersAiCapabilityConfiguration } from "../../agent-capabilities/workers-ai.js";
import {
  JSON_OUTPUT_TEST_PROMPT,
  JSON_TEST_REPLY,
  SLOW_TEST_PROMPT,
  TestCrewAgent,
  TestCrewSession,
} from "../../agent/admitted-runs/test-agent.js";
import { admittedRunRecordSchema } from "../../agent/admitted-runs/schema.js";
import { deriveOwnerKey } from "../identity.js";

const workflowJsonOutputContract = {
  kind: "json",
  schema: {
    jsonSchema: {
      additionalProperties: false,
      properties: { answer: { minLength: 1, type: "string" } },
      required: ["answer"],
      type: "object",
    },
    name: "WorkflowAnswer",
    version: "1",
  },
} as const satisfies OutputContract;

async function authorityFor(subject: string): Promise<OwnerAuthority> {
  return ownerAuthoritySchema.parse({
    clientId: "https://workflow-client.example/mcp.json",
    ownerKey: await deriveOwnerKey({ issuer: "https://github.com", subject }),
    scopes: [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ],
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
    instructions: "Complete the exact admitted workflow stage concisely.",
    name: "Workflow fixture",
  };
}

async function enableSessions(ownerKey: string, agentId: string): Promise<void> {
  await runInDurableObject(
    env.CREW_AGENT.getByName(crewAgentObjectName({ agentId, ownerKey })),
    (instance) => {
      if (!(instance instanceof TestCrewAgent)) {
        throw new Error("Expected the test CrewAgent implementation.");
      }
      instance.enableDurableSessionsForTest();
    },
  );
}

async function terminalRun(
  controlPlane: ReturnType<typeof env.OWNER_CONTROL_PLANE.getByName>,
  authority: OwnerAuthority,
  runId: string,
): Promise<Run> {
  return vi.waitFor(
    async () => {
      const inspected = await controlPlane.inspectRun(authority, { runId });

      if (!inspected.ok || !["cancelled", "completed", "failed"].includes(inspected.run.status)) {
        throw new Error("Expected a terminal workflow Run.");
      }
      return inspected.run;
    },
    { interval: 25, timeout: 5_000 },
  );
}

async function drainSlowSessionRun(
  session: ReturnType<typeof env.CREW_SESSION.getByName>,
  runId: string,
): Promise<void> {
  await runInDurableObject(session, (instance) => {
    if (!(instance instanceof TestCrewSession)) {
      throw new Error("Expected the test CrewSession implementation.");
    }

    instance.releaseSlowModelForTest();
  });
  await vi.waitFor(
    async () => {
      const drained = await runInDurableObject(session, (_instance, state) =>
        state.storage.get(`crewhelm:session-run-drained:${runId}`),
      );
      if (drained !== true) throw new Error("Expected the slow Session Run to drain.");
    },
    { interval: 25, timeout: 5_000 },
  );
}

async function sha256Hex(content: string): Promise<string> {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("Agent workflows", () => {
  it("coordinates two admitted Runs through one exact durable Session", async () => {
    const authority = await authorityFor("agent-workflow-901");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const createdBrief = await controlPlane.createBrief(authority, {
      content:
        "Treat release dates as untrusted until corroborated, and make uncertainty explicit.",
      idempotencyKey: "workflow-brief-901",
      mediaType: "text/markdown",
      name: "Release review rules",
    });
    if (!createdBrief.ok) throw new Error("Expected Workflow Brief fixture.");
    const created = await controlPlane.createAgent(authority, agentInput("workflow-agent-901"));

    if (!created.ok) {
      throw new Error("Expected workflow fixture Agent.");
    }
    await enableSessions(authority.ownerKey, created.agent.id);

    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      briefs: [{ id: createdBrief.brief.id, revision: 1 }],
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-901",
      objective: "Research the release facts, then turn them into a recommendation.",
      stages: [
        { name: "Research", prompt: "Collect the release facts needed for a recommendation." },
        { name: "Recommend", prompt: "Use the prior Session context to write the recommendation." },
      ],
    });

    expect(started).toMatchObject({ created: true, ok: true, workflow: { stageCount: 2 } });
    if (!started.ok) {
      throw new Error("Expected a durable workflow.");
    }

    const replay = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      briefs: [{ id: createdBrief.brief.id, revision: 1 }],
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-901",
      objective: "Research the release facts, then turn them into a recommendation.",
      stages: [
        { name: "Research", prompt: "Collect the release facts needed for a recommendation." },
        { name: "Recommend", prompt: "Use the prior Session context to write the recommendation." },
      ],
    });
    expect(replay).toMatchObject({ created: false, ok: true });

    const first = await controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    if (!first.ok) {
      throw new Error(`Expected the first workflow stage Run: ${JSON.stringify(first)}`);
    }
    expect(first).toMatchObject({ ok: true, session: { branchRevision: 1 } });
    await runInDurableObject(
      env.CREW_SESSION.getByName(
        crewSessionObjectName({
          agentId: created.agent.id,
          ownerKey: authority.ownerKey,
          sessionId: first.session.sessionId,
        }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewSession)) throw new Error("Expected test CrewSession.");
        expect(JSON.stringify(instance.modelCallsForTest())).toContain(
          "Workflow objective:\\nResearch the release facts, then turn them into a recommendation.",
        );
        expect(JSON.stringify(instance.modelCallsForTest())).toContain(
          "Treat release dates as untrusted until corroborated",
        );
      },
    );
    const listed = await controlPlane.listAgentWorkflows(authority, {});
    expect(listed).toMatchObject({
      ok: true,
      workflows: [{ workflowId: started.workflow.workflowId }],
    });
    if (!listed.ok) throw new Error("Expected compact Workflow list.");
    expect(listed.workflows[0]).not.toHaveProperty("objective");
    expect(listed.workflows[0]).not.toHaveProperty("objectivePreview");
    await expect(
      controlPlane.markAgentWorkflowStageWaiting({
        agentId: created.agent.id,
        runId: first.runId,
        stageIndex: 0,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toBe(true);
    const waiting = await controlPlane.inspectAgentWorkflow(authority, {
      workflowId: started.workflow.workflowId,
    });
    expect(waiting).toMatchObject({
      ok: true,
      workflow: {
        completedStages: 0,
        currentStage: { index: 0, status: "waiting" },
        status: "waiting",
      },
    });
    await terminalRun(controlPlane, authority, first.runId);
    await expect(
      controlPlane.completeAgentWorkflowStage({
        agentId: created.agent.id,
        runId: first.runId,
        stageIndex: 0,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({ ok: true, status: "completed", workflowStatus: "running" });

    await expect(
      controlPlane.listAgentSessions(authority, { agentId: created.agent.id, limit: 10 }),
    ).resolves.toEqual({ nextCursor: null, ok: true, sessions: [] });
    await expect(
      controlPlane.startRun(authority, {
        agentId: created.agent.id,
        continuation: {
          branchId: first.session.branchId,
          expectedBranchRevision: first.session.branchRevision,
          sessionId: first.session.sessionId,
        },
        expectedRevision: created.agent.revision,
        idempotencyKey: "workflow-session-manual-continuation-901",
        prompt: "This manual Run must not enter the Workflow-owned Session.",
      }),
    ).resolves.toMatchObject({ error: { code: "session_not_found" }, ok: false });
    await expect(
      controlPlane.deleteAgentSession(authority, {
        agentId: created.agent.id,
        expectedBranchRevision: first.session.branchRevision,
        idempotencyKey: "workflow-session-manual-delete-901",
        sessionId: first.session.sessionId,
      }),
    ).resolves.toMatchObject({ error: { code: "session_not_found" }, ok: false });

    const second = await controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 1,
      workflowId: started.workflow.workflowId,
    });
    expect(second).toMatchObject({
      ok: true,
      session: { branchRevision: 2, sessionId: first.session.sessionId },
    });
    if (!second.ok) {
      throw new Error("Expected the second workflow stage Run.");
    }
    const finalRun = await terminalRun(controlPlane, authority, second.runId);
    const completion = {
      agentId: created.agent.id,
      runId: second.runId,
      stageIndex: 1,
      workflowId: started.workflow.workflowId,
    };
    await expect(controlPlane.completeAgentWorkflowStage(completion)).resolves.toMatchObject({
      ok: true,
      status: "completed",
      workflowStatus: "completed",
    });
    await expect(controlPlane.completeAgentWorkflowStage(completion)).resolves.toMatchObject({
      ok: true,
      status: "completed",
      workflowStatus: "completed",
    });

    const completedWorkflow = await controlPlane.inspectAgentWorkflow(authority, {
      workflowId: started.workflow.workflowId,
    });
    expect(completedWorkflow).toMatchObject({
      ok: true,
      workflow: {
        completedStages: 2,
        briefs: [{ id: createdBrief.brief.id, revision: 1 }],
        deliverable: {
          runId: second.runId,
          stageIndex: 1,
        },
        session: { branchRevision: 2, sessionId: first.session.sessionId },
        stages: [
          { index: 0, name: "Research", status: "completed" },
          { index: 1, name: "Recommend", status: "completed" },
        ],
        status: "completed",
      },
    });
    if (!completedWorkflow.ok) throw new Error("Expected completed Workflow.");
    expect(completedWorkflow.workflow).not.toHaveProperty("deliverableContent");
    await expect(
      controlPlane.inspectAgentWorkflow(authority, {
        includeDeliverable: true,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { deliverableContent: finalRun.output },
    });
    await expect(
      controlPlane.listAgentRuns(authority, {
        agentId: created.agent.id,
        trigger: "workflow",
      }),
    ).resolves.toMatchObject({
      ok: true,
      runs: [{ trigger: "workflow" }, { trigger: "workflow" }],
    });
  });

  it("applies a frozen JSON contract only to the final Workflow deliverable", async () => {
    const authority = await authorityFor("agent-workflow-json");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("workflow-json-agent"));
    if (!created.ok) throw new Error("Expected typed Workflow Agent.");
    await enableSessions(authority.ownerKey, created.agent.id);

    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-json-start",
      objective: "Prepare one typed final recommendation.",
      outputContract: workflowJsonOutputContract,
      stages: [
        { name: "Prepare", prompt: "Prepare the facts in ordinary prose." },
        { name: "Deliver", prompt: JSON_OUTPUT_TEST_PROMPT },
      ],
    });
    if (!started.ok) throw new Error("Expected typed Workflow.");

    const first = await controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    if (!first.ok) throw new Error("Expected first typed Workflow stage.");
    const firstRun = await terminalRun(controlPlane, authority, first.runId);
    expect(firstRun).toHaveProperty("output");
    await controlPlane.completeAgentWorkflowStage({
      agentId: created.agent.id,
      runId: first.runId,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });

    const second = await controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 1,
      workflowId: started.workflow.workflowId,
    });
    if (!second.ok) throw new Error("Expected final typed Workflow stage.");
    const secondRun = await terminalRun(controlPlane, authority, second.runId);
    expect(secondRun).toMatchObject({
      deliverable: { kind: "json", state: "valid" },
      status: "completed",
    });
    expect(secondRun).not.toHaveProperty("output");
    await controlPlane.completeAgentWorkflowStage({
      agentId: created.agent.id,
      runId: second.runId,
      stageIndex: 1,
      workflowId: started.workflow.workflowId,
    });

    const compact = await controlPlane.inspectAgentWorkflow(authority, {
      workflowId: started.workflow.workflowId,
    });
    expect(compact).toMatchObject({
      ok: true,
      workflow: {
        deliverable: {
          kind: "json",
          mediaType: "application/json",
          schema: { name: "WorkflowAnswer", version: "1" },
        },
        outputContract: {
          kind: "json",
          schema: { name: "WorkflowAnswer", version: "1" },
        },
        status: "completed",
      },
    });
    if (!compact.ok) throw new Error("Expected compact typed Workflow inspection.");
    expect(compact.workflow).not.toHaveProperty("deliverableContent");
    expect(compact.workflow).not.toHaveProperty("outputContractDetail");

    await expect(
      controlPlane.inspectAgentWorkflow(authority, {
        includeDeliverable: true,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: {
        deliverableContent: JSON.parse(JSON_TEST_REPLY),
        outputContractDetail: { kind: "json", schema: { jsonSchema: expect.any(Object) } },
      },
    });
  });

  it("fails closed when frozen Workflow Brief content becomes unavailable", async () => {
    const authority = await authorityFor("agent-workflow-brief-missing");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const brief = await controlPlane.createBrief(authority, {
      content: "This exact context must remain available for every stage.",
      idempotencyKey: "workflow-brief-missing",
      mediaType: "text/plain",
      name: "Required context",
    });
    const agent = await controlPlane.createAgent(
      authority,
      agentInput("workflow-brief-missing-agent"),
    );
    if (!brief.ok || !agent.ok) throw new Error("Expected missing Brief fixtures.");
    const plan = {
      agentId: agent.agent.id,
      briefs: [{ id: brief.brief.id, revision: 1 }],
      expectedRevision: agent.agent.revision,
      idempotencyKey: "workflow-brief-missing-plan",
      objective: "Use only the frozen context.",
      stages: [
        { name: "One", prompt: "Use the required context." },
        { name: "Two", prompt: "Finish from the same context." },
      ],
    };
    const started = await controlPlane.startAgentWorkflow(authority, plan);
    if (!started.ok) throw new Error("Expected missing Brief Workflow.");

    await env.SKILL_PACKAGES.delete(`briefs/${authority.ownerKey}/${brief.brief.id}/1`);
    await expect(controlPlane.startAgentWorkflow(authority, plan)).resolves.toMatchObject({
      created: false,
      ok: true,
      workflow: { workflowId: started.workflow.workflowId },
    });
    await expect(
      controlPlane.dispatchAgentWorkflowStage({
        agentId: agent.agent.id,
        stageIndex: 0,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({ error: { code: "brief_unavailable" }, ok: false });
    await expect(
      controlPlane.inspectAgentWorkflow(authority, {
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: {
        failure: { code: "brief_unavailable", nextAction: "inspect_workflow", stageIndex: 0 },
        status: "failed",
      },
    });
  });

  it("recovers an uploaded deliverable when final Workflow attachment is interrupted", async () => {
    const authority = await authorityFor("agent-workflow-deliverable-intent");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("workflow-deliverable-intent-agent"),
    );
    if (!created.ok) throw new Error("Expected deliverable recovery Agent fixture.");
    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-deliverable-intent",
      objective: "Recover an interrupted final artifact commit.",
      stages: [
        { name: "One", prompt: "Prepare the source." },
        { name: "Two", prompt: "Produce the final artifact." },
      ],
    });
    if (!started.ok) throw new Error("Expected deliverable recovery Workflow fixture.");

    const content = "Unattached final output.";
    const digest = await sha256Hex(content);
    const objectKey = `deliverables/${authority.ownerKey}/${started.workflow.workflowId}`;
    const deliverable = {
      artifactId: started.workflow.workflowId.replace("workflow_", "artifact_"),
      createdAt: new Date().toISOString(),
      digest,
      mediaType: "text/markdown" as const,
      runId: "run_00000000-0000-4000-8000-000000000999",
      sizeBytes: new TextEncoder().encode(content).byteLength,
      stageIndex: 1,
      truncated: false,
    };
    await env.SKILL_PACKAGES.put(objectKey, content, {
      customMetadata: { digest, mediaType: "text/markdown" },
      sha256: digest,
    });
    await runInDurableObject(controlPlane, async (_instance, state) => {
      await state.storage.put(
        `crewhelm:agent-workflow-deliverable:${started.workflow.workflowId}`,
        {
          deliverable,
          objectKey,
          recoverAfter: 1,
          workflowId: started.workflow.workflowId,
        },
      );
    });

    await runInDurableObject(controlPlane, (instance) => instance.alarm());
    await expect(env.SKILL_PACKAGES.head(objectKey)).resolves.toBeNull();
    await runInDurableObject(controlPlane, async (_instance, state) => {
      await expect(
        state.storage.get(`crewhelm:agent-workflow-deliverable:${started.workflow.workflowId}`),
      ).resolves.toBeUndefined();
    });
  });

  it("denies stale plans and supports revision-bound cancellation and deletion", async () => {
    const authority = await authorityFor("agent-workflow-902");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("workflow-agent-902"));

    if (!created.ok) {
      throw new Error("Expected workflow fixture Agent.");
    }

    await expect(
      controlPlane.startAgentWorkflow(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision + 1,
        idempotencyKey: "workflow-stale-902",
        objective: "This stale plan must not run.",
        stages: [
          { name: "One", prompt: "First stage." },
          { name: "Two", prompt: "Second stage." },
        ],
      }),
    ).resolves.toMatchObject({ error: { code: "revision_conflict" }, ok: false });

    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-cancel-902",
      objective: "Create a cancellable queued workflow.",
      stages: [
        { name: "One", prompt: "First stage." },
        { name: "Two", prompt: "Second stage." },
      ],
    });
    if (!started.ok) {
      throw new Error("Expected cancellable workflow.");
    }

    const cancelled = await controlPlane.cancelAgentWorkflow(authority, {
      expectedRevision: started.workflow.revision,
      workflowId: started.workflow.workflowId,
    });
    expect(cancelled).toMatchObject({
      cancelled: true,
      ok: true,
      workflow: { status: "cancelled" },
    });
    if (!cancelled.ok) {
      throw new Error("Expected cancelled workflow.");
    }

    await runInDurableObject(controlPlane, (_instance, state) =>
      state.storage.put(`crewhelm:agent-workflow-deletion:${started.workflow.workflowId}`, {
        clientId: authority.clientId,
        expectedRevision: cancelled.workflow.revision,
        idempotencyKey: "delete-workflow-902",
        workflowId: started.workflow.workflowId,
      }),
    );
    await expect(
      controlPlane.deleteAgentWorkflow(authority, {
        expectedRevision: cancelled.workflow.revision,
        idempotencyKey: "different-delete-workflow-902",
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({ error: { code: "workflow_busy" }, ok: false });

    const deleted = await controlPlane.deleteAgentWorkflow(authority, {
      expectedRevision: cancelled.workflow.revision,
      idempotencyKey: "delete-workflow-902",
      workflowId: started.workflow.workflowId,
    });
    expect(deleted).toEqual({ deleted: true, ok: true, workflowId: started.workflow.workflowId });
    await expect(
      controlPlane.deleteAgentWorkflow(authority, {
        expectedRevision: cancelled.workflow.revision,
        idempotencyKey: "delete-workflow-902",
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toEqual(deleted);
    await expect(
      controlPlane.startAgentWorkflow(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "workflow-cancel-902",
        objective: "Create a cancellable queued workflow.",
        stages: [
          { name: "One", prompt: "First stage." },
          { name: "Two", prompt: "Second stage." },
        ],
      }),
    ).resolves.toMatchObject({ error: { code: "workflow_deleted" }, ok: false });
    await expect(
      controlPlane.startAgentWorkflow(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "workflow-cancel-902",
        objective: "A conflicting replay must stay denied.",
        stages: [
          { name: "One", prompt: "First stage." },
          { name: "Two", prompt: "Second stage." },
        ],
      }),
    ).resolves.toMatchObject({ error: { code: "idempotency_conflict" }, ok: false });
  });

  it("fails closed when the durable coordinator reports an error", async () => {
    const authority = await authorityFor("agent-workflow-903");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("workflow-agent-903"));

    if (!created.ok) {
      throw new Error("Expected workflow fixture Agent.");
    }

    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-failure-903",
      objective: "Do not advance after coordinator failure.",
      stages: [
        { name: "One", prompt: "First stage." },
        { name: "Two", prompt: "Second stage." },
      ],
    });
    if (!started.ok) {
      throw new Error("Expected workflow failure fixture.");
    }

    await expect(
      controlPlane.failAgentWorkflowRuntime({
        agentId: created.agent.id,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toBe(true);
    const failed = await controlPlane.inspectAgentWorkflow(authority, {
      workflowId: started.workflow.workflowId,
    });
    expect(failed).toMatchObject({
      ok: true,
      workflow: {
        failure: {
          code: "coordinator_failed",
          nextAction: "inspect_workflow",
          stageIndex: 0,
        },
        status: "failed",
      },
    });
    if (!failed.ok) throw new Error("Expected failed Workflow projection.");
    expect(failed.workflow.stages[0]).toMatchObject({ index: 0, status: "failed" });
    await expect(
      controlPlane.dispatchAgentWorkflowStage({
        agentId: created.agent.id,
        stageIndex: 0,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({ error: { code: "workflow_busy" }, ok: false });
  });

  it("cancels a Run admitted concurrently with Workflow cancellation", async () => {
    const authority = await authorityFor("agent-workflow-race-904");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("workflow-agent-904"));
    if (!created.ok) throw new Error("Expected workflow race Agent fixture.");
    await enableSessions(authority.ownerKey, created.agent.id);

    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, (instance) => {
      if (!(instance instanceof TestCrewAgent)) throw new Error("Expected test CrewAgent.");
      instance.delayNextAdmissionForTest(100);
    });
    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-race-904",
      objective: "Cancel without leaving a detached Run.",
      stages: [
        { name: "One", prompt: SLOW_TEST_PROMPT },
        { name: "Two", prompt: "Must never start." },
      ],
    });
    if (!started.ok) throw new Error("Expected workflow race fixture.");

    const dispatch = controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    const reserved = await vi.waitFor(async () => {
      const listed = await controlPlane.listAgentWorkflows(authority, {
        agentId: created.agent.id,
      });
      const workflow = listed.ok
        ? listed.workflows.find((item) => item.workflowId === started.workflow.workflowId)
        : undefined;
      if (workflow?.currentStage?.index !== 0) {
        throw new Error("Expected the stage admission reservation.");
      }
      return workflow;
    });
    await expect(
      controlPlane.cancelAgentWorkflow(authority, {
        expectedRevision: reserved.revision,
        workflowId: reserved.workflowId,
      }),
    ).resolves.toMatchObject({ cancelled: false, ok: true, workflow: { status: "cancelling" } });

    const admitted = await dispatch;
    expect(admitted).toMatchObject({ ok: true });
    if (!admitted.ok) throw new Error("Expected the racing Run to be durably correlated.");
    await terminalRun(controlPlane, authority, admitted.runId);
    await expect(
      controlPlane.completeAgentWorkflowStage({
        agentId: created.agent.id,
        runId: admitted.runId,
        stageIndex: 0,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({ ok: true, workflowStatus: "cancelled" });
    await vi.waitFor(async () => {
      const inspected = await controlPlane.inspectAgentWorkflow(authority, {
        workflowId: started.workflow.workflowId,
      });
      expect(inspected).toMatchObject({
        ok: true,
        workflow: { stageCount: 2, status: "cancelled" },
      });
    });
    await expect(
      controlPlane.listAgentRuns(authority, {
        agentId: created.agent.id,
        trigger: "workflow",
      }),
    ).resolves.toMatchObject({ ok: true, runs: [{ runId: admitted.runId, status: "cancelled" }] });
  });

  it("preserves the shared Run when a reserved stage is dispatched concurrently", async () => {
    const authority = await authorityFor("agent-workflow-dispatch-replay-908");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("workflow-agent-dispatch-replay-908"),
    );
    if (!created.ok) throw new Error("Expected concurrent dispatch Agent fixture.");
    await enableSessions(authority.ownerKey, created.agent.id);

    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, (instance) => {
      if (!(instance instanceof TestCrewAgent)) throw new Error("Expected test CrewAgent.");
      instance.delayNextAdmissionForTest(100);
    });
    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-dispatch-replay-908",
      objective: "Replay one exact reserved stage without cancelling its shared Run.",
      stages: [
        { name: "One", prompt: SLOW_TEST_PROMPT },
        { name: "Two", prompt: "Continue only after the shared Run completes." },
      ],
    });
    if (!started.ok) throw new Error("Expected concurrent dispatch Workflow fixture.");

    const first = controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    await vi.waitFor(async () => {
      const listed = await controlPlane.listAgentWorkflows(authority, {
        agentId: created.agent.id,
      });
      const workflow = listed.ok
        ? listed.workflows.find((item) => item.workflowId === started.workflow.workflowId)
        : undefined;
      expect(workflow?.currentStage).toMatchObject({ index: 0, runId: null });
    });
    const second = controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    if (!firstResult.ok || !secondResult.ok) {
      throw new Error("Expected exact concurrent dispatch replay.");
    }
    expect(secondResult.runId).toBe(firstResult.runId);
    expect(secondResult.session).toEqual(firstResult.session);
    await runInDurableObject(parent, (instance) => {
      if (!(instance instanceof TestCrewAgent)) throw new Error("Expected test CrewAgent.");
      expect(instance.cancellationCountForTest()).toBe(0);
    });
    await expect(
      controlPlane.inspectRun(authority, { runId: firstResult.runId }),
    ).resolves.not.toMatchObject({ ok: true, run: { status: "cancelled" } });
  });

  it("recovers a sealed deletion after the Session response is lost", async () => {
    const authority = await authorityFor("agent-workflow-delete-recovery-905");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("workflow-agent-905"));
    if (!created.ok) throw new Error("Expected deletion recovery Agent fixture.");
    const brief = await controlPlane.createBrief(authority, {
      content: "Erase this Workflow context before releasing its owner reference.",
      idempotencyKey: "workflow-delete-recovery-brief-905",
      mediaType: "text/plain",
      name: "Deletion recovery",
    });
    if (!brief.ok) throw new Error("Expected deletion recovery Brief fixture.");
    await enableSessions(authority.ownerKey, created.agent.id);

    const plan = {
      agentId: created.agent.id,
      briefs: [{ id: brief.brief.id, revision: 1 }],
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-delete-recovery-905",
      objective: "Retain a deletion receipt without retaining the Workflow.",
      stages: [
        { name: "One", prompt: "Complete the first stage." },
        { name: "Two", prompt: "Complete the second stage." },
      ],
    };
    const started = await controlPlane.startAgentWorkflow(authority, plan);
    if (!started.ok) throw new Error("Expected deletion recovery Workflow fixture.");

    let sessionId: string | undefined;
    for (const stageIndex of [0, 1]) {
      const dispatched = await controlPlane.dispatchAgentWorkflowStage({
        agentId: created.agent.id,
        stageIndex,
        workflowId: started.workflow.workflowId,
      });
      if (!dispatched.ok) throw new Error("Expected deletion recovery stage Run.");
      sessionId = dispatched.session.sessionId;
      await terminalRun(controlPlane, authority, dispatched.runId);
      await controlPlane.completeAgentWorkflowStage({
        agentId: created.agent.id,
        runId: dispatched.runId,
        stageIndex,
        workflowId: started.workflow.workflowId,
      });
    }
    if (sessionId === undefined) throw new Error("Expected Workflow-owned Session.");
    const terminal = await controlPlane.inspectAgentWorkflow(authority, {
      workflowId: started.workflow.workflowId,
    });
    if (!terminal.ok) throw new Error("Expected terminal Workflow.");
    const deliverableObjectKey = `deliverables/${authority.ownerKey}/${started.workflow.workflowId}`;
    await expect(env.SKILL_PACKAGES.head(deliverableObjectKey)).resolves.not.toBeNull();

    await runInDurableObject(
      env.CREW_SESSION.getByName(
        crewSessionObjectName({
          agentId: created.agent.id,
          ownerKey: authority.ownerKey,
          sessionId,
        }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewSession)) throw new Error("Expected test CrewSession.");
        instance.failNextDeletionResponseForTest();
      },
    );
    const deletion = {
      expectedRevision: terminal.workflow.revision,
      idempotencyKey: "delete-workflow-recovery-905",
      workflowId: started.workflow.workflowId,
    };
    await expect(controlPlane.deleteAgentWorkflow(authority, deletion)).resolves.toMatchObject({
      error: { code: "workflow_unavailable" },
      ok: false,
    });

    await runInDurableObject(controlPlane, (instance) => instance.alarm());
    await expect(
      controlPlane.inspectAgentWorkflow(authority, { workflowId: started.workflow.workflowId }),
    ).resolves.toMatchObject({ error: { code: "workflow_not_found" }, ok: false });
    await expect(env.SKILL_PACKAGES.head(deliverableObjectKey)).resolves.toBeNull();
    await expect(controlPlane.deleteAgentWorkflow(authority, deletion)).resolves.toEqual({
      deleted: true,
      ok: true,
      workflowId: started.workflow.workflowId,
    });
    await expect(controlPlane.startAgentWorkflow(authority, plan)).resolves.toMatchObject({
      error: { code: "workflow_deleted" },
      ok: false,
    });
    await expect(
      controlPlane.deleteBrief(authority, {
        expectedRevision: 1,
        id: brief.brief.id,
        idempotencyKey: "workflow-delete-recovery-brief-delete-905",
      }),
    ).resolves.toMatchObject({ deleted: true, ok: true });
  });

  it("reconciles a terminal Run when cancellation races its completion callback", async () => {
    const authority = await authorityFor("agent-workflow-terminal-cancel-905");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("workflow-agent-terminal-cancel-905"),
    );
    if (!created.ok) throw new Error("Expected workflow terminal cancellation Agent fixture.");
    await enableSessions(authority.ownerKey, created.agent.id);

    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-terminal-cancel-905",
      objective: "Cancel cleanly after the Run becomes terminal.",
      stages: [
        { name: "One", prompt: SLOW_TEST_PROMPT },
        { name: "Two", prompt: "Must never start." },
      ],
    });
    if (!started.ok) throw new Error("Expected terminal cancellation Workflow fixture.");

    const admitted = await controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    if (!admitted.ok) throw new Error("Expected terminal cancellation Run fixture.");
    await runInDurableObject(
      env.CREW_SESSION.getByName(
        crewSessionObjectName({
          agentId: created.agent.id,
          ownerKey: authority.ownerKey,
          sessionId: admitted.session.sessionId,
        }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewSession)) throw new Error("Expected test CrewSession.");
        instance.completeBeforeNextCancellationForTest();
      },
    );

    const current = await controlPlane.inspectAgentWorkflow(authority, {
      workflowId: started.workflow.workflowId,
    });
    if (!current.ok) throw new Error("Expected terminal cancellation Workflow projection.");
    const cancelled = await controlPlane.cancelAgentWorkflow(authority, {
      expectedRevision: current.workflow.revision,
      workflowId: current.workflow.workflowId,
    });
    expect(cancelled).toMatchObject({
      cancelled: true,
      ok: true,
      workflow: { currentRunId: null, status: "cancelled" },
    });
    if (!cancelled.ok) throw new Error("Expected reconciled Workflow cancellation.");
    await expect(
      controlPlane.deleteAgentWorkflow(authority, {
        expectedRevision: cancelled.workflow.revision,
        idempotencyKey: "workflow-terminal-cancel-delete-905",
        workflowId: cancelled.workflow.workflowId,
      }),
    ).resolves.toMatchObject({ deleted: true, ok: true });
  });

  it("delivers a durable Workflow event when a Session Run reaches its deadline", async () => {
    const authority = await authorityFor("agent-workflow-deadline-906");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("workflow-agent-906"));
    if (!created.ok) throw new Error("Expected Workflow deadline Agent fixture.");
    await enableSessions(authority.ownerKey, created.agent.id);

    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-deadline-906",
      objective: "Converge durably when a stage exceeds its wall-clock deadline.",
      stages: [
        { name: "One", prompt: SLOW_TEST_PROMPT },
        { name: "Two", prompt: "Must never start." },
      ],
    });
    if (!started.ok) throw new Error("Expected Workflow deadline fixture.");
    const dispatched = await controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    if (!dispatched.ok) throw new Error("Expected Workflow deadline Run fixture.");

    const session = env.CREW_SESSION.getByName(
      crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: dispatched.session.sessionId,
      }),
    );
    await vi.waitFor(async () => {
      await expect(
        controlPlane.inspectRun(authority, { runId: dispatched.runId }),
      ).resolves.toMatchObject({ ok: true, run: { status: "running" } });
    });
    await runInDurableObject(session, async (_instance, state) => {
      const key = `crewhelm:run:${dispatched.runId}`;
      const record = admittedRunRecordSchema.parse(await state.storage.get(key));
      await state.storage.put(key, { ...record, deadlineAt: 1 });
      state.storage.sql.exec(
        "DELETE FROM cf_agents_schedules WHERE callback = '_drainThinkSubmissions'",
      );
      state.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = 0 WHERE callback = 'expireAdmittedRun'",
      );
    });
    await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
    await expect(
      controlPlane.inspectRun(authority, { runId: dispatched.runId }),
    ).resolves.toMatchObject({ ok: true, run: { status: "cancelled" } });

    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, async (_instance, state) => {
      await expect(
        state.storage.get(`crewhelm:agent-workflow-run:${dispatched.runId}`),
      ).resolves.toMatchObject({ terminalStatus: "cancelled" });
    });
    await expect(
      controlPlane.completeAgentWorkflowStage({
        agentId: created.agent.id,
        runId: dispatched.runId,
        stageIndex: 0,
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({ ok: true, workflowStatus: "cancelled" });
  });

  it("reconciles a committed Session terminal marker during exact inspection", async () => {
    const authority = await authorityFor("agent-workflow-terminal-replay-907");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("workflow-agent-terminal-replay-907"),
    );
    if (!created.ok) throw new Error("Expected Workflow terminal replay Agent fixture.");
    await enableSessions(authority.ownerKey, created.agent.id);

    const started = await controlPlane.startAgentWorkflow(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-terminal-replay-907",
      objective: "Replay a child terminal commit after its parent callback is lost.",
      stages: [
        { name: "One", prompt: SLOW_TEST_PROMPT },
        { name: "Two", prompt: "Must never start." },
      ],
    });
    if (!started.ok) throw new Error("Expected Workflow terminal replay fixture.");
    const dispatched = await controlPlane.dispatchAgentWorkflowStage({
      agentId: created.agent.id,
      stageIndex: 0,
      workflowId: started.workflow.workflowId,
    });
    if (!dispatched.ok) throw new Error("Expected Workflow terminal replay Run fixture.");

    const session = env.CREW_SESSION.getByName(
      crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: dispatched.session.sessionId,
      }),
    );
    await vi.waitFor(async () => {
      await expect(
        controlPlane.inspectRun(authority, { runId: dispatched.runId }),
      ).resolves.toMatchObject({ ok: true, run: { status: "running" } });
    });
    await runInDurableObject(session, async (_instance, state) => {
      const key = `crewhelm:run:${dispatched.runId}`;
      const record = admittedRunRecordSchema.parse(await state.storage.get(key));
      await state.storage.put(key, { ...record, deadlineAt: 1 });
      await state.storage.put(`crewhelm:session-run-terminal:${dispatched.runId}`, "completed");
      state.storage.sql.exec(
        "DELETE FROM cf_agents_schedules WHERE callback = '_drainThinkSubmissions'",
      );
      state.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = 0 WHERE callback = 'expireAdmittedRun'",
      );
    });

    await expect(runDurableObjectAlarm(controlPlane)).resolves.toBe(true);
    await expect(
      controlPlane.listAgentWorkflows(authority, { agentId: created.agent.id }),
    ).resolves.toMatchObject({
      ok: true,
      workflows: [
        {
          completedStages: 1,
          currentStage: { index: 1, status: "running" },
          status: "running",
          workflowId: started.workflow.workflowId,
        },
      ],
    });

    await expect(
      controlPlane.inspectAgentWorkflow(authority, {
        workflowId: started.workflow.workflowId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: {
        completedStages: 1,
        currentStage: { index: 1, status: "running" },
        status: "running",
      },
    });
    await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
    const parent = env.CREW_AGENT.getByName(
      crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
    );
    await runInDurableObject(parent, async (_instance, state) => {
      await expect(
        state.storage.get(`crewhelm:agent-workflow-run:${dispatched.runId}`),
      ).resolves.toMatchObject({ terminalStatus: "completed" });
    });
  });

  it.each([
    ["succeeds", false],
    ["fails", true],
  ])(
    "deletes a terminal Workflow after its Session cancellation %s and fully drains",
    async (cancellationOutcome, failCancellation) => {
      const authority = await authorityFor(
        `agent-workflow-expired-session-delete-${cancellationOutcome}`,
      );
      const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
      const created = await controlPlane.createAgent(
        authority,
        agentInput(`workflow-agent-expired-session-delete-${cancellationOutcome}`),
      );
      if (!created.ok) throw new Error("Expected expired Session deletion Agent.");
      await enableSessions(authority.ownerKey, created.agent.id);

      const started = await controlPlane.startAgentWorkflow(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: `workflow-expired-session-delete-${cancellationOutcome}`,
        objective: "Delete an expired Workflow Session after owner cancellation recovery.",
        stages: [
          { name: "One", prompt: SLOW_TEST_PROMPT },
          { name: "Two", prompt: "Must never start." },
        ],
      });
      if (!started.ok) throw new Error("Expected expired Session deletion Workflow.");
      const dispatched = await controlPlane.dispatchAgentWorkflowStage({
        agentId: created.agent.id,
        stageIndex: 0,
        workflowId: started.workflow.workflowId,
      });
      if (!dispatched.ok) throw new Error("Expected expired Session deletion Run.");

      const session = env.CREW_SESSION.getByName(
        crewSessionObjectName({
          agentId: created.agent.id,
          ownerKey: authority.ownerKey,
          sessionId: dispatched.session.sessionId,
        }),
      );
      await runInDurableObject(session, async (instance, state) => {
        if (!(instance instanceof TestCrewSession)) throw new Error("Expected test CrewSession.");
        instance.ignoreNextCancellationForTest();
        const key = `crewhelm:run:${dispatched.runId}`;
        const record = admittedRunRecordSchema.parse(await state.storage.get(key));
        await state.storage.put(key, { ...record, deadlineAt: 1 });
      });
      await runInDurableObject(controlPlane, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE run_admissions SET redeemed_at = 1 WHERE run_id = ?",
          dispatched.runId,
        );
      });
      const running = await controlPlane.inspectAgentWorkflow(authority, {
        workflowId: started.workflow.workflowId,
      });
      if (!running.ok) throw new Error("Expected running Workflow inspection.");

      const cancelled = await controlPlane.cancelAgentWorkflow(authority, {
        expectedRevision: running.workflow.revision,
        workflowId: running.workflow.workflowId,
      });
      if (!cancelled.ok || cancelled.workflow.status !== "cancelled") {
        throw new Error("Expected owner deadline recovery to cancel the Workflow.");
      }
      if (failCancellation) {
        await runInDurableObject(session, (instance) => {
          if (!(instance instanceof TestCrewSession)) throw new Error("Expected test CrewSession.");
          instance.failNextCancellationForTest();
        });
      }
      const deletion = {
        expectedRevision: cancelled.workflow.revision,
        idempotencyKey: `workflow-expired-session-delete-cleanup-${cancellationOutcome}`,
        workflowId: cancelled.workflow.workflowId,
      };
      await expect(controlPlane.deleteAgentWorkflow(authority, deletion)).resolves.toMatchObject({
        error: { code: "workflow_unavailable" },
        ok: false,
      });

      await drainSlowSessionRun(session, dispatched.runId);
      await expect(
        controlPlane.inspectAgentWorkflow(authority, { workflowId: cancelled.workflow.workflowId }),
      ).resolves.toMatchObject({ ok: true, workflow: { status: "cancelled" } });

      const objectName = crewSessionObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
        sessionId: dispatched.session.sessionId,
      });
      const restartKey = `crewhelm:session-run-restart:${dispatched.runId}`;
      const settlement = {
        objectName,
        runId: dispatched.runId,
        session: dispatched.session,
      };
      await runInDurableObject(session, async (instance, state) => {
        if (!(instance instanceof TestCrewSession)) throw new Error("Expected test CrewSession.");
        await state.storage.delete(`crewhelm:session-run-drained:${dispatched.runId}`);
        if (failCancellation) await state.storage.put(restartKey, true);
        else await state.storage.delete(restartKey);
        await expect(instance.settleExpiredSessionRunForDeletion(settlement)).resolves.toBe(false);
        await expect(state.storage.get(restartKey)).resolves.toEqual(expect.any(String));

        const abort = vi.spyOn(state, "abort").mockImplementation((message?: string) => {
          throw new Error(message ?? "Durable Object aborted.");
        });
        await expect(instance.settleExpiredSessionRunForDeletion(settlement)).rejects.toThrow(
          "Expired Session Run is restarting to prove deletion quiescence.",
        );
        expect(abort).toHaveBeenCalledOnce();
        abort.mockRestore();
      });

      await expect(controlPlane.deleteAgentWorkflow(authority, deletion)).resolves.toEqual({
        deleted: true,
        ok: true,
        workflowId: cancelled.workflow.workflowId,
      });

      await expect(
        controlPlane.inspectAgentWorkflow(authority, { workflowId: cancelled.workflow.workflowId }),
      ).resolves.toMatchObject({ error: { code: "workflow_not_found" }, ok: false });
      await runInDurableObject(session, async (_instance, state) => {
        await expect(
          state.storage.get(`crewhelm:run:${dispatched.runId}`),
        ).resolves.toBeUndefined();
        const tables = new Set(
          [...state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master")].map(
            (row) => row.name,
          ),
        );
        for (const table of ["assistant_messages", "cf_think_submissions"]) {
          if (!tables.has(table)) continue;
          const rows = [
            ...state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`),
          ];
          expect(rows[0]?.count ?? 0).toBe(0);
        }
      });
    },
  );
});
