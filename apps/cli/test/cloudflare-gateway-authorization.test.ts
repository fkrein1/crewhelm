import { describe, expect, it, vi } from "vitest";

import { requestCloudflareGatewayAuthorization } from "../src/cloudflare-gateway-authorization.js";

describe("Cloudflare Gateway authorization", () => {
  it("opens the recipe and returns hidden token input without printing it", async () => {
    const output: string[] = [];
    const openUrl = vi.fn<(url: URL) => Promise<void>>(async () => {});

    const result = await requestCloudflareGatewayAuthorization(
      {
        accountId: "account-123",
        canSkip: true,
        dailySpendUsd: 5,
        workerName: "crewhelm-testing",
      },
      {
        openUrl,
        promptSecret: async () => "scoped-token-value",
        promptText: async () => "1",
        writeOutput: (text) => output.push(text),
      },
    );

    expect(result).toEqual({ action: "token", token: "scoped-token-value" });
    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl.mock.calls[0]?.[0].href).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(output.join("")).toContain("AI spending protection");
    expect(output.join("")).toContain("$5 daily limit");
    expect(output.join("")).toContain("1. Set up the token (recommended)");
    expect(output.join("")).toContain("2. Continue without a spending limit");
    expect(output.join("")).toContain("Permission  Account · AI Gateway · Edit");
    expect(output.join("")).toContain("Account     account-123");
    expect(output.join("")).toContain("WAITING Finish token setup in your browser.");
    expect(output.join("")).not.toContain("[O/s/q]");
    expect(output.join("")).not.toContain("scoped-token-value");
  });

  it("allows a new installation to skip without opening the dashboard", async () => {
    const openUrl = vi.fn<(url: URL) => Promise<void>>(async () => {});

    await expect(
      requestCloudflareGatewayAuthorization(
        {
          accountId: "account-123",
          canSkip: true,
          dailySpendUsd: 5,
          workerName: "crewhelm-testing",
        },
        {
          openUrl,
          promptSecret: async () => {
            throw new Error("Token input must not run.");
          },
          promptText: async () => "2",
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
        {
          accountId: "account-123",
          canSkip: false,
          dailySpendUsd: 5,
          workerName: "crewhelm",
        },
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
    expect(choices).toEqual(["Choose [1]: ", "Choose [1]: "]);
  });
});
