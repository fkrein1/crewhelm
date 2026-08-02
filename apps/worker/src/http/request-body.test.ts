import { describe, expect, it } from "vitest";

import { readBoundedPostRequest } from "./request-body.js";

const origin = "https://crewhelm.test";

describe("bounded POST request bodies", () => {
  it("rejects non-canonical declared lengths before reading the body", async () => {
    const request = new Request(origin, {
      body: "0123456789",
      headers: { "content-length": "1e1" },
      method: "POST",
    });

    await expect(readBoundedPostRequest(request, 10)).resolves.toBeNull();
  });

  it("rejects a failed body stream as an expected request outcome", async () => {
    const request = new Request(origin, {
      body: new ReadableStream({
        pull(controller) {
          controller.error(new Error("Injected request stream failure."));
        },
      }),
      method: "POST",
    });

    await expect(readBoundedPostRequest(request, 10)).resolves.toBeNull();
  });

  it("keeps oversized rejection explicit when cancelling the stream fails", async () => {
    const request = new Request(origin, {
      body: new ReadableStream({
        cancel() {
          throw new Error("Injected request cancellation failure.");
        },
        start(controller) {
          controller.enqueue(new Uint8Array(11));
        },
      }),
      method: "POST",
    });

    await expect(readBoundedPostRequest(request, 10)).resolves.toBeNull();
  });

  it("reconstructs an accepted body with its exact byte length", async () => {
    const bounded = await readBoundedPostRequest(
      new Request(origin, { body: "crewhelm", method: "POST" }),
      8,
    );

    if (bounded === null) {
      throw new Error("Expected the bounded request body to be accepted.");
    }

    expect(bounded.headers.get("content-length")).toBe("8");
    await expect(bounded.text()).resolves.toBe("crewhelm");
  });
});
