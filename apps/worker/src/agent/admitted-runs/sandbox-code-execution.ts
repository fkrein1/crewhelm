import type { ExecutionResult } from "@cloudflare/sandbox";

const MINIMUM_SANDBOX_INSTANCE_TIMEOUT_MS = 5_000;
const MINIMUM_SANDBOX_PORT_TIMEOUT_MS = 10_000;
const SANDBOX_STREAM_CANCEL_TIMEOUT_MS = 250;

export function sandboxContainerTimeouts(maximumDurationMs: number): {
  instanceGetTimeoutMS: number;
  portReadyTimeoutMS: number;
  waitIntervalMS: number;
} {
  const startupBudgetMs = Math.max(
    maximumDurationMs,
    MINIMUM_SANDBOX_INSTANCE_TIMEOUT_MS + MINIMUM_SANDBOX_PORT_TIMEOUT_MS,
  );
  const instanceGetTimeoutMS = Math.max(
    MINIMUM_SANDBOX_INSTANCE_TIMEOUT_MS,
    Math.floor(startupBudgetMs / 3),
  );

  return {
    instanceGetTimeoutMS,
    portReadyTimeoutMS: Math.max(
      MINIMUM_SANDBOX_PORT_TIMEOUT_MS,
      startupBudgetMs - instanceGetTimeoutMS,
    ),
    waitIntervalMS: 250,
  };
}

export async function runBoundedSandboxCleanup(input: {
  cleanup(): Promise<void>;
  timeoutMs: number;
  trackLateCleanup(cleanup: Promise<void>): void;
}): Promise<void> {
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = Promise.resolve()
    .then(() => input.cleanup())
    .then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );

  await Promise.race([
    cleanup,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, input.timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!settled) input.trackLateCleanup(cleanup);
}

type SandboxExecutionInterruption = {
  cleanup(): void;
  promise: Promise<never>;
  timedOut(): boolean;
};

function interruption(signal: AbortSignal, timeoutMs: number): SandboxExecutionInterruption {
  let rejectInterruption: (reason: Error) => void;
  let timedOut = false;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const onAbort = () => {
    rejectInterruption(
      signal.reason instanceof Error ? signal.reason : new Error("Sandbox execution cancelled."),
    );
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    rejectInterruption(new Error("Sandbox execution timed out."));
  }, timeoutMs);

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  return {
    cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    },
    promise,
    timedOut: () => timedOut,
  };
}

function executionError(
  code: string,
  name: "OutputLimitError" | "TimeoutError",
  message: string,
): ExecutionResult {
  return {
    code,
    error: { message, name, traceback: [] },
    logs: { stderr: [], stdout: [] },
    results: [],
  };
}

function stringProperty(value: object, name: string): string | undefined {
  const property: unknown = Reflect.get(value, name);
  return typeof property === "string" ? property : undefined;
}

function processEvent(result: ExecutionResult, line: string): void {
  if (!line.startsWith("data: ")) return;

  let event: unknown;

  try {
    event = JSON.parse(line.slice(6));
  } catch {
    return;
  }

  if (typeof event !== "object" || event === null || Array.isArray(event)) return;
  const type = stringProperty(event, "type");

  if (type === "stdout" || type === "stderr") {
    const text = stringProperty(event, "text");
    if (text !== undefined) result.logs[type].push(text);
    return;
  }

  if (type === "error") {
    result.error = {
      message: stringProperty(event, "evalue") ?? "Sandbox execution failed.",
      name: stringProperty(event, "ename") ?? "Error",
      traceback: [],
    };
    return;
  }

  if (type !== "result") return;
  const item: ExecutionResult["results"][number] = {};
  const text = stringProperty(event, "text");
  const markdown = stringProperty(event, "markdown");
  const json: unknown = Reflect.get(event, "json");

  if (text !== undefined) item.text = text;
  if (markdown !== undefined) item.markdown = markdown;
  if (json !== undefined) item.json = json;
  if (Object.keys(item).length > 0) result.results.push(item);
}

export async function runBoundedSandboxCode(input: {
  cleanupAfterLateOpen(): Promise<void>;
  code: string;
  maximumStreamBytes: number;
  openStream(): Promise<ReadableStream<Uint8Array>>;
  signal: AbortSignal;
  timeoutMs: number;
  trackLateCleanup(cleanup: Promise<void>): void;
}): Promise<ExecutionResult> {
  const interrupted = interruption(input.signal, input.timeoutMs);
  const opening = Promise.resolve().then(() => input.openStream());
  let stream: ReadableStream<Uint8Array>;

  try {
    stream = await Promise.race([opening, interrupted.promise]);
  } catch (error) {
    interrupted.cleanup();
    const wasInterrupted = interrupted.timedOut() || input.signal.aborted;

    if (wasInterrupted) {
      input.trackLateCleanup(
        opening
          .then(async (lateStream) => {
            await runBoundedSandboxCleanup({
              cleanup: () => lateStream.cancel(),
              timeoutMs: SANDBOX_STREAM_CANCEL_TIMEOUT_MS,
              trackLateCleanup: (cleanup) => {
                input.trackLateCleanup(cleanup);
              },
            });
            await runBoundedSandboxCleanup({
              cleanup: () => input.cleanupAfterLateOpen(),
              timeoutMs: 1_000,
              trackLateCleanup: (cleanup) => {
                input.trackLateCleanup(cleanup);
              },
            });
            return undefined;
          })
          .catch(() => {
            // Owner recovery still retries exact-ID cleanup if the late-open path fails.
            return undefined;
          }),
      );
    }

    if (interrupted.timedOut() && !input.signal.aborted) {
      return executionError(input.code, "TimeoutError", "Sandbox execution timed out.");
    }
    throw error;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;

  try {
    reader = stream.getReader();
  } catch (error) {
    interrupted.cleanup();
    throw error;
  }

  const decoder = new TextDecoder();
  const result: ExecutionResult = {
    code: input.code,
    logs: { stderr: [], stdout: [] },
    results: [],
  };
  let buffer = "";
  let streamBytes = 0;

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted.promise]);

      if (value !== undefined) {
        streamBytes += value.byteLength;

        if (streamBytes > input.maximumStreamBytes) {
          return executionError(
            input.code,
            "OutputLimitError",
            "Sandbox output exceeded the admitted byte limit.",
          );
        }

        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf("\n");

        while (newline >= 0) {
          processEvent(result, buffer.slice(0, newline).trimEnd());
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }

      if (done) {
        buffer += decoder.decode();
        processEvent(result, buffer.trimEnd());
        return result;
      }
    }
  } catch (error) {
    if (interrupted.timedOut() && !input.signal.aborted) {
      return executionError(input.code, "TimeoutError", "Sandbox execution timed out.");
    }
    throw error;
  } finally {
    interrupted.cleanup();
    try {
      await runBoundedSandboxCleanup({
        cleanup: () => reader.cancel(),
        timeoutMs: SANDBOX_STREAM_CANCEL_TIMEOUT_MS,
        trackLateCleanup: (cleanup) => {
          input.trackLateCleanup(cleanup);
        },
      });
    } catch {
      // The owning adapter destroys the per-call container even if stream cancellation fails.
    }
    try {
      reader.releaseLock();
    } catch {
      // Container teardown does not depend on releasing a remote reader lock.
    }
  }
}
