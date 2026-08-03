import { describe, expect, it } from "vitest";
import * as z from "zod";

import { classifyRemoteMcpToolEffect, composioToolLimitsSchema } from "./capabilities.js";

describe("remote MCP capability classification", () => {
  it.each([
    "deleteUser",
    "clear_database",
    "deactivateAccount",
    "destroyDatabase",
    "disableTenant",
    "dropTable",
    "purgeAll",
    "removeAccount",
    "reset_tenant",
    "revoke-token",
    "shutdownServer",
    "terminate_session",
  ])("classifies destructive action name %s conservatively", (name) => {
    expect(classifyRemoteMcpToolEffect({ name })).toBe("destructive");
  });

  it("honors destructive annotations and otherwise defaults to write", () => {
    expect(
      classifyRemoteMcpToolEffect({ annotations: { destructiveHint: true }, name: "mutate" }),
    ).toBe("destructive");
    expect(classifyRemoteMcpToolEffect({ name: "getUser" })).toBe("write");
  });

  it("advertises the non-negative provider cost limit enforced at runtime", () => {
    expect(
      z.toJSONSchema(composioToolLimitsSchema).properties?.maxCostMicrousdPerCall,
    ).toMatchObject({ minimum: 0 });
  });
});
