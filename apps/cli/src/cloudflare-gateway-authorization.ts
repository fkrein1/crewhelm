import { createCliTextStyle, type CliTextStyle } from "./presentation.js";

export type CloudflareGatewayAuthorization =
  | { action: "skip" }
  | { action: "stop" }
  | { action: "token"; token: string };

interface CloudflareGatewayAuthorizationRequest {
  accountId: string;
  canSkip: boolean;
  dailySpendUsd: number;
  workerName: string;
}

interface CloudflareGatewayAuthorizationDependencies {
  openUrl: (url: URL) => Promise<void>;
  promptSecret: (message: string) => Promise<string>;
  promptText: (message: string) => Promise<string>;
  style?: CliTextStyle;
  writeOutput: (text: string) => void;
}

function formatUsd(value: number): string {
  return value
    .toFixed(2)
    .replace(/\.00$/u, "")
    .replace(/(\.[0-9])0$/u, "$1");
}

export async function requestCloudflareGatewayAuthorization(
  request: CloudflareGatewayAuthorizationRequest,
  dependencies: CloudflareGatewayAuthorizationDependencies,
): Promise<CloudflareGatewayAuthorization> {
  const setupUrl = new URL("https://dash.cloudflare.com/profile/api-tokens");
  const style = dependencies.style ?? createCliTextStyle(false);
  const choices = request.canSkip
    ? [
        `${style.accentStrong("1.")} Set up the token ${style.muted("(recommended)")}`,
        `${style.warningStrong("2.")} Continue without a spending limit`,
        `${style.muted("3.")} Exit`,
      ]
    : [
        `${style.accentStrong("1.")} Set up the token ${style.muted("(required)")}`,
        `${style.muted("2.")} Exit`,
      ];

  dependencies.writeOutput(
    [
      style.accentStrong("AI spending protection"),
      "",
      `Crewhelm can enforce a ${style.strong(`$${formatUsd(request.dailySpendUsd)} daily limit`)} through Cloudflare AI Gateway.`,
      "Cloudflare requires a separate account token to configure it.",
      "",
      ...choices,
      "",
    ].join("\n"),
  );

  for (;;) {
    const choice = (await dependencies.promptText(style.strong("Choose [1]: "))).toLowerCase();

    if (choice === "" || choice === "1" || choice === "open" || choice === "setup") {
      dependencies.writeOutput(
        [
          "",
          style.accentStrong("Create the Cloudflare token"),
          "",
          "Use these settings on the API Tokens page:",
          `  ${style.strong("Name")}        Crewhelm ${request.workerName} Gateway setup`,
          `  ${style.strong("Permission")}  Account · AI Gateway · Edit`,
          `  ${style.strong("Account")}     ${request.accountId}`,
          "",
          style.muted("The token is used for this run only and is never saved or deployed."),
          style.muted(`Browser fallback: ${setupUrl.href}`),
          "",
        ].join("\n"),
      );
      await dependencies.openUrl(setupUrl);
      dependencies.writeOutput(
        `${style.warningStrong("WAITING")} Finish token setup in your browser.\n`,
      );
      const token = await dependencies.promptSecret(style.strong("Token (hidden): "));
      return { action: "token", token };
    }

    if (request.canSkip && (choice === "2" || choice === "skip")) {
      return { action: "skip" };
    }

    if (
      (request.canSkip && choice === "3") ||
      (!request.canSkip && choice === "2") ||
      choice === "exit" ||
      choice === "quit" ||
      choice === "stop"
    ) {
      return { action: "stop" };
    }

    dependencies.writeOutput(request.canSkip ? "Choose 1, 2, or 3.\n" : "Choose 1 or 2.\n");
  }
}
