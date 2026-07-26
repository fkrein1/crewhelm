import { describe, expect, it, vi } from "vitest";

import { CLI_HELP, runCli, type CliDependencies } from "../src/cli.js";

function createHarness(response: Response = new Response(null, { status: 503 })) {
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies: CliDependencies = {
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
    writeError: (text) => errors.push(text),
    writeOutput: (text) => output.push(text),
  };

  return { dependencies, errors, output };
}

describe("Crewhelm CLI", () => {
  it("prints concise help without making a request", async () => {
    const harness = createHarness();

    await expect(runCli([], harness.dependencies)).resolves.toBe(0);
    expect(harness.output).toEqual([CLI_HELP]);
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });

  it("reports a healthy Worker in human-readable form", async () => {
    const harness = createHarness(
      new Response('{"service":"crewhelm","status":"ok"}', {
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      runCli(["doctor", "--endpoint", "https://crewhelm.example"], harness.dependencies),
    ).resolves.toBe(0);
    expect(harness.output.join("")).toContain("PASS worker-health https://crewhelm.example/health");
    expect(harness.errors).toEqual([]);
  });

  it("emits a stable JSON failure without reflecting the response body", async () => {
    const harness = createHarness(
      new Response("secret-provider-diagnostic", {
        headers: { "content-type": "text/plain" },
        status: 503,
      }),
    );

    await expect(
      runCli(["doctor", "--endpoint", "https://crewhelm.example", "--json"], harness.dependencies),
    ).resolves.toBe(1);

    const report: unknown = JSON.parse(harness.output.join(""));
    expect(report).toMatchObject({
      ok: false,
      checks: [{ code: "http_status", status: "fail" }],
    });
    expect(harness.output.join("")).not.toContain("secret-provider-diagnostic");
  });

  it("does not reflect an invalid command value", async () => {
    const harness = createHarness();

    await expect(runCli(["secret-command-value"], harness.dependencies)).resolves.toBe(2);
    expect(harness.errors.join("")).not.toContain("secret-command-value");
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { arguments_: ["unknown"] },
    { arguments_: ["doctor"] },
    { arguments_: ["doctor", "--endpoint", "http://example.com"] },
    {
      arguments_: ["doctor", "--endpoint", "https://crewhelm.example", "--timeout-ms", "0"],
    },
    {
      arguments_: ["doctor", "--endpoint", "https://crewhelm.example", "--json", "--json"],
    },
  ])("returns a usage error for $arguments_ without making a request", async ({ arguments_ }) => {
    const harness = createHarness();

    await expect(runCli(arguments_, harness.dependencies)).resolves.toBe(2);
    expect(harness.output).toEqual([]);
    expect(harness.errors.join("")).toContain("Error:");
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });
});
