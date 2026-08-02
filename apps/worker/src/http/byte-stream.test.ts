import { describe, expect, it } from "vitest";

import { readByteStreamChunk } from "./byte-stream.js";

describe("readByteStreamChunk", () => {
  it("accepts byte chunks and terminal reads", async () => {
    await expect(
      readByteStreamChunk({
        read: () => Promise.resolve({ done: false, value: new Uint8Array([1]) }),
      }),
    ).resolves.toEqual({ done: false, value: new Uint8Array([1]) });
    await expect(
      readByteStreamChunk({ read: () => Promise.resolve({ done: true }) }),
    ).resolves.toEqual({ done: true, value: undefined });
  });

  it.each([null, { done: false, value: "not bytes" }, { done: "false", value: new Uint8Array() }])(
    "rejects invalid host stream chunks",
    async (chunk) => {
      await expect(readByteStreamChunk({ read: () => Promise.resolve(chunk) })).rejects.toThrow(
        "Response body stream returned an invalid chunk.",
      );
    },
  );
});
