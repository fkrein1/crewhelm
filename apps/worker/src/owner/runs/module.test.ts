import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  MAXIMUM_RUN_ADMISSIONS_PER_OWNER,
  MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
  MAXIMUM_SESSION_CONTEXT_CHARACTERS,
  MAXIMUM_AGENT_SKILL_CONTEXT_CHARACTERS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUN_ADMISSION_LIFETIME_MS,
  RUNS_WRITE_SCOPE,
  crewAgentSystemPrompt,
  createRemoteMcpConnectionResultSchema,
  publishSkillResultSchema,
  DEFAULT_FLEET_RUN_RETENTION_SECONDS,
} from "@crewhelm/contracts";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { digestRunPrompt } from "../../agent/admitted-runs/index.js";
import {
  AI_GATEWAY_CAPABILITY_ID,
  aiGatewayCapabilityConfiguration,
} from "../../agent-capabilities/ai-gateway.js";
import {
  WORKERS_AI_CAPABILITY_ID,
  workersAiCapabilityConfiguration,
} from "../../agent-capabilities/workers-ai.js";
import { skillsCapabilityConfiguration } from "../../agent-capabilities/skills.js";
import type { OwnerControlPlane } from "../durable-object.js";
import { R2SkillPackageObjectStore } from "../skills/index.js";
import { agentInput, agentUpdate, authorityFor, fixedRunAdmissionFailure } from "../testkit.js";
import { runAdmissionFailureFromCapabilityCompilation } from "./module.js";

describe("Run admission control flow", () => {
  it("translates every capability compilation failure", () => {
    expect(
      runAdmissionFailureFromCapabilityCompilation({
        code: "configuration_unavailable",
        moduleId: WORKERS_AI_CAPABILITY_ID,
        ok: false,
      }),
    ).toBe("model_unavailable");
    expect(
      runAdmissionFailureFromCapabilityCompilation({
        code: "configuration_unavailable",
        moduleId: AI_GATEWAY_CAPABILITY_ID,
        ok: false,
      }),
    ).toBe("model_unavailable");
    expect(
      runAdmissionFailureFromCapabilityCompilation({
        code: "configuration_unavailable",
        moduleId: "sandbox.code",
        ok: false,
      }),
    ).toBe("capability_unavailable");
    expect(
      runAdmissionFailureFromCapabilityCompilation({ code: "capability_conflict", ok: false }),
    ).toBe("capability_unavailable");
    expect(
      runAdmissionFailureFromCapabilityCompilation({ code: "capability_unavailable", ok: false }),
    ).toBe("capability_unavailable");
    expect(
      runAdmissionFailureFromCapabilityCompilation({ code: "invalid_configuration", ok: false }),
    ).toBe("capability_unavailable");
    expect(
      runAdmissionFailureFromCapabilityCompilation({
        code: "missing_required_capability",
        ok: false,
      }),
    ).toBe("capability_unavailable");
    expect(
      runAdmissionFailureFromCapabilityCompilation({ code: "unknown_capability", ok: false }),
    ).toBe("capability_unavailable");
  });
});

describe("OwnerControlPlane runs", () => {
  it("freezes Agent-specific integration limits into the run budget", async () => {
    const authority = await authorityFor("run-agent-integration-limits", [
      AGENTS_WRITE_SCOPE,
      OWNER_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, {
      ...agentInput("run-agent-integration-limits-create"),
      executionLimits: {
        integrations: {
          duplicateToolCallLimit: 3,
          maxCallsPerRun: 12,
          maxCallsPerToolPerRun: 7,
        },
        maxDurationSeconds: 600,
        maxModelTokens: 20_000,
        maxToolCalls: 12,
        maxTurns: 20,
      },
    });
    if (!created.ok) {
      throw new Error(
        `Expected Agent-specific integration limit fixture: ${JSON.stringify(created)}`,
      );
    }

    const prompt = "Prepare one bounded proposal draft.";
    const issued = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "run-agent-integration-limits-admission",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });
    if (!issued.ok || issued.state !== "issued") {
      throw new Error("Expected Agent-specific run admission.");
    }

    expect(issued.permit.budgetReservation).toMatchObject({
      integrationLimits: {
        duplicateToolCallLimit: 3,
        maxCallsPerRun: 12,
        maxCallsPerToolPerRun: 7,
      },
    });
  });

  it("denies admission after an attached remote MCP Connection is revoked", async () => {
    const authority = await authorityFor("run-revoked-remote-mcp", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const createdAgent = await stub.createAgent(
      authority,
      agentInput("create-revoked-remote-mcp-agent"),
    );
    const catalog = [
      {
        description: "Read public documentation.",
        inputSchema: {
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object" as const,
        },
        name: "read_docs",
      },
    ];
    const serializedCatalog = JSON.stringify(catalog);
    const snapshotDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedCatalog)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const createdConnection = createRemoteMcpConnectionResultSchema.parse(
      await stub.createRemoteMcpConnection(authority, {
        authKind: "public",
        catalog,
        catalogBytes: new TextEncoder().encode(serializedCatalog).byteLength,
        endpoint: "https://docs.example/mcp",
        idempotencyKey: "create-revoked-remote-mcp-connection",
        name: "Revoked docs",
        server: { name: "docs", version: "1" },
        snapshotDigest,
      }),
    );

    if (!createdAgent.ok) throw new Error("Expected remote MCP Agent fixture.");
    if (!createdConnection.ok) throw new Error("Expected remote MCP Connection fixture.");

    const configured = await stub.configureAgentRemoteMcpConnection(authority, {
      agentId: createdAgent.agent.id,
      authorization: "standing",
      connectionId: createdConnection.connection.connectionId,
      expectedRevision: createdAgent.agent.revision,
      expiresAt: null,
      idempotencyKey: "attach-revoked-remote-mcp-connection",
      limits: {
        maxCallsPerRun: 1,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 0,
        maxDurationMs: 5_000,
        maxOutputBytes: 16_384,
      },
      snapshotDigest,
    });
    if (!configured.ok) {
      throw new Error("Expected remote MCP attachment fixture.");
    }

    await expect(
      stub.deleteRemoteMcpConnection(authority, {
        connectionId: createdConnection.connection.connectionId,
        idempotencyKey: "delete-revoked-remote-mcp-connection",
        snapshotDigest,
      }),
    ).resolves.toEqual({ deleted: true, ok: true });

    const prompt = "Read the attached public documentation.";
    await expect(
      stub.createRunAdmission(authority, {
        agentId: createdAgent.agent.id,
        expectedRevision: configured.agent.revision,
        idempotencyKey: "deny-revoked-remote-mcp-run",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("capability_unavailable"));
  });

  it("hydrates only exact SKILL.md instructions and snapshots compact provenance", async () => {
    const authority = await authorityFor("run-skill-runtime", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const published = publishSkillResultSchema.parse(
      await stub.publishSkill(authority, {
        idempotencyKey: "run-skill-publish",
        mode: "apply",
        target: {
          kind: "skill-package",
          package: {
            description: "Triage one inbox.",
            files: [
              { content: "Never load this reference.", path: "references/private.md" },
              { content: "echo never-run", path: "scripts/unsafe.sh" },
              {
                content: "# Inbox triage\n\nReturn the three highest-priority items.",
                path: "SKILL.md",
              },
            ],
            name: "inbox-triage",
            provenance: { kind: "authored" },
          },
        },
      }),
    );

    if (!published.ok || published.skill === undefined) {
      throw new Error("Expected Skill publication.");
    }

    const created = await stub.createAgent(authority, {
      ...agentInput("run-skill-agent"),
      capabilities: [
        skillsCapabilityConfiguration([{ id: published.skill.id, version: 1 }]),
        workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
      ],
    });

    if (!created.ok) {
      throw new Error("Expected Skill-enabled Agent.");
    }

    expect(JSON.stringify(created.agent)).not.toContain("Return the three highest-priority");
    const prompt = "Triage this inbox.";
    const issued = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "run-skill-admission",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!issued.ok || issued.state !== "issued") {
      throw new Error("Expected Skill-enabled run admission.");
    }

    expect(issued.permit.budgetReservation.runtimePlan.skillReferences).toEqual([
      {
        id: published.skill.id,
        moduleId: "context.skills",
        schemaVersion: 1,
        version: 1,
      },
    ]);
    await expect(stub.inspectRun(authority, { runId: issued.permit.runId })).resolves.toMatchObject(
      {
        ok: true,
        skills: [
          {
            digest: published.package.digest,
            id: published.skill.id,
            name: "inbox-triage",
            version: 1,
          },
        ],
      },
    );
    const listed = await stub.listAgentRuns(authority, { agentId: created.agent.id });

    expect(listed).toMatchObject({ ok: true, runs: [{ runId: issued.permit.runId }] });
    expect(JSON.stringify(listed)).not.toContain("inbox-triage");
    expect(JSON.stringify(listed)).not.toContain(published.package.digest);
    const verified = await stub.verifyRunAdmission(issued.permit);

    if (!verified.ok) {
      throw new Error("Expected Skill hydration.");
    }

    expect(verified.configuration.skillInstructions).toEqual([
      {
        contentTrust: "untrusted",
        digest: published.package.digest,
        id: published.skill.id,
        instructions: "# Inbox triage\n\nReturn the three highest-priority items.",
        name: "inbox-triage",
        version: 1,
      },
    ]);
    const systemPrompt = crewAgentSystemPrompt(verified.configuration);

    expect(systemPrompt).toContain("untrusted content");
    expect(systemPrompt).toContain("Return the three highest-priority items.");
    expect(systemPrompt).not.toContain("Never load this reference.");
    expect(systemPrompt).not.toContain("echo never-run");
    await expect(stub.confirmRunAdmission(issued.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
    const racingInput = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "run-skill-racing-admission",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    };
    const racing = await stub.createRunAdmission(authority, racingInput);

    if (!racing.ok || racing.state !== "issued") {
      throw new Error("Expected issued admission before concurrent hydration.");
    }

    let markHydrationStarted: (() => void) | undefined;
    let releaseHydration: (() => void) | undefined;
    const hydrationStarted = new Promise<void>((resolve) => {
      markHydrationStarted = resolve;
    });
    const hydrationReleased = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const getSpy = vi
      .spyOn(R2SkillPackageObjectStore.prototype, "get")
      .mockImplementation(async () => {
        markHydrationStarted?.();
        await hydrationReleased;
        return null;
      });
    let racingReplay: Awaited<ReturnType<typeof stub.createRunAdmission>> | undefined;
    let staleVerification: Awaited<ReturnType<typeof stub.verifyRunAdmission>> | undefined;

    try {
      ({ racingReplay, staleVerification } = await runInDurableObject(stub, async (instance) => {
        const pendingVerification = instance.verifyRunAdmission(racing.permit);

        await hydrationStarted;
        const replay = await instance.createRunAdmission(authority, racingInput);

        releaseHydration?.();
        return {
          racingReplay: replay,
          staleVerification: await pendingVerification,
        };
      }));
    } finally {
      releaseHydration?.();
      getSpy.mockRestore();
    }

    expect(staleVerification).toEqual(fixedRunAdmissionFailure("invalid_admission"));

    if (!racingReplay?.ok || racingReplay.state !== "issued") {
      throw new Error("Expected a newer issued permit during stale hydration.");
    }

    await expect(stub.verifyRunAdmission(racingReplay.permit)).resolves.toMatchObject({
      ok: true,
      runId: racing.permit.runId,
    });
    const waitingInput = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "run-skill-waiting-admission",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    };
    const waiting = await stub.createRunAdmission(authority, waitingInput);

    if (!waiting.ok || waiting.state !== "issued") {
      throw new Error("Expected issued admission before Skill retirement.");
    }

    await expect(
      stub.retireSkill(authority, {
        idempotencyKey: "run-skill-retire",
        mode: "apply",
        target: {
          expectedVersion: 1,
          id: published.skill.id,
          kind: "skill-retirement",
        },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    await expect(stub.createRunAdmission(authority, waitingInput)).resolves.toEqual(
      fixedRunAdmissionFailure("agent_unavailable"),
    );
    await expect(stub.verifyRunAdmission(waiting.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(
      stub.inspectRun(authority, { runId: waiting.permit.runId }),
    ).resolves.toMatchObject({
      diagnosis: {
        nextAction: "review_configuration",
        reason: "skill_unavailable",
      },
      ok: true,
      run: { status: "failed" },
    });
    await expect(
      stub.verifyActiveRunAdmission({
        agentId: issued.permit.agentId,
        agentRevision: issued.permit.agentRevision,
        budgetReservation: issued.permit.budgetReservation,
        clientId: issued.permit.clientId,
        idempotencyKey: issued.permit.idempotencyKey,
        ownerKey: issued.permit.ownerKey,
        promptDigest: issued.permit.promptDigest,
        runId: issued.permit.runId,
      }),
    ).resolves.toMatchObject({ ok: true, runId: issued.permit.runId });
    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "run-skill-retired-admission",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("capability_unavailable"));
  });

  it.each([
    {
      label: "missing package",
      skill: "# Missing package",
      mutate: async (stub: DurableObjectStub<OwnerControlPlane>, skillId: string) => {
        const objectKey = await runInDurableObject(stub, (_instance, state) =>
          state.storage.sql
            .exec<{ objectKey: string }>(
              "SELECT object_key AS objectKey FROM skill_versions WHERE skill_id = ?",
              skillId,
            )
            .one(),
        );

        await env.SKILL_PACKAGES.delete(objectKey.objectKey);
      },
    },
    {
      label: "oversized instructions",
      skill: `# Oversized\n\n${"x".repeat(MAXIMUM_AGENT_SKILL_CONTEXT_CHARACTERS)}`,
      mutate: async () => undefined,
    },
  ])("expires admission before execution for $label", async ({ label, mutate, skill }) => {
    const slug = label.replaceAll(" ", "-");
    const authority = await authorityFor(`run-skill-${label.replaceAll(" ", "-")}`, [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const published = publishSkillResultSchema.parse(
      await stub.publishSkill(authority, {
        idempotencyKey: `run-skill-${slug}-publish`,
        mode: "apply",
        target: {
          kind: "skill-package",
          package: {
            description: `Exercise ${label}.`,
            files: [{ content: skill, path: "SKILL.md" }],
            name: `runtime-${slug}`,
            provenance: { kind: "authored" },
          },
        },
      }),
    );

    if (!published.ok || published.skill === undefined) {
      throw new Error("Expected failure-path Skill publication.");
    }

    const created = await stub.createAgent(authority, {
      ...agentInput(`run-skill-${slug}-agent`),
      capabilities: [
        skillsCapabilityConfiguration([{ id: published.skill.id, version: 1 }]),
        workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
      ],
    });

    if (!created.ok) {
      throw new Error("Expected failure-path Agent.");
    }

    const prompt = `Exercise ${label}.`;
    const issued = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: `run-skill-${slug}-admission`,
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!issued.ok || issued.state !== "issued") {
      throw new Error("Expected failure-path admission.");
    }

    await mutate(stub, published.skill.id);
    await expect(stub.verifyRunAdmission(issued.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ failureCode: string; status: string }>(
            `SELECT failure_code AS failureCode, status
             FROM run_admissions
             WHERE run_id = ?`,
            issued.permit.runId,
          )
          .one(),
      ),
    ).resolves.toEqual({
      failureCode: "skill_unavailable",
      status: "expired",
    });
  });

  it("enforces revisioned concurrent-run capacity and snapshots configured retention", async () => {
    const authority = await authorityFor("run-configured-capacity", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const current = await stub.getFleetConfiguration(authority, { target: { kind: "fleet" } });

    if (!current.ok) {
      throw new Error("Expected fleet configuration.");
    }

    const runRetentionSeconds = DEFAULT_FLEET_RUN_RETENTION_SECONDS + 60 * 60;

    await expect(
      stub.configureFleetConfiguration(authority, {
        expectedRevision: current.configuration.revision,
        idempotencyKey: "run-configured-capacity-limit",
        mode: "apply",
        patch: {
          capacity: { maxConcurrentRuns: 1 },
          retention: { runSeconds: runRetentionSeconds },
        },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    const created = await stub.createAgent(authority, agentInput("run-configured-capacity-agent"));

    if (!created.ok) {
      throw new Error("Expected configured-capacity Agent.");
    }

    const firstPrompt = "Occupy the configured concurrent run slot.";
    const first = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "run-configured-capacity-first",
      promptCharacters: firstPrompt.length,
      promptDigest: await digestRunPrompt(firstPrompt),
    });

    expect(first).toMatchObject({
      ok: true,
      permit: {
        budgetReservation: { retentionSeconds: runRetentionSeconds },
      },
      state: "issued",
    });
    const secondPrompt = "Exceed the configured concurrent run slot.";
    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "run-configured-capacity-second",
        promptCharacters: secondPrompt.length,
        promptDigest: await digestRunPrompt(secondPrompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("admission_limit_exceeded"));
  });

  it("filters fleet-wide run summaries by Agent, status, trigger, and creation time", async () => {
    const authority = await authorityFor("run-list-filters", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("run-list-filters-agent"));

    if (!created.ok) {
      throw new Error("Expected run-list filter Agent.");
    }

    const createdAfter = new Date(Date.now() - 1_000).toISOString();
    const admissions = await Promise.all(
      (["manual", "schedule"] as const).map(async (trigger) => {
        const prompt = `Create the ${trigger} list fixture.`;

        return stub.createRunAdmission(authority, {
          agentId: created.agent.id,
          expectedRevision: created.agent.revision,
          idempotencyKey: `run-list-filter-${trigger}`,
          promptCharacters: prompt.length,
          promptDigest: await digestRunPrompt(prompt),
          scheduleRevision: trigger === "schedule" ? 1 : null,
          trigger,
        });
      }),
    );
    const createdBefore = new Date(Date.now() + 1_000).toISOString();

    expect(admissions.every((admission) => admission.ok)).toBe(true);
    await expect(
      stub.listAgentRuns(authority, {
        createdAfter,
        createdBefore,
        status: "queued",
        trigger: "schedule",
      }),
    ).resolves.toMatchObject({
      nextCursor: null,
      ok: true,
      runs: [
        {
          agentId: created.agent.id,
          status: "queued",
          trigger: "schedule",
        },
      ],
    });
    await expect(stub.listAgentRuns(authority, { status: "active" })).resolves.toMatchObject({
      nextCursor: null,
      ok: true,
      runs: [{ status: "queued" }, { status: "queued" }],
    });
    const firstPage = await stub.listAgentRuns(authority, { limit: 1 });

    if (!firstPage.ok || firstPage.nextCursor === null) {
      throw new Error("Expected a second fleet-wide run page.");
    }

    const cursorTrigger = firstPage.runs[0]?.trigger;

    if (cursorTrigger === undefined) {
      throw new Error("Expected a cursor run.");
    }

    await expect(
      stub.listAgentRuns(authority, {
        cursor: firstPage.nextCursor,
        trigger: cursorTrigger === "manual" ? "schedule" : "manual",
      }),
    ).resolves.toEqual({
      error: { code: "invalid_request", message: "Run request denied." },
      ok: false,
    });
    await expect(
      stub.listAgentRuns(authority, {
        agentId: created.agent.id,
        cursor: firstPage.nextCursor,
        limit: 1,
      }),
    ).resolves.toMatchObject({ nextCursor: null, ok: true, runs: [{}] });
    await expect(
      stub.listAgentRuns(authority, {
        createdAfter: createdBefore,
        createdBefore: createdAfter,
      }),
    ).resolves.toEqual({
      error: { code: "invalid_request", message: "Run request denied." },
      ok: false,
    });
  });

  it("ages a redeemed run without a terminal projection into a failed summary", async () => {
    const authority = await authorityFor("run-stale-projection", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("run-stale-projection-agent"));

    if (!created.ok) {
      throw new Error("Expected stale-run Agent.");
    }

    const prompt = "Exercise a run whose detailed state becomes unavailable.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "run-stale-projection",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected stale-run admission.");
    }

    await expect(stub.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
    const deadlineAt = Date.now() - 1_000;
    const redeemedAt = deadlineAt - admission.permit.budgetReservation.maxDurationSeconds * 1_000;

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_admissions SET created_at = ?, redeemed_at = ? WHERE run_id = ?",
        redeemedAt - 1,
        redeemedAt,
        admission.permit.runId,
      );
    });
    await expect(
      stub.listAgentRuns(authority, {
        agentId: created.agent.id,
        status: "failed",
      }),
    ).resolves.toMatchObject({
      nextCursor: null,
      ok: true,
      runs: [
        {
          completedAt: new Date(deadlineAt).toISOString(),
          runId: admission.permit.runId,
          status: "failed",
        },
      ],
    });
    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: {
        usage: {
          runs: { active: 0 },
        },
      },
    });
  });

  it("issues, rotates, verifies, redeems, and audits an opaque run admission durably", async () => {
    const authority = await authorityFor("230", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
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
          maxInputCharacters:
            created.agent.instructions.length + prompt.length + MAXIMUM_SESSION_CONTEXT_CHARACTERS,
          maxModelCalls: 1,
          maxOutputTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
          maxToolCalls: 0,
          maxTurns: 1,
          reservationId: expect.stringMatching(/^budget_/),
          runtimePlan: {
            inference: {
              model: created.agent.model,
              moduleId: "inference.workers-ai",
              schemaVersion: 2,
            },
          },
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
        capabilities: created.agent.capabilities,
        capabilityGrants: [],
        executionLimits: created.agent.executionLimits,
        instructions: created.agent.instructions,
        ownerKey: authority.ownerKey,
        revision: created.agent.revision,
        runtimePlan: replay.permit.budgetReservation.runtimePlan,
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
      modelCall: 1,
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
        scheduleRevision: null,
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

  it("admits supported models and enforces model and provider prerequisites", async () => {
    const authority = await authorityFor("236", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    await expect(
      stub.configureModelCatalog(authority, {
        change: { kind: "add", modelId: "openai/gpt-5.6-luna" },
        expectedRevision: 1,
        idempotencyKey: "enable-gateway-model-236",
        mode: "apply",
        target: { kind: "model-catalog" },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    const supported = await stub.createAgent(authority, {
      ...agentInput("create-supported-model-agent-236"),
      capabilities: [
        workersAiCapabilityConfiguration("@cf/zai-org/glm-4.7-flash", {
          fallbackModels: ["@cf/openai/gpt-oss-120b"],
        }),
      ],
    });
    const unlisted = await stub.createAgent(authority, {
      ...agentInput("create-unlisted-model-agent-236"),
      capabilities: [
        {
          configuration: { model: "@cf/example/unlisted-model" },
          id: "inference.workers-ai",
          schemaVersion: 1,
        },
      ],
    });
    const gateway = await stub.createAgent(authority, {
      ...agentInput("create-gateway-model-agent-236"),
      capabilities: [aiGatewayCapabilityConfiguration("openai/gpt-5.6-luna")],
    });
    const prompt = "Perform the exact admitted task.";

    if (!supported.ok || !gateway.ok) {
      throw new Error("Expected supported model-policy fixture Agent.");
    }
    expect(unlisted).toEqual({
      error: { code: "model_disabled", message: "Agent request denied." },
      ok: false,
    });

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
          maxModelCalls: 2,
          runtimePlan: {
            inference: {
              fallbackModels: ["@cf/openai/gpt-oss-120b"],
              model: "@cf/zai-org/glm-4.7-flash",
            },
          },
        },
      },
      state: "issued",
    });
    await expect(
      stub.createRunAdmission(authority, {
        agentId: gateway.agent.id,
        expectedRevision: gateway.agent.revision,
        idempotencyKey: "admit-gateway-model-236",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toMatchObject({
      error: {
        code: "capability_unavailable",
      },
      ok: false,
    });
  });

  it("denies malformed, unauthorized, conflicting, cross-owner, stale, and expired admissions", async () => {
    const authority = await authorityFor("231", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
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

    const scheduledInput = {
      ...input,
      idempotencyKey: "admit-scheduled-run-231",
      scheduleRevision: 1,
      trigger: "schedule" as const,
    };
    await expect(stub.createRunAdmission(authority, scheduledInput)).resolves.toMatchObject({
      created: true,
      ok: true,
      state: "issued",
    });
    await expect(
      stub.createRunAdmission(authority, {
        ...scheduledInput,
        scheduleRevision: 2,
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
    const authority = await authorityFor("233", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
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
          maxInputCharacters:
            created.agent.instructions.length + 1 + MAXIMUM_SESSION_CONTEXT_CHARACTERS,
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

  it("does not apply a second fleet dollar ceiling to admitted runs", async () => {
    const authority = await authorityFor("234", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-234"));

    if (!created.ok) {
      throw new Error("Expected run-budget fixture Agent.");
    }

    const prompt = "Each admitted run keeps a cost estimate for observability.";
    const first = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "within-run-budget-234",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    expect(first).toMatchObject({ ok: true, state: "issued" });

    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "second-run-without-local-dollar-cap-234",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toMatchObject({ ok: true, state: "issued" });
  });

  it("invalidates issued run authority when the fleet configuration revision changes", async () => {
    const authority = await authorityFor("235", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-235"));

    if (!created.ok) {
      throw new Error("Expected fleet-revision run fixture Agent.");
    }

    const prompt = "Run only under the exact admitted fleet policy.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "fleet-revision-run-235",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });
    const current = await stub.getFleetConfiguration(authority, { target: { kind: "fleet" } });

    if (!admission.ok || admission.state !== "issued" || !current.ok) {
      throw new Error("Expected fleet-revision run admission.");
    }

    await expect(
      stub.configureFleetConfiguration(authority, {
        expectedRevision: current.configuration.revision,
        idempotencyKey: "advance-fleet-revision-235",
        mode: "apply",
        patch: { schedules: { minimumIntervalSeconds: 120 } },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    await expect(stub.verifyRunAdmission(admission.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(stub.confirmRunAdmission(admission.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
  });

  it("denies Workflow admission against a fleet revision that changed before issuance", async () => {
    const authority = await authorityFor("236", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-236"));
    const current = await stub.getFleetConfiguration(authority, { target: { kind: "fleet" } });

    if (!created.ok || !current.ok) {
      throw new Error("Expected exact fleet-revision Workflow fixture.");
    }

    const changed = await stub.configureFleetConfiguration(authority, {
      expectedRevision: current.configuration.revision,
      idempotencyKey: "advance-workflow-fleet-revision-236",
      mode: "apply",
      patch: { schedules: { minimumIntervalSeconds: 120 } },
      target: { kind: "fleet" },
    });

    if (!changed.ok || !changed.applied) {
      throw new Error("Expected fleet policy revision change.");
    }

    const prompt = "Never admit this stage against a later fleet policy.";
    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedFleetRevision: current.configuration.revision,
        expectedRevision: created.agent.revision,
        idempotencyKey: "stale-workflow-fleet-revision-236",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
        trigger: "workflow",
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("revision_conflict"));
  });
});
