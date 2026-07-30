import { describe, expect, it, vi } from "vitest";

import { requestCloudflareGatewayAuthorization } from "../src/cloudflare-gateway-authorization.js";

describe("Cloudflare Gateway authorization", () => {
  it("opens the recipe and returns hidden token input without printing it", async () => {
    const output: string[] = [];
    const openUrl = vi.fn<(url: URL) => Promise<void>>(async () => {});

    const result = await requestCloudflareGatewayAuthorization(
      { accountId: "account-123", canSkip: true, workerName: "crewhelm-testing" },
      {
        openUrl,
        promptSecret: async () => "scoped-token-value",
        promptText: async () => "open",
        writeOutput: (text) => output.push(text),
      },
    );

    expect(result).toEqual({ action: "token", token: "scoped-token-value" });
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl.mock.calls[0]?.[0].href).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(output.join("")).toContain("Permission: Account > AI Gateway > Edit");
    expect(output.join("")).toContain("Resource: Include > Specific account > account-123");
    expect(output.join("")).not.toContain("scoped-token-value");
  });

  it("allows a new installation to skip without opening the dashboard", async () => {
    const openUrl = vi.fn<(url: URL) => Promise<void>>(async () => {});

    await expect(
      requestCloudflareGatewayAuthorization(
        { accountId: "account-123", canSkip: true, workerName: "crewhelm-testing" },
        {
          openUrl,
          promptSecret: async () => {
            throw new Error("Token input must not run.");
          },
          promptText: async () => "skip",
          writeOutput: () => {},
        },
      ),
    ).resolves.toEqual({ action: "skip" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not offer skip when an installation already has a Gateway", async () => {
    const choices: string[] = [];
    const answers = ["skip", "stop"];

    await expect(
      requestCloudflareGatewayAuthorization(
        { accountId: "account-123", canSkip: false, workerName: "crewhelm" },
        {
          openUrl: async () => {},
          promptSecret: async () => "",
          promptText: async (message) => {
            choices.push(message);
            return answers.shift() ?? "stop";
          },
          writeOutput: () => {},
        },
      ),
    ).resolves.toEqual({ action: "stop" });
    expect(choices).toEqual([
      "Open token setup or stop? [O/q]: ",
      "Open token setup or stop? [O/q]: ",
    ]);
  });
});
