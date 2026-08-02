import { describe, expect, it, vi } from "vitest";

import { readBoundedJson } from "./bounded-json.js";

describe("bounded Composio JSON", () => {
  it("returns parsed JSON as an explicit success value", async () => {
    await expect(readBoundedJson(Response.json({ ok: true }), 1_024)).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it("rejects an invalid byte budget as a value", async () => {
    await expect(readBoundedJson(Response.json({ ok: true }), -1)).resolves.toEqual({
      error: { code: "invalid_limit" },
      ok: false,
    });
  });

  it("classifies malformed and non-UTF-8 provider bodies without throwing", async () => {
    await expect(readBoundedJson(new Response("not json"), 1_024)).resolves.toEqual({
      error: { code: "invalid_json" },
      ok: false,
    });
    await expect(
      readBoundedJson(new Response(Uint8Array.from([0xff, 0xfe])), 1_024),
    ).resolves.toEqual({ error: { code: "invalid_utf8" }, ok: false });
  });

  it("bounds provider bytes and contains stream failures", async () => {
    const cancel = vi.fn<(reason?: unknown) => void>();
    const oversized = new Response(
      new ReadableStream({
        cancel,
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
      }),
    );

    await expect(readBoundedJson(oversized, 4)).resolves.toEqual({
      error: { code: "response_too_large" },
      ok: false,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(oversized.body?.locked).toBe(false);

    const unavailable = new Response(
      new ReadableStream({
        pull() {
          throw new Error("Provider stream failed.");
        },
      }),
    );
    await expect(readBoundedJson(unavailable, 1_024)).resolves.toEqual({
      error: { code: "response_unavailable" },
      ok: false,
    });
    expect(unavailable.body?.locked).toBe(false);
  });
});
