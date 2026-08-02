import {
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  createBriefResultSchema,
  deleteBriefResultSchema,
  inspectBriefResultSchema,
  listBriefsResultSchema,
  readBriefResultSchema,
  reviseBriefResultSchema,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { agentInput, authorityFor } from "../testkit.js";
import { workflowDeliverableStorageFailure } from "./module.js";

describe("Brief storage control flow", () => {
  it("translates every Brief storage failure at the Workflow boundary", () => {
    expect(workflowDeliverableStorageFailure("brief_storage_corrupt")).toEqual({
      code: "storage_corrupt",
      ok: false,
    });
    expect(workflowDeliverableStorageFailure("brief_storage_unavailable")).toEqual({
      code: "storage_unavailable",
      ok: false,
    });
  });
});

describe("OwnerControlPlane Briefs", () => {
  it("creates, revisions, lists, reads exactly, freezes into Runs, and deletes only when unreferenced", async () => {
    const authority = await authorityFor("brief-lifecycle", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const createInput = {
      content: "Use confirmed operational facts and label uncertainty.",
      idempotencyKey: "brief-create",
      mediaType: "text/markdown" as const,
      name: "Operations brief",
    };
    const created = createBriefResultSchema.parse(await stub.createBrief(authority, createInput));

    expect(created).toMatchObject({
      applied: true,
      brief: { currentRevision: 1, name: "Operations brief", versionCount: 1 },
      ok: true,
      version: { contentTrust: "untrusted", revision: 1 },
    });
    if (!created.ok) throw new Error("Expected Brief creation.");

    await expect(stub.createBrief(authority, createInput)).resolves.toMatchObject({
      applied: false,
      brief: { id: created.brief.id },
      ok: true,
    });
    expect(listBriefsResultSchema.parse(await stub.listBriefs(authority, {}))).toMatchObject({
      briefs: [{ id: created.brief.id }],
      nextCursor: null,
      ok: true,
    });
    expect(
      inspectBriefResultSchema.parse(await stub.inspectBrief(authority, { id: created.brief.id })),
    ).toMatchObject({ ok: true, version: { revision: 1 } });
    expect(
      readBriefResultSchema.parse(
        await stub.readBrief(authority, { id: created.brief.id, revision: 1 }),
      ),
    ).toMatchObject({ ok: true, content: { content: createInput.content } });

    const sqliteText = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>(
          `SELECT group_concat(value, '') AS value FROM (
             SELECT CAST(name AS TEXT) AS value FROM sqlite_master
             UNION ALL SELECT CAST(name AS TEXT) FROM briefs
             UNION ALL SELECT CAST(object_key AS TEXT) FROM brief_versions
           )`,
        )
        .one(),
    );
    expect(sqliteText.value).not.toContain(createInput.content);

    const revised = reviseBriefResultSchema.parse(
      await stub.reviseBrief(authority, {
        content: "Use verified facts, label uncertainty, and end with next actions.",
        expectedRevision: 1,
        id: created.brief.id,
        idempotencyKey: "brief-revise",
        mediaType: "text/markdown",
      }),
    );
    expect(revised).toMatchObject({
      applied: true,
      brief: { currentRevision: 2, versionCount: 2 },
      ok: true,
      version: { revision: 2 },
    });

    const agent = await stub.createAgent(authority, agentInput("brief-agent"));
    if (!agent.ok) throw new Error("Expected Agent creation.");
    const writeOnly = { ...authority, scopes: [RUNS_WRITE_SCOPE] };
    await expect(
      stub.startRun(writeOnly, {
        agentId: agent.agent.id,
        briefs: [{ id: created.brief.id, revision: 1 }],
        expectedRevision: agent.agent.revision,
        idempotencyKey: "brief-run-without-read",
        prompt: "Attempt to use unreadable context.",
      }),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });
    await expect(
      stub.startAgentWorkflow(writeOnly, {
        agentId: agent.agent.id,
        briefs: [{ id: created.brief.id, revision: 1 }],
        expectedRevision: agent.agent.revision,
        idempotencyKey: "brief-workflow-without-read",
        objective: "Attempt a Workflow with unreadable context.",
        stages: [
          { name: "One", prompt: "Attempt the first stage." },
          { name: "Two", prompt: "Attempt the second stage." },
        ],
      }),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });
    const runInput = {
      agentId: agent.agent.id,
      briefs: [{ id: created.brief.id, revision: 1 }],
      expectedRevision: agent.agent.revision,
      idempotencyKey: "brief-run",
      prompt: "Acknowledge the admitted operations brief in one sentence.",
    };
    const run = await stub.startRun(authority, runInput);
    expect(run).toMatchObject({ ok: true });
    if (!run.ok) throw new Error("Expected Brief-backed Run.");
    const admittedContext = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ context: string }>(
            "SELECT brief_context AS context FROM run_admissions WHERE run_id = ?",
            run.run.runId,
          )
          .one().context,
    );
    expect(JSON.parse(admittedContext)).toMatchObject({
      references: [{ id: created.brief.id, revision: 1 }],
    });
    await expect(
      stub.deleteBrief(authority, {
        expectedRevision: 2,
        id: created.brief.id,
        idempotencyKey: "brief-delete-busy",
      }),
    ).resolves.toMatchObject({ error: { code: "brief_busy" }, ok: false });
    await env.SKILL_PACKAGES.delete(`briefs/${authority.ownerKey}/${created.brief.id}/1`);
    await expect(stub.startRun(authority, runInput)).resolves.toMatchObject({
      created: false,
      ok: true,
      run: { runId: run.run.runId },
    });

    const disposable = createBriefResultSchema.parse(
      await stub.createBrief(authority, {
        content: "Delete this unreferenced content.",
        idempotencyKey: "brief-disposable",
        mediaType: "text/plain",
        name: "Disposable brief",
      }),
    );
    if (!disposable.ok) throw new Error("Expected disposable Brief creation.");
    const deleted = deleteBriefResultSchema.parse(
      await stub.deleteBrief(authority, {
        expectedRevision: 1,
        id: disposable.brief.id,
        idempotencyKey: "brief-delete",
      }),
    );
    expect(deleted).toEqual({ deleted: true, id: disposable.brief.id, ok: true });
    await expect(
      stub.deleteBrief(authority, {
        expectedRevision: 1,
        id: disposable.brief.id,
        idempotencyKey: "brief-delete",
      }),
    ).resolves.toEqual(deleted);
    await expect(
      stub.readBrief(authority, { id: disposable.brief.id, revision: 1 }),
    ).resolves.toMatchObject({ error: { code: "brief_not_found" }, ok: false });
  });

  it("fails closed for secrets, stale revisions, conflicting replay, and missing content", async () => {
    const authority = await authorityFor("brief-denials", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(
      stub.createBrief(authority, {
        content: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
        idempotencyKey: "brief-secret",
        mediaType: "text/plain",
        name: "Unsafe brief",
      }),
    ).resolves.toMatchObject({ error: { code: "suspected_secret" }, ok: false });
    await expect(
      stub.createBrief(authority, {
        content: JSON.stringify({ nested: { token: "abcdefghijklmnop" } }),
        idempotencyKey: "brief-json-secret",
        mediaType: "application/json",
        name: "Unsafe JSON brief",
      }),
    ).resolves.toMatchObject({ error: { code: "suspected_secret" }, ok: false });
    for (const [index, content] of [
      { oauth: { client_secret: "abcdefghijklmnop" } },
      { auth: { access_token: "abcdefghijklmnop" } },
      { auth: { refreshToken: "abcdefghijklmnop" } },
      { signing: { production_private_key: "abcdefghijklmnop" } },
    ].entries()) {
      await expect(
        stub.createBrief(authority, {
          content: JSON.stringify(content),
          idempotencyKey: `brief-json-credential-${index}`,
          mediaType: "application/json",
          name: "Unsafe credential JSON brief",
        }),
      ).resolves.toMatchObject({ error: { code: "suspected_secret" }, ok: false });
    }
    const created = createBriefResultSchema.parse(
      await stub.createBrief(authority, {
        content: "Safe content.",
        idempotencyKey: "brief-safe",
        mediaType: "text/plain",
        name: "Safe brief",
      }),
    );
    if (!created.ok) throw new Error("Expected Brief creation.");
    await expect(
      stub.createBrief(authority, {
        content: "Different content.",
        idempotencyKey: "brief-safe",
        mediaType: "text/plain",
        name: "Safe brief",
      }),
    ).resolves.toMatchObject({ error: { code: "idempotency_conflict" }, ok: false });
    await expect(
      stub.reviseBrief(authority, {
        content: "Revision content.",
        expectedRevision: 2,
        id: created.brief.id,
        idempotencyKey: "brief-stale",
        mediaType: "text/plain",
      }),
    ).resolves.toMatchObject({ error: { code: "revision_conflict" }, ok: false });

    const objectKey = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ objectKey: string }>(
            "SELECT object_key AS objectKey FROM brief_versions WHERE brief_id = ? AND revision = 1",
            created.brief.id,
          )
          .one().objectKey,
    );
    await env.SKILL_PACKAGES.delete(objectKey);
    await expect(stub.readBrief(authority, { id: created.brief.id, revision: 1 })).resolves.toEqual(
      {
        error: {
          code: "brief_storage_corrupt",
          message: "Brief request denied.",
          operation: { nextAction: "contact_operator" },
        },
        ok: false,
      },
    );
    const agent = await stub.createAgent(authority, agentInput("missing-brief-agent"));
    if (!agent.ok) throw new Error("Expected Agent creation.");
    await expect(
      stub.startRun(authority, {
        agentId: agent.agent.id,
        briefs: [{ id: created.brief.id, revision: 1 }],
        expectedRevision: agent.agent.revision,
        idempotencyKey: "missing-brief-run",
        prompt: "Use the missing Brief.",
      }),
    ).resolves.toMatchObject({ error: { code: "brief_unavailable" }, ok: false });

    const largeReferences: { id: string; revision: number }[] = [];
    for (const index of [1, 2, 3]) {
      const large = await stub.createBrief(authority, {
        content: `${index}${"x".repeat(23_000)}`,
        idempotencyKey: `brief-large-${index}`,
        mediaType: "text/plain",
        name: `Large context ${index}`,
      });
      if (!large.ok) throw new Error("Expected large Brief fixture.");
      largeReferences.push({ id: large.brief.id, revision: 1 });
    }
    await expect(
      stub.startRun(authority, {
        agentId: agent.agent.id,
        briefs: largeReferences,
        expectedRevision: agent.agent.revision,
        idempotencyKey: "oversized-brief-context-run",
        prompt: "Use the oversized context.",
      }),
    ).resolves.toMatchObject({ error: { code: "brief_context_too_large" }, ok: false });
  });
});
