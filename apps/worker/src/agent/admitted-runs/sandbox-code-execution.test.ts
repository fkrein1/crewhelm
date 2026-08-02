import { describe, expect, it, vi } from "vitest";

import {
  runBoundedSandboxCleanup,
  runBoundedSandboxCode,
  sandboxContainerTimeouts,
} from "./sandbox-code-execution.js";

function stream(...events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    },
  });
}

describe("bounded Sandbox code streaming", () => {
  it("bounds container startup to the admitted duration or SDK minimums", () => {
    expect(sandboxContainerTimeouts(5_000)).toEqual({
      instanceGetTimeoutMS: 5_000,
      portReadyTimeoutMS: 10_000,
      waitIntervalMS: 250,
    });
    expect(sandboxContainerTimeouts(30_000)).toEqual({
      instanceGetTimeoutMS: 10_000,
      portReadyTimeoutMS: 20_000,
      waitIntervalMS: 250,
    });
  });

  it("hands a slow direct cleanup to background recovery without extending the tool call", async () => {
    const lateCleanups: Promise<void>[] = [];

    await expect(
      runBoundedSandboxCleanup({
        cleanup: () => new Promise(() => undefined),
        timeoutMs: 1,
        trackLateCleanup: (cleanup) => lateCleanups.push(cleanup),
      }),
    ).resolves.toBeUndefined();
    expect(lateCleanups).toHaveLength(1);
  });

  it("leaves failed direct cleanup to the durable owner ledger", async () => {
    await expect(
      runBoundedSandboxCleanup({
        cleanup: () => Promise.reject(new Error("Sandbox cleanup unavailable.")),
        timeoutMs: 1_000,
        trackLateCleanup: () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("collects only compact textual execution events", async () => {
    await expect(
      runBoundedSandboxCode({
        cleanupAfterLateOpen: async () => undefined,
        code: "print(6 * 7)",
        maximumStreamBytes: 1_024,
        openStream: () =>
          Promise.resolve(
            stream(
              JSON.stringify({ text: "42", type: "stdout" }),
              JSON.stringify({ json: { answer: 42 }, markdown: "**42**", type: "result" }),
              JSON.stringify({ html: "<script>unsafe()</script>", type: "result" }),
              JSON.stringify({ type: "execution_complete" }),
            ),
          ),
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        trackLateCleanup: () => undefined,
      }),
    ).resolves.toEqual({
      code: "print(6 * 7)",
      logs: { stderr: [], stdout: ["42"] },
      results: [{ json: { answer: 42 }, markdown: "**42**" }],
    });
  });

  it("cancels a stream as soon as raw output crosses the admitted bound", async () => {
    const cancelled = vi.fn<() => Promise<void>>(() => new Promise(() => undefined));
    const lateCleanups: Promise<void>[] = [];
    const encoder = new TextEncoder();
    const output = new ReadableStream<Uint8Array>({
      cancel: cancelled,
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: "x".repeat(900), type: "stdout" })}\n\n`),
        );
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: "y".repeat(900), type: "stderr" })}\n\n`),
        );
      },
    });
    const result = await runBoundedSandboxCode({
      cleanupAfterLateOpen: async () => undefined,
      code: "while True: print('x')",
      maximumStreamBytes: 1_024,
      openStream: () => Promise.resolve(output),
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      trackLateCleanup: (cleanup) => lateCleanups.push(cleanup),
    });

    expect(result).toMatchObject({
      error: { name: "OutputLimitError" },
      logs: { stderr: [], stdout: [] },
      results: [],
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(lateCleanups).toHaveLength(1);
  });

  it("bounds a stream that never opens and preserves caller cancellation", async () => {
    await expect(
      runBoundedSandboxCode({
        cleanupAfterLateOpen: async () => undefined,
        code: "while True: pass",
        maximumStreamBytes: 1_024,
        openStream: () => new Promise(() => undefined),
        signal: new AbortController().signal,
        timeoutMs: 1,
        trackLateCleanup: () => undefined,
      }),
    ).resolves.toMatchObject({ error: { name: "TimeoutError" } });

    const cancellation = new AbortController();
    cancellation.abort(new Error("Run cancelled."));
    await expect(
      runBoundedSandboxCode({
        cleanupAfterLateOpen: async () => undefined,
        code: "while True: pass",
        maximumStreamBytes: 1_024,
        openStream: () => new Promise(() => undefined),
        signal: cancellation.signal,
        timeoutMs: 1_000,
        trackLateCleanup: () => undefined,
      }),
    ).rejects.toThrow("Run cancelled.");
  });

  it("removes interruption state when stream acquisition throws synchronously", async () => {
    vi.useFakeTimers();

    try {
      await expect(
        runBoundedSandboxCode({
          cleanupAfterLateOpen: async () => undefined,
          code: "print('never opened')",
          maximumStreamBytes: 1_024,
          openStream: () => {
            throw new Error("Sandbox stream unavailable.");
          },
          signal: new AbortController().signal,
          timeoutMs: 1_000,
          trackLateCleanup: () => undefined,
        }),
      ).rejects.toThrow("Sandbox stream unavailable.");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes interruption state when the acquired stream is already locked", async () => {
    vi.useFakeTimers();
    const output = new ReadableStream<Uint8Array>();
    const existingReader = output.getReader();

    try {
      await expect(
        runBoundedSandboxCode({
          cleanupAfterLateOpen: async () => undefined,
          code: "print('locked stream')",
          maximumStreamBytes: 1_024,
          openStream: () => Promise.resolve(output),
          signal: new AbortController().signal,
          timeoutMs: 1_000,
          trackLateCleanup: () => undefined,
        }),
      ).rejects.toThrow(/locked/u);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      existingReader.releaseLock();
      vi.useRealTimers();
    }
  });

  it("cancels a stream that opens after timeout and re-runs final cleanup", async () => {
    let resolveOpening: ((stream: ReadableStream<Uint8Array>) => void) | undefined;
    const opening = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveOpening = resolve;
    });
    const cancelled = vi.fn<() => void>();
    const lateCleanups: Promise<void>[] = [];
    const cleanupAfterLateOpen = vi.fn<() => Promise<void>>(async () => undefined);
    const result = await runBoundedSandboxCode({
      cleanupAfterLateOpen,
      code: "while True: pass",
      maximumStreamBytes: 1_024,
      openStream: () => opening,
      signal: new AbortController().signal,
      timeoutMs: 1,
      trackLateCleanup: (cleanup) => lateCleanups.push(cleanup),
    });

    expect(result).toMatchObject({ error: { name: "TimeoutError" } });
    expect(lateCleanups).toHaveLength(1);
    resolveOpening?.(new ReadableStream({ cancel: cancelled }));
    await Promise.all(lateCleanups);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(cleanupAfterLateOpen).toHaveBeenCalledOnce();
  });

  it("cancels a stream that opens after caller cancellation and re-runs final cleanup", async () => {
    let resolveOpening: ((stream: ReadableStream<Uint8Array>) => void) | undefined;
    const opening = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveOpening = resolve;
    });
    const cancelled = vi.fn<() => void>();
    const lateCleanups: Promise<void>[] = [];
    const cleanupAfterLateOpen = vi.fn<() => Promise<void>>(async () => undefined);
    const cancellation = new AbortController();
    const running = runBoundedSandboxCode({
      cleanupAfterLateOpen,
      code: "while True: pass",
      maximumStreamBytes: 1_024,
      openStream: () => opening,
      signal: cancellation.signal,
      timeoutMs: 1_000,
      trackLateCleanup: (cleanup) => lateCleanups.push(cleanup),
    });

    cancellation.abort(new Error("Run cancelled."));
    await expect(running).rejects.toThrow("Run cancelled.");
    expect(lateCleanups).toHaveLength(1);
    resolveOpening?.(new ReadableStream({ cancel: cancelled }));
    await Promise.all(lateCleanups);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(cleanupAfterLateOpen).toHaveBeenCalledOnce();
  });
});
