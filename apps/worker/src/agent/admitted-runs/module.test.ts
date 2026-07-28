import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  MAXIMUM_RUN_OUTPUT_CHARACTERS,
  OWNER_WRITE_SCOPE,
  crewAgentObjectName,
  ownerAuthoritySchema,
  type CreateAgentInput,
  type InspectRunResult,
  type OwnerAuthority,
  type ComposioToolCapabilityGrant,
} from "@crewhelm/contracts";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  BLOCKED_CREW_AGENT_AUTHORITY_METHODS,
  CrewAgent,
  isToolExecutionPermitFresh,
} from "./module.js";
import { deriveOwnerKey } from "../../owner/identity.js";
import { digestRunPrompt } from "../../owner/runs/module.js";
import {
  LARGE_TEST_PROMPT,
  SLOW_TEST_PROMPT,
  TEST_REPLY,
  TOOL_TEST_PROMPT,
  TestCrewAgent,
} from "./test-agent.js";

async function authorityFor(
  subject: string,
  scopes = [OWNER_WRITE_SCOPE, AGENTS_READ_SCOPE, AGENTS_WRITE_SCOPE],
): Promise<OwnerAuthority> {
  return ownerAuthoritySchema.parse({
    clientId: "https://client.example/mcp.json",
    ownerKey: await deriveOwnerKey({
      issuer: "https://github.com",
      subject,
    }),
    scopes,
  });
}

function agentInput(idempotencyKey: string): CreateAgentInput {
  return {
    executionLimits: {
      maxDurationSeconds: 45,
      maxModelTokens: 2_000,
      maxToolCalls: 0,
      maxTurns: 4,
    },
    idempotencyKey,
    instructions: "Return one concise, plain-text answer.",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name: "CrewAgent run fixture",
  };
}

function invalidRunAdmission() {
  return {
    error: {
      code: "invalid_admission",
      message: "Run admission denied.",
    },
    ok: false,
  };
}

async function completedRun(
  controlPlane: ReturnType<Cloudflare.Env["OWNER_CONTROL_PLANE"]["getByName"]>,
  authority: OwnerAuthority,
  runId: string,
): Promise<Extract<InspectRunResult, { ok: true }>> {
  return vi.waitFor(
    async () => {
      const result = await controlPlane.inspectRun(authority, { runId });

      expect(result).toMatchObject({
        ok: true,
        run: {
          output: TEST_REPLY,
          outputTruncated: false,
          runId,
          status: "completed",
        },
      });

      if (!result.ok) {
        throw new Error("Expected a completed run.");
      }

      return result;
    },
    { interval: 25, timeout: 5_000 },
  );
}

function crewAgentNamespace(): DurableObjectNamespace<CrewAgent> {
  return env.CREW_AGENT;
}

function asTestCrewAgent(agent: CrewAgent): TestCrewAgent {
  if (!(agent instanceof TestCrewAgent)) {
    throw new Error("Expected the test CrewAgent implementation.");
  }

  return agent;
}

function callMethod(instance: object, method: string, ...args: unknown[]): unknown {
  const candidate: unknown = Reflect.get(instance, method);

  if (typeof candidate !== "function") {
    throw new Error(`Expected ${method} to be a method.`);
  }

  return Reflect.apply(candidate, instance, args);
}

const REQUIRED_CREW_AGENT_OVERRIDES = [
  ...BLOCKED_CREW_AGENT_AUTHORITY_METHODS,
  "_cf_dispatchScheduledCallback",
  "_cf_invokeAgentPath",
  "_cf_invokeSubAgent",
  "_cf_invokeSubAgentPath",
  "_cf_scheduleEveryForFacet",
  "_cf_scheduleForFacet",
  "_chatRecoveryContinue",
  "_chatRecoveryRetry",
  "abortAllRequests",
  "abortRequest",
  "appendMessageToHistory",
  "cancelAgentTool",
  "cancelAgentToolRun",
  "cancelSubmission",
  "clearAgentToolRuns",
  "getAIBinding",
  "resetTurnState",
  "resolveModel",
  "runAgentTool",
  "runTurn",
  "submitMessages",
  "syncMessagesFromStorage",
  "updateMessageInHistory",
] as const;

describe("CrewAgent admitted execution", () => {
  it("rejects an execution permit at and after its dispatch deadline", () => {
    const permit = {
      constraints: { decisionExpiresAt: "2026-07-27T18:20:05.000Z" },
    };
    const expiresAt = Date.parse(permit.constraints.decisionExpiresAt);

    expect(isToolExecutionPermitFresh(permit, expiresAt - 1)).toBe(true);
    expect(isToolExecutionPermitFresh(permit, expiresAt)).toBe(false);
    expect(isToolExecutionPermitFresh(permit, expiresAt + 1)).toBe(false);
  });

  it("pins the complete inherited surface and owns every authority-bearing override", () => {
    const inherited = new Set<string>();
    let prototype: object | null = Reflect.getPrototypeOf(CrewAgent.prototype);

    while (prototype !== null && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (
          name !== "constructor" &&
          typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === "function"
        ) {
          inherited.add(name);
        }
      }

      prototype = Reflect.getPrototypeOf(prototype);
    }

    const inheritedNames = [...inherited].toSorted();
    let fingerprint = 2_166_136_261;

    for (const character of inheritedNames.join("\n")) {
      fingerprint ^= character.codePointAt(0) ?? 0;
      fingerprint = Math.imul(fingerprint, 16_777_619);
    }

    expect({
      count: inheritedNames.length,
      fingerprint: fingerprint >>> 0,
    }).toEqual({
      count: 657,
      fingerprint: 1_719_753_332,
    });

    for (const method of REQUIRED_CREW_AGENT_OVERRIDES) {
      if (!inherited.has(method)) {
        throw new Error(`${method} is no longer part of the pinned framework surface.`);
      }

      expect(Object.hasOwn(CrewAgent.prototype, method)).toBe(true);
    }
  });

  it("denies direct inherited turn entrypoints and fails closed outside an admitted turn", async () => {
    const objectName = crewAgentObjectName({
      agentId: "agent_22222222-2222-4222-8222-222222222222",
      ownerKey: `owner_${"A".repeat(43)}`,
    });
    const stub = crewAgentNamespace().getByName(objectName);

    await runInDurableObject(stub, async (agent) => {
      expect(() => agent.configure({})).toThrow("CrewAgent runtime admission is not available.");
      expect(() => agent.getSystemPrompt()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
      expect(() => agent.beforeTurn()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
      expect(() => agent.getAIBinding()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
      expect(() => agent.resolveModel()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
      expect(() => callMethod(agent, "_cf_listSchedulesForFacet", null)).toThrow(
        "CrewAgent runtime admission is not available.",
      );
      expect(() => callMethod(agent, "_cf_cancelScheduleForFacet", null, "schedule-id")).toThrow(
        "CrewAgent runtime admission is not available.",
      );
      expect(() =>
        callMethod(agent, "_cf_getTopLevelNamespaceByClassName", "OWNER_CONTROL_PLANE"),
      ).toThrow("CrewAgent runtime admission is not available.");
      await expect(agent.authorizeTurn()).rejects.toThrow(
        "CrewAgent active run admission is missing or invalid.",
      );
      expect(agent.authorizeAction()).toBe(false);
      await expect(
        agent.runTurn({ input: "Attempt an unadmitted model turn.", mode: "wait" }),
      ).rejects.toThrow("CrewAgent runtime admission is not available.");
      await expect(
        agent.submitMessages([
          {
            id: "unadmitted",
            parts: [{ text: "Attempt an unadmitted submission.", type: "text" }],
            role: "user",
          },
        ]),
      ).rejects.toThrow("CrewAgent runtime admission is not available.");
      await expect(agent.getMessages()).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.reportProgress({ message: "injected" })).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.clearMessages()).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.addMessages([])).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.inspectSubmission("unadmitted")).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.listSubmissions()).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.deleteSubmission("unadmitted")).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.deleteSubmissions()).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.cancelSubmission("unadmitted")).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      expect(() => agent.cancelChat("unadmitted")).toThrow(
        "CrewAgent runtime admission is not available.",
      );
      expect(() => agent.cancelAllChats()).toThrow("CrewAgent runtime admission is not available.");
      expect(agent.replyAttachments()).toEqual([]);
      await expect(agent.pendingExecutions()).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.pendingApprovals()).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.listAdmittedRunToolApprovals({})).resolves.toEqual(invalidRunAdmission());
      await expect(agent.decideAdmittedRunToolApproval({})).resolves.toEqual(invalidRunAdmission());
      await expect(agent.approveExecution("unadmitted")).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.rejectExecution("unadmitted")).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      expect(() => agent.getConfig()).toThrow("CrewAgent runtime admission is not available.");
      expect(() => agent.setState({ injected: true })).toThrow(
        "CrewAgent runtime admission is not available.",
      );
      expect(() => callMethod(agent, "sql", ["SELECT 1"])).toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(callMethod(agent, "_hostReadFile", "/secret")).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(agent.addMcpServer("attacker", "https://attacker.example")).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      expect(agent.getMcpServers()).toEqual({
        prompts: [],
        resources: [],
        servers: {},
        tools: [],
      });
      expect(agent.getTools()).toEqual({});
      expect(() => agent.getActions()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
      await expect(agent.destroy()).rejects.toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(
        agent.inspectAdmittedRun({ runId: "run_22222222-2222-4222-8222-222222222222" }),
      ).resolves.toEqual(invalidRunAdmission());
      await expect(
        agent.resumeRunAdmission({
          prompt: "Attempt an unauthorized resume.",
          runId: "run_22222222-2222-4222-8222-222222222222",
        }),
      ).resolves.toEqual(invalidRunAdmission());
    });
    await expect(stub.fetch("https://crew-agent.test")).resolves.toMatchObject({
      status: 404,
    });

    for (const method of [
      "_hostReadFile",
      "_hostWriteFile",
      "addMcpServer",
      "cancelAgentToolRun",
      "cancelAllChats",
      "cancelChat",
      "cancelFiber",
      "cancelSubmission",
      "chat",
      "clearMessages",
      "configure",
      "deleteSubmission",
      "destroy",
      "fetch",
      "getCallableMethods",
      "getConfig",
      "getMessages",
      "inspectAgentToolRun",
      "inspectSubmission",
      "listFibers",
      "reportProgress",
      "runTurn",
      "runWorkflow",
      "schedule",
      "sendEmail",
      "setState",
      "sql",
      "startAgentToolRun",
      "submitMessages",
    ]) {
      expect(Object.hasOwn(CrewAgent.prototype, method)).toBe(true);
    }
  });

  it("runs one owner-admitted turn, exposes bounded output, and replays idempotently", async () => {
    const authority = await authorityFor("crew-agent-601");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("crew-agent-create-601"));
    const prompt = "Answer this exact admitted question.";

    if (!created.ok) {
      throw new Error("Expected CrewAgent run fixture Agent.");
    }

    const input = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-601",
      prompt,
    };
    const started = await controlPlane.startRun(authority, input);

    expect(started).toMatchObject({
      created: true,
      ok: true,
      run: {
        agentId: created.agent.id,
        agentRevision: created.agent.revision,
      },
    });

    if (!started.ok) {
      throw new Error("Expected admitted CrewAgent run.");
    }

    const finished = await completedRun(controlPlane, authority, started.run.runId);
    const replay = await controlPlane.startRun(authority, input);
    const secondClient = {
      ...authority,
      clientId: "https://second-client.example/mcp.json",
    } satisfies OwnerAuthority;

    expect(replay).toEqual({
      created: false,
      ok: true,
      run: finished.run,
    });
    await expect(
      controlPlane.inspectRun(secondClient, { runId: started.run.runId }),
    ).resolves.toEqual(finished);

    const stub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
      }),
    );

    await runInDurableObject(stub, async (agent, state) => {
      const records = await state.storage.list({ prefix: "crewhelm:run:" });
      const serialized = JSON.stringify([...records.values()]);
      const calls = asTestCrewAgent(agent).modelCallsForTest();

      expect(records.size).toBe(1);
      expect(serialized).not.toContain(prompt);
      expect(serialized).not.toContain("nonce");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        maxOutputTokens: created.agent.executionLimits.maxModelTokens,
        toolCount: 0,
      });
      expect(JSON.stringify(calls[0]?.prompt)).toContain(created.agent.instructions);
      expect(JSON.stringify(calls[0]?.prompt)).toContain(prompt);
    });

    await evictDurableObject(stub);
    await expect(controlPlane.inspectRun(authority, { runId: started.run.runId })).resolves.toEqual(
      finished,
    );
  });

  it("routes an exact admitted read tool through ToolGate and records its permit", async () => {
    const authority = await authorityFor("crew-agent-611");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      ...agentInput("crew-agent-create-611"),
      executionLimits: {
        ...agentInput("unused").executionLimits,
        maxToolCalls: 1,
      },
    });

    if (!created.ok) {
      throw new Error("Expected tool-enabled CrewAgent fixture.");
    }

    const connectionId = "connection_61111111-1111-4111-8111-111111111111";
    const grantId = "grant_61111111-1111-4111-8111-111111111111";
    const targetDigest = "b".repeat(64);
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
        maxCallsPerRun: 1,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 5_000,
        maxDurationMs: 20_000,
        maxOutputBytes: 64_000,
      },
      ownerKey: authority.ownerKey,
      targetDigests: [targetDigest],
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
        "ca_crew_agent_611",
        "ac_crew_agent_611",
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

    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-611",
      prompt: TOOL_TEST_PROMPT,
    });

    if (!started.ok) {
      throw new Error("Expected admitted tool run.");
    }

    await vi.waitFor(
      async () => {
        await expect(
          controlPlane.inspectRun(authority, { runId: started.run.runId }),
        ).resolves.toMatchObject({
          ok: true,
          run: { runId: started.run.runId, status: "completed" },
        });
      },
      { interval: 25, timeout: 5_000 },
    );
    const stub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
      }),
    );

    await runInDurableObject(stub, async (agent) => {
      const testAgent = asTestCrewAgent(agent);
      const calls = testAgent.modelCallsForTest();
      const executions = testAgent.toolExecutionsForTest();

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ toolCount: 1 });
      expect(JSON.stringify(calls[1]?.prompt)).not.toContain("ActionAuthorizationError");
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        input: { itemId: "item-701" },
        permit: {
          action: {
            grantId,
            runId: started.run.runId,
            targetDigests: [targetDigest],
          },
          audience: "composio_adapter",
        },
      });
    });
  });

  it("truncates retained output at the public character boundary", async () => {
    const authority = await authorityFor("crew-agent-608");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("crew-agent-create-608"));

    if (!created.ok) {
      throw new Error("Expected output-boundary fixture Agent.");
    }

    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-608",
      prompt: LARGE_TEST_PROMPT,
    });

    if (!started.ok) {
      throw new Error("Expected output-boundary run.");
    }

    await vi.waitFor(
      async () => {
        const inspected = await controlPlane.inspectRun(authority, {
          runId: started.run.runId,
        });

        expect(inspected).toMatchObject({
          ok: true,
          run: {
            outputTruncated: true,
            status: "completed",
          },
        });
        expect(inspected.ok ? inspected.run.output : undefined).toHaveLength(
          MAXIMUM_RUN_OUTPUT_CHARACTERS,
        );
      },
      { interval: 25, timeout: 5_000 },
    );
  });

  it("resumes the same submission after admission redemption wins a cross-object crash", async () => {
    const authority = await authorityFor("crew-agent-604");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("crew-agent-create-604"));
    const prompt = "Resume this exact admitted run.";

    if (!created.ok) {
      throw new Error("Expected CrewAgent recovery fixture Agent.");
    }

    const input = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-604",
      prompt,
    };
    const admission = await controlPlane.createRunAdmission(authority, {
      agentId: input.agentId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected CrewAgent recovery admission.");
    }

    const verified = await controlPlane.verifyRunAdmission(admission.permit);

    if (!verified.ok) {
      throw new Error("Expected CrewAgent recovery configuration.");
    }

    const stub = crewAgentNamespace().getByName(crewAgentObjectName(admission.permit));
    const acceptedAt = Date.now();

    await runInDurableObject(stub, async (_agent, state) => {
      await state.storage.put(`crewhelm:run:${admission.permit.runId}`, {
        budgetReservation: admission.permit.budgetReservation,
        cleanupAt: acceptedAt + 24 * 60 * 60 * 1_000,
        clientId: admission.permit.clientId,
        configuration: verified.configuration,
        createdAt: acceptedAt,
        deadlineAt: acceptedAt + admission.permit.budgetReservation.maxDurationSeconds * 1_000,
        idempotencyKey: admission.permit.idempotencyKey,
        promptCharacters: prompt.length,
        promptDigest: admission.permit.promptDigest,
      });
    });
    await expect(controlPlane.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
    await evictDurableObject(stub);

    const resumed = await controlPlane.startRun(authority, input);

    expect(resumed).toMatchObject({
      created: false,
      ok: true,
      run: {
        runId: admission.permit.runId,
      },
    });
    await completedRun(controlPlane, authority, admission.permit.runId);
  });

  it("rechecks the current Agent revision before spending the reserved model call", async () => {
    const authority = await authorityFor("crew-agent-607");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("crew-agent-create-607"));

    if (!created.ok) {
      throw new Error("Expected stale-revision fixture Agent.");
    }

    const first = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-607-first",
      prompt: SLOW_TEST_PROMPT,
    });
    const second = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-607-second",
      prompt: "This queued stale revision must not reach the model.",
    });

    if (!first.ok || !second.ok) {
      throw new Error("Expected both queued stale-revision runs.");
    }

    const stub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
      }),
    );

    await vi.waitFor(
      () =>
        runInDurableObject(stub, (agent) => {
          expect(asTestCrewAgent(agent).modelCallsForTest()).toHaveLength(1);
        }),
      { interval: 25, timeout: 2_000 },
    );
    await expect(
      controlPlane.updateAgent(authority, {
        ...agentInput("crew-agent-update-607"),
        expectedRevision: created.agent.revision,
        id: created.agent.id,
        name: "Revoked run fixture",
      }),
    ).resolves.toMatchObject({
      ok: true,
      updated: true,
    });

    await completedRun(controlPlane, authority, first.run.runId);
    await vi.waitFor(
      async () => {
        await expect(
          controlPlane.inspectRun(authority, { runId: second.run.runId }),
        ).resolves.toMatchObject({
          ok: true,
          run: {
            runId: second.run.runId,
            status: "failed",
          },
        });
      },
      { interval: 25, timeout: 5_000 },
    );
    await runInDurableObject(stub, (agent) => {
      expect(asTestCrewAgent(agent).modelCallsForTest()).toHaveLength(1);
    });
  });

  it("parks an exact write tool for owner approval and reauthorizes it before execution", async () => {
    const authority = await authorityFor("crew-agent-612");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, {
      ...agentInput("crew-agent-create-612"),
      executionLimits: {
        ...agentInput("unused").executionLimits,
        maxToolCalls: 1,
      },
    });

    if (!created.ok) {
      throw new Error("Expected approval-enabled CrewAgent fixture.");
    }

    const connectionId = "connection_61222222-2222-4222-8222-222222222222";
    const grantId = "grant_61222222-2222-4222-8222-222222222222";
    const targetDigest = "c".repeat(64);
    const grant: ComposioToolCapabilityGrant = {
      agentId: created.agent.id,
      agentRevision: created.agent.revision,
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      effect: "write",
      expiresAt: null,
      grantId,
      integrationSlug: "project_toolkit",
      limits: {
        maxCallsPerRun: 1,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 5_000,
        maxDurationMs: 20_000,
        maxOutputBytes: 64_000,
      },
      ownerKey: authority.ownerKey,
      targetDigests: [targetDigest],
      toolkitVersion: "20260727_00",
      toolSlug: "PROJECT_TOOLKIT_UPDATE_ITEM",
    };

    await runInDurableObject(controlPlane, (_instance, state) => {
      const currentTime = Date.now();
      state.storage.sql.exec(
        `INSERT INTO connections
           (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
         VALUES (?, 'composio', ?, ?, 'active', ?)`,
        connectionId,
        "ca_crew_agent_612",
        "ac_crew_agent_612",
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

    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-612",
      prompt: TOOL_TEST_PROMPT,
    });

    if (!started.ok) {
      throw new Error("Expected approval-bound tool run.");
    }

    const listed = await vi.waitFor(
      async () => {
        const result = await controlPlane.listRunToolApprovals(authority, {
          runId: started.run.runId,
        });

        expect(result).toMatchObject({
          approvals: [
            {
              action: "projectToolkitReadItem",
              effect: "write",
              risk: "medium",
            },
          ],
          ok: true,
        });

        if (!result.ok || result.approvals[0] === undefined) {
          throw new Error("Expected pending owner approval.");
        }

        return result;
      },
      { interval: 25, timeout: 5_000 },
    );
    const approval = listed.approvals[0];

    if (approval === undefined) {
      throw new Error("Expected pending owner approval.");
    }

    await expect(
      controlPlane.decideRunToolApproval(authority, {
        decision: "approve",
        executionId: approval.executionId,
        runId: started.run.runId,
      }),
    ).resolves.toEqual({
      decided: true,
      decision: "approve",
      ok: true,
    });
    await completedRun(controlPlane, authority, started.run.runId);

    const stub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
      }),
    );

    await runInDurableObject(stub, async (agent, state) => {
      const testAgent = asTestCrewAgent(agent);
      const executions = testAgent.toolExecutionsForTest();
      const approvalRecords = await state.storage.list({
        prefix: "crewhelm:tool-approval:",
      });

      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        permit: {
          action: {
            effect: "write",
            grantId,
            runId: started.run.runId,
            targetDigests: [targetDigest],
          },
        },
      });
      expect(approvalRecords.size).toBe(0);
    });
  });

  it("requires the exact run prompt, owner object, revision, and scopes", async () => {
    const authority = await authorityFor("crew-agent-602");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("crew-agent-create-602"));
    const prompt = "Use only this exact prompt.";

    if (!created.ok) {
      throw new Error("Expected CrewAgent rejection fixture Agent.");
    }

    const admission = await controlPlane.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-admit-602",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected CrewAgent rejection permit.");
    }

    const correctStub = crewAgentNamespace().getByName(crewAgentObjectName(admission.permit));
    const wrongObjectStub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        ...admission.permit,
        ownerKey: `owner_${"Z".repeat(43)}`,
      }),
    );

    await expect(
      correctStub.acceptRunAdmission({
        permit: admission.permit,
        prompt: "A different prompt.",
      }),
    ).resolves.toEqual(invalidRunAdmission());
    await expect(
      wrongObjectStub.acceptRunAdmission({
        permit: admission.permit,
        prompt,
      }),
    ).resolves.toEqual(invalidRunAdmission());
    await expect(
      correctStub.acceptRunAdmission({
        permit: admission.permit,
        prompt,
        unexpectedSecret: "must-not-reflect",
      }),
    ).resolves.toEqual(invalidRunAdmission());

    const readOnly = await authorityFor("crew-agent-602", [AGENTS_READ_SCOPE]);
    const ownerWriteOnly = await authorityFor("crew-agent-602", [OWNER_WRITE_SCOPE]);
    const writeOnly = { ...authority, scopes: [AGENTS_WRITE_SCOPE] } satisfies OwnerAuthority;

    await expect(
      controlPlane.createRunAdmission(ownerWriteOnly, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "crew-agent-owner-write-denied-602",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toMatchObject({
      error: { code: "insufficient_scope" },
      ok: false,
    });
    await expect(
      controlPlane.startRun(readOnly, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "crew-agent-denied-602",
        prompt,
      }),
    ).resolves.toMatchObject({
      error: { code: "insufficient_scope" },
      ok: false,
    });
    await expect(
      controlPlane.inspectRun(writeOnly, { runId: admission.permit.runId }),
    ).resolves.toMatchObject({
      error: { code: "insufficient_scope" },
      ok: false,
    });
  });

  it("durably cancels a model submission at the admitted wall-clock deadline", async () => {
    const authority = await authorityFor("crew-agent-603");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = agentInput("crew-agent-create-603");
    const created = await controlPlane.createAgent(authority, {
      ...input,
      executionLimits: {
        ...input.executionLimits,
        maxDurationSeconds: 1,
      },
    });

    if (!created.ok) {
      throw new Error("Expected CrewAgent deadline fixture Agent.");
    }

    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-603",
      prompt: SLOW_TEST_PROMPT,
    });

    if (!started.ok) {
      throw new Error("Expected deadline-bound CrewAgent run.");
    }

    const deadlineStub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(runDurableObjectAlarm(deadlineStub)).resolves.toBe(true);

    await vi.waitFor(
      async () => {
        const inspected = await controlPlane.inspectRun(authority, {
          runId: started.run.runId,
        });

        expect(inspected).toMatchObject({
          ok: true,
          run: {
            runId: started.run.runId,
            status: "cancelled",
          },
        });
        expect(inspected.ok ? inspected.run.output : undefined).toBeUndefined();
      },
      { interval: 50, timeout: 5_000 },
    );
  });

  it("propagates deadline cancellation failures for durable schedule retry", async () => {
    const authority = await authorityFor("crew-agent-605");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = agentInput("crew-agent-create-605");
    const created = await controlPlane.createAgent(authority, {
      ...input,
      executionLimits: {
        ...input.executionLimits,
        maxDurationSeconds: 5,
      },
    });

    if (!created.ok) {
      throw new Error("Expected cancellation-failure fixture Agent.");
    }

    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-605",
      prompt: SLOW_TEST_PROMPT,
    });

    if (!started.ok) {
      throw new Error("Expected cancellation-failure run.");
    }

    const stub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
      }),
    );

    await expect(
      runInDurableObject(stub, async (agent, state) => {
        const key = `crewhelm:run:${started.run.runId}`;
        const record = await state.storage.get<Record<string, unknown>>(key);

        if (record === undefined) {
          throw new Error("Expected admitted run record.");
        }

        await state.storage.put(key, { malformed: true });
        await expect(agent.expireAdmittedRun({ runId: started.run.runId })).rejects.toThrow(
          /expected/,
        );
        await state.storage.put(key, { ...record, deadlineAt: 1 });
        asTestCrewAgent(agent).failNextCancellationForTest();
        await agent.expireAdmittedRun({ runId: started.run.runId });
      }),
    ).rejects.toThrow("Injected cancellation failure.");
  });

  it("removes retained run state and output at the bounded cleanup time", async () => {
    const authority = await authorityFor("crew-agent-606");
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(authority, agentInput("crew-agent-create-606"));

    if (!created.ok) {
      throw new Error("Expected retention fixture Agent.");
    }

    const started = await controlPlane.startRun(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "crew-agent-run-606",
      prompt: "Complete and retain this run only for the test window.",
    });

    if (!started.ok) {
      throw new Error("Expected retention fixture run.");
    }

    await completedRun(controlPlane, authority, started.run.runId);

    const stub = crewAgentNamespace().getByName(
      crewAgentObjectName({
        agentId: created.agent.id,
        ownerKey: authority.ownerKey,
      }),
    );

    await runInDurableObject(stub, async (agent, state) => {
      const key = `crewhelm:run:${started.run.runId}`;
      const record = await state.storage.get<Record<string, unknown>>(key);
      const messageId = `crewhelm:${started.run.runId}:user`;

      if (record === undefined) {
        throw new Error("Expected retained run record.");
      }

      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM assistant_messages WHERE id = ? OR parent_id = ?",
            messageId,
            messageId,
          )
          .one(),
      ).toEqual({ count: 2 });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM assistant_fts WHERE content LIKE ?",
            `%${TEST_REPLY}%`,
          )
          .one(),
      ).toEqual({ count: 1 });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM cf_think_submissions WHERE submission_id = ?",
            started.run.runId,
          )
          .one(),
      ).toEqual({ count: 1 });
      await state.storage.put(key, { ...record, cleanupAt: 1 });
      await agent.cleanupAdmittedRun({ runId: started.run.runId });
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_agent, state) => {
      const messageId = `crewhelm:${started.run.runId}:user`;

      await expect(state.storage.get(`crewhelm:run:${started.run.runId}`)).resolves.toBeUndefined();
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM assistant_messages WHERE id = ? OR parent_id = ?",
            messageId,
            messageId,
          )
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM assistant_fts WHERE content LIKE ?",
            `%${TEST_REPLY}%`,
          )
          .one(),
      ).toEqual({ count: 0 });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS count FROM cf_think_submissions WHERE submission_id = ?",
            started.run.runId,
          )
          .one(),
      ).toEqual({ count: 0 });
    });
    await expect(
      controlPlane.inspectRun(authority, { runId: started.run.runId }),
    ).resolves.toMatchObject({
      error: { code: "run_unavailable" },
      ok: false,
    });
  });
});
