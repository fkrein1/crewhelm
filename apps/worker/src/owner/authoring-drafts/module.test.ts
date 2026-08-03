import {
  MAXIMUM_MCP_AUTHORING_DRAFTS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  mcpAuthoringDraftResultSchema,
} from "@crewhelm/contracts";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { authorityFor } from "../testkit.js";

function skillTarget(name = "draft-skill") {
  return {
    kind: "skill-package" as const,
    package: {
      description: "Review a bounded change before publication.",
      files: [{ content: "# Review\n\nCheck the exact change.", path: "SKILL.md" }],
      name,
      provenance: { kind: "authored" as const },
    },
  };
}

describe("OwnerControlPlane MCP authoring drafts", () => {
  it("creates, replays, revisions, isolates, expires, and discards bounded drafts", async () => {
    const authority = await authorityFor("mcp-authoring-drafts", [OWNER_WRITE_SCOPE]);
    const otherClient = await authorityFor(
      "mcp-authoring-drafts",
      [OWNER_WRITE_SCOPE],
      "https://other-client.example/mcp.json",
    );
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const create = {
      action: "create" as const,
      content: skillTarget(),
      idempotencyKey: "draft-create",
      kind: "skill-package" as const,
    };
    const created = mcpAuthoringDraftResultSchema.parse(
      await Promise.resolve(stub.mcpAuthoringDrafts(authority, create)),
    );
    expect(created).toMatchObject({ action: "create", ok: true, replayed: false });
    if (!created.ok || created.action !== "create") throw new Error("Expected draft creation.");

    await expect(stub.mcpAuthoringDrafts(authority, create)).resolves.toMatchObject({
      action: "create",
      draft: created.draft,
      ok: true,
      replayed: true,
    });
    await expect(
      stub.mcpAuthoringDrafts(authority, { ...create, content: skillTarget("other-name") }),
    ).resolves.toMatchObject({ error: { code: "idempotency_conflict" }, ok: false });
    await expect(
      stub.mcpAuthoringDrafts(otherClient, { action: "read", draft: created.draft }),
    ).resolves.toMatchObject({ error: { code: "draft_not_found" }, ok: false });

    const replaced = mcpAuthoringDraftResultSchema.parse(
      await Promise.resolve(
        stub.mcpAuthoringDrafts(authority, {
          action: "replace",
          content: skillTarget("revised-skill"),
          draft: created.draft,
          idempotencyKey: "draft-replace",
        }),
      ),
    );
    expect(replaced).toMatchObject({ action: "replace", draft: { revision: 2 }, ok: true });
    if (!replaced.ok || replaced.action !== "replace") throw new Error("Expected draft revision.");
    await expect(
      stub.mcpAuthoringDrafts(authority, { action: "read", draft: created.draft }),
    ).resolves.toMatchObject({ error: { code: "revision_conflict" }, ok: false });
    await expect(
      stub.mcpAuthoringDrafts(authority, {
        action: "replace",
        content: skillTarget("revised-skill"),
        draft: created.draft,
        idempotencyKey: "draft-replace",
      }),
    ).resolves.toMatchObject({ action: "replace", draft: replaced.draft, replayed: true });

    await expect(
      stub.mcpAuthoringDrafts(authority, { action: "discard", draft: replaced.draft }),
    ).resolves.toMatchObject({ action: "discard", discarded: true, ok: true });
    await expect(
      stub.mcpAuthoringDrafts(authority, { action: "read", draft: replaced.draft }),
    ).resolves.toMatchObject({ error: { code: "draft_not_found" }, ok: false });

    const expiring = mcpAuthoringDraftResultSchema.parse(
      await Promise.resolve(
        stub.mcpAuthoringDrafts(authority, { ...create, idempotencyKey: "draft-expiring" }),
      ),
    );
    if (!expiring.ok || expiring.action !== "create") throw new Error("Expected expiring draft.");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE mcp_authoring_drafts SET expires_at = 1 WHERE draft_id = ?",
        expiring.draft.id,
      );
    });
    await expect(
      stub.mcpAuthoringDrafts(authority, { action: "read", draft: expiring.draft }),
    ).resolves.toMatchObject({ error: { code: "draft_not_found" }, ok: false });
  });

  it("enforces scope, content validation, and the active draft limit", async () => {
    const authority = await authorityFor("mcp-authoring-draft-limits", [OWNER_WRITE_SCOPE]);
    const otherClient = await authorityFor(
      "mcp-authoring-draft-limits",
      [OWNER_WRITE_SCOPE],
      "https://other-client.example/mcp.json",
    );
    const readOnly = await authorityFor("mcp-authoring-draft-limits", [OWNER_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    await expect(
      stub.mcpAuthoringDrafts(readOnly, {
        action: "create",
        content: skillTarget(),
        idempotencyKey: "read-only",
        kind: "skill-package",
      }),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });
    await expect(
      stub.mcpAuthoringDrafts(authority, {
        action: "create",
        content: { kind: "skill-package", package: {} },
        idempotencyKey: "invalid",
        kind: "skill-package",
      }),
    ).resolves.toMatchObject({ error: { code: "invalid_request" }, ok: false });

    for (let index = 0; index < MAXIMUM_MCP_AUTHORING_DRAFTS; index += 1) {
      await expect(
        stub.mcpAuthoringDrafts(authority, {
          action: "create",
          content: skillTarget(`draft-skill-${index}`),
          idempotencyKey: `draft-limit-${index}`,
          kind: "skill-package",
        }),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      stub.mcpAuthoringDrafts(authority, {
        action: "create",
        content: skillTarget("one-too-many"),
        idempotencyKey: "draft-limit-overflow",
        kind: "skill-package",
      }),
    ).resolves.toMatchObject({ error: { code: "draft_limit_exceeded" }, ok: false });
    await expect(
      stub.mcpAuthoringDrafts(otherClient, {
        action: "create",
        content: skillTarget("other-client-overflow"),
        idempotencyKey: "draft-limit-other-client",
        kind: "skill-package",
      }),
    ).resolves.toMatchObject({ error: { code: "draft_limit_exceeded" }, ok: false });
  });

  it("fails closed under concurrent creation and replacement", async () => {
    const authority = await authorityFor("mcp-authoring-draft-concurrency", [OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const create = {
      action: "create" as const,
      content: skillTarget(),
      idempotencyKey: "concurrent-create",
      kind: "skill-package" as const,
    };
    const sameKey = (
      await Promise.all([
        Promise.resolve(stub.mcpAuthoringDrafts(authority, create)),
        Promise.resolve(stub.mcpAuthoringDrafts(authority, create)),
      ])
    ).map((result) => mcpAuthoringDraftResultSchema.parse(result));
    expect(sameKey).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "create", ok: true, replayed: false }),
        expect.objectContaining({ action: "create", ok: true, replayed: true }),
      ]),
    );
    const created = mcpAuthoringDraftResultSchema.parse(sameKey[0]);
    if (!created.ok || created.action !== "create") throw new Error("Expected draft creation.");

    const replacements = (
      await Promise.all([
        Promise.resolve(
          stub.mcpAuthoringDrafts(authority, {
            action: "replace",
            content: skillTarget("concurrent-a"),
            draft: created.draft,
            idempotencyKey: "concurrent-replace-a",
          }),
        ),
        Promise.resolve(
          stub.mcpAuthoringDrafts(authority, {
            action: "replace",
            content: skillTarget("concurrent-b"),
            draft: created.draft,
            idempotencyKey: "concurrent-replace-b",
          }),
        ),
      ])
    ).map((result) => mcpAuthoringDraftResultSchema.parse(result));
    expect(replacements.filter((result) => result.ok)).toHaveLength(1);
    expect(replacements.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "revision_conflict" }),
        ok: false,
      }),
    ]);

    const capacityAuthority = await authorityFor("mcp-authoring-draft-concurrent-limit", [
      OWNER_WRITE_SCOPE,
    ]);
    const capacityStub = env.OWNER_CONTROL_PLANE.getByName(capacityAuthority.ownerKey);
    const capacity = (
      await Promise.all(
        Array.from({ length: MAXIMUM_MCP_AUTHORING_DRAFTS + 2 }, (_, index) =>
          Promise.resolve(
            capacityStub.mcpAuthoringDrafts(capacityAuthority, {
              action: "create",
              content: skillTarget(`concurrent-limit-${index}`),
              idempotencyKey: `concurrent-limit-${index}`,
              kind: "skill-package",
            }),
          ),
        ),
      )
    ).map((result) => mcpAuthoringDraftResultSchema.parse(result));
    expect(capacity.filter((result) => result.ok)).toHaveLength(MAXIMUM_MCP_AUTHORING_DRAFTS);
    expect(capacity.filter((result) => !result.ok)).toHaveLength(2);
  });
});
