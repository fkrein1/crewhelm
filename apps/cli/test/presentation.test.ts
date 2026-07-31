import { describe, expect, it, vi } from "vitest";

import { createCliPresentation } from "../src/presentation.js";

describe("CLI presentation", () => {
  it("uses the shared semantic terminal roles when color is enabled", () => {
    const writeError = vi.fn<(text: string) => void>();
    const writeOutput = vi.fn<(text: string) => void>();
    const presentation = createCliPresentation({
      color: true,
      interactive: true,
      writeError,
      writeOutput,
    });

    presentation.banner();
    presentation.progress({ label: "Deployment", message: "Checking Worker availability" });

    expect(writeOutput).toHaveBeenCalledWith(
      expect.stringContaining("\u001B[38;2;48;126;224m│ >_\u001B[39m"),
    );
    expect(writeOutput).toHaveBeenCalledWith(
      expect.stringContaining("\u001B[38;2;94;165;245mCREWHELM\u001B[39m"),
    );
    expect(writeError).toHaveBeenCalledWith(
      expect.stringContaining("\u001B[38;2;48;126;224m⠋\u001B[39m"),
    );
    expect(presentation.status("pass")).toContain("\u001B[38;2;107;216;143m");
    expect(presentation.status("fail")).toContain("\u001B[38;2;236;106;118m");
    expect(presentation.status("skip")).toContain("\u001B[38;2;233;180;76m");
    presentation.stopProgress();
  });

  it("keeps semantic output plain when color is disabled", () => {
    const writeError = vi.fn<(text: string) => void>();
    const presentation = createCliPresentation({
      color: false,
      interactive: false,
      writeError,
      writeOutput: vi.fn<(text: string) => void>(),
    });

    expect(presentation.accent("ready")).toBe("ready");
    expect(presentation.muted("detail")).toBe("detail");
    expect(presentation.status("pass")).toBe("PASS");
    expect(presentation.status("fail")).toBe("FAIL");
    expect(presentation.status("skip")).toBe("SKIP");
    presentation.progress({ label: "Deployment", message: "Checking Worker" });
    expect(writeError).not.toHaveBeenCalled();
  });

  it("shows one live activity with elapsed time and stops cleanly", () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const presentation = createCliPresentation({
      color: false,
      interactive: true,
      writeError: (text) => errors.push(text),
      writeOutput: vi.fn<(text: string) => void>(),
    });

    try {
      presentation.progress({ label: "Deployment", message: "Waiting for the Worker" });
      expect(errors.at(-1)).toContain("⠋ Deployment · Waiting for the Worker");

      vi.advanceTimersByTime(1_040);
      expect(errors.at(-1)).toContain("1s");

      presentation.progress({ label: "Verification", message: "Checking OAuth discovery" });
      expect(errors.at(-1)).toContain("⠋ Verification · Checking OAuth discovery");

      presentation.stopProgress();
      const callsAfterStop = errors.length;

      vi.advanceTimersByTime(1_000);
      expect(errors).toHaveLength(callsAfterStop);
      expect(errors.at(-1)).toBe("\r\u001B[2K");
    } finally {
      vi.useRealTimers();
    }
  });

  it("separates waiting and result states from active progress", () => {
    const output: string[] = [];
    const presentation = createCliPresentation({
      color: false,
      interactive: true,
      writeError: vi.fn<(text: string) => void>(),
      writeOutput: (text) => output.push(text),
    });

    presentation.waiting("GitHub identity", "Complete setup in your browser.");
    presentation.result("pass", "GitHub App connected");

    expect(output).toEqual([
      "WAITING GitHub identity\nComplete setup in your browser.\n\n",
      "PASS GitHub App connected\n",
    ]);
  });

  it("keeps prompts interactive without animating redirected progress", () => {
    const writeError = vi.fn<(text: string) => void>();
    const presentation = createCliPresentation({
      color: true,
      interactive: true,
      liveProgress: false,
      writeError,
      writeOutput: vi.fn<(text: string) => void>(),
    });

    presentation.progress({ label: "Deployment", message: "Waiting for the Worker" });

    expect(writeError).not.toHaveBeenCalled();
  });
});
