import { unavailableMcpToolResultSchema } from "@crewhelm/contracts";
import { describe, expect, it, vi } from "vitest";

import { controlPlaneToolResult, unavailableToolResult } from "./tool-result.js";

function parsedResult(result: ReturnType<typeof unavailableToolResult>) {
  return unavailableMcpToolResultSchema.parse(JSON.parse(result.content[0]?.text ?? ""));
}

describe("MCP diagnostic results", () => {
  it("returns a compact opaque diagnostic without reflecting exceptions", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = unavailableToolResult();
    const parsed = parsedResult(result);
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(parsed.error.diagnostic.id).toMatch(/^diag_/);
    expect(parsed.error.diagnostic).toMatchObject({
      certainty: "confirmed",
      disposition: "wait_then_retry",
      nextAction: "retry_request",
      phase: "control_plane.rpc",
      reason: "dependency_unavailable",
    });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(1_024);
    expect(serialized).not.toContain("stack");
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticId: parsed.error.diagnostic.id,
        event: "crewhelm.mcp.tool_unavailable",
      }),
    );
    warning.mockRestore();
  });

  it("distinguishes an invalid dependency response from a transport failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await controlPlaneToolResult(
      async () => ({ secret: "must-not-reflect" }),
      unavailableMcpToolResultSchema,
    );
    const parsed = parsedResult(result);

    expect(parsed.error).toMatchObject({
      code: "invalid_control_plane_response",
      diagnostic: {
        disposition: "contact_operator",
        nextAction: "contact_operator",
        phase: "control_plane.response",
        reason: "invalid_response",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-reflect");
    warning.mockRestore();
  });
});
