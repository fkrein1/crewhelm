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
    presentation.progress("Checking deployment");

    expect(writeOutput).toHaveBeenCalledWith(
      expect.stringContaining("\u001B[38;2;100;168;255m>_\u001B[39m"),
    );
    expect(writeOutput).toHaveBeenCalledWith(
      expect.stringContaining("\u001B[38;2;10;132;255mCREWHELM\u001B[39m"),
    );
    expect(writeError).toHaveBeenCalledWith(
      expect.stringContaining("\u001B[38;2;100;168;255m==>\u001B[39m"),
    );
    expect(presentation.status("pass")).toContain("\u001B[38;2;107;216;143m");
    expect(presentation.status("fail")).toContain("\u001B[38;2;236;106;118m");
    expect(presentation.status("skip")).toContain("\u001B[38;2;233;180;76m");
  });

  it("keeps semantic output plain when color is disabled", () => {
    const presentation = createCliPresentation({
      color: false,
      interactive: false,
      writeError: vi.fn<(text: string) => void>(),
      writeOutput: vi.fn<(text: string) => void>(),
    });

    expect(presentation.accent("ready")).toBe("ready");
    expect(presentation.muted("detail")).toBe("detail");
    expect(presentation.status("pass")).toBe("PASS");
    expect(presentation.status("fail")).toBe("FAIL");
    expect(presentation.status("skip")).toBe("SKIP");
  });
});
