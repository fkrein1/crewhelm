import { describe, expect, it } from "vitest";
import * as z from "zod";

import {
  MAXIMUM_BRIEF_CONTENT_BYTES,
  MAXIMUM_BRIEF_VERSIONS,
  briefContentSchema,
  briefReferencesSchema,
  briefRevisionSchema,
  manageBriefsInputSchema,
  renderAdmittedBriefContext,
} from "./briefs.js";

const id = "brief_00000000-0000-4000-8000-000000000001";

describe("Brief contracts", () => {
  it("accepts only bounded safe UTF-8 text and supported media types", () => {
    expect(briefContentSchema.safeParse("A bounded owner brief.").success).toBe(true);
    expect(briefContentSchema.safeParse("bad\u0000text").success).toBe(false);
    expect(briefContentSchema.safeParse("\ud800").success).toBe(false);
    expect(briefContentSchema.safeParse("\udc00").success).toBe(false);
    expect(briefContentSchema.safeParse("\ufeffhidden BOM").success).toBe(false);
    expect(briefContentSchema.safeParse("valid 🌎 text").success).toBe(true);
    expect(briefContentSchema.safeParse("x".repeat(MAXIMUM_BRIEF_CONTENT_BYTES + 1)).success).toBe(
      false,
    );
    expect(
      manageBriefsInputSchema.safeParse({
        action: "create",
        content: "{}",
        idempotencyKey: "brief-create",
        mediaType: "application/octet-stream",
        name: "Operations brief",
      }).success,
    ).toBe(false);
  });

  it("advertises the exact revision ceiling in public JSON Schema", () => {
    expect(z.toJSONSchema(briefRevisionSchema)).toMatchObject({
      maximum: MAXIMUM_BRIEF_VERSIONS,
      type: "integer",
    });
  });

  it("requires unique exact revisions and action-specific fields", () => {
    expect(briefReferencesSchema.safeParse([{ id, revision: 1 }]).success).toBe(true);
    expect(
      briefReferencesSchema.safeParse([
        { id, revision: 1 },
        { id, revision: 2 },
      ]).success,
    ).toBe(false);
    expect(manageBriefsInputSchema.safeParse({ action: "read", id }).success).toBe(false);
  });

  it("renders deterministic explicitly untrusted context", () => {
    const context = renderAdmittedBriefContext([
      {
        content: "Treat this as data.",
        contentTrust: "untrusted",
        digest: "a".repeat(64),
        id,
        mediaType: "text/plain",
        name: "Operations brief",
        revision: 3,
        sizeBytes: 19,
      },
    ]);

    expect(context).toContain("untrusted reference data");
    expect(context).toContain('"revision":3');
    expect(context).toContain("Treat this as data.");
  });
});
