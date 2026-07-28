import { describe, expect, it } from "vitest";

import { digestToolInput } from "./protocol.js";

describe("admitted run protocol", () => {
  it("digests semantically identical JSON objects canonically", async () => {
    const first = {
      filters: { archived: false, labels: ["urgent", "customer"] },
      issue: 42,
    };
    const reordered = {
      issue: 42,
      filters: { labels: ["urgent", "customer"], archived: false },
    };

    await expect(digestToolInput(first)).resolves.toBe(await digestToolInput(reordered));
    await expect(
      digestToolInput({ ...first, filters: { ...first.filters, labels: ["customer", "urgent"] } }),
    ).resolves.not.toBe(await digestToolInput(first));
  });
});
