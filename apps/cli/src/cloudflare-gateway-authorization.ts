export type CloudflareGatewayAuthorization =
  | { action: "skip" }
  | { action: "stop" }
  | { action: "token"; token: string };

interface CloudflareGatewayAuthorizationRequest {
  accountId: string;
  canSkip: boolean;
  workerName: string;
}

interface CloudflareGatewayAuthorizationDependencies {
  openUrl: (url: URL) => Promise<void>;
  promptSecret: (message: string) => Promise<string>;
  promptText: (message: string) => Promise<string>;
  writeOutput: (text: string) => void;
}

export async function requestCloudflareGatewayAuthorization(
  request: CloudflareGatewayAuthorizationRequest,
  dependencies: CloudflareGatewayAuthorizationDependencies,
): Promise<CloudflareGatewayAuthorization> {
  const setupUrl = new URL("https://dash.cloudflare.com/profile/api-tokens");
  const choices = request.canSkip
    ? "Open token setup, skip Gateway, or stop? [O/s/q]: "
    : "Open token setup or stop? [O/q]: ";

  dependencies.writeOutput(
    [
      "Wrangler cannot manage AI Gateway.",
      "Crewhelm needs account AI Gateway Edit for this run; Edit includes read access.",
      "The token is not saved or deployed.",
      `Token name: Crewhelm ${request.workerName} Gateway setup`,
      "Permission: Account > AI Gateway > Edit",
      `Resource: Include > Specific account > ${request.accountId}`,
      `Token setup: ${setupUrl.href}`,
      "",
    ].join("\n"),
  );

  for (;;) {
    const choice = (await dependencies.promptText(choices)).toLowerCase();

    if (choice === "" || choice === "o" || choice === "open") {
      await dependencies.openUrl(setupUrl);
      const token = await dependencies.promptSecret("Paste the Cloudflare API token shown once: ");
      return { action: "token", token };
    }

    if (request.canSkip && (choice === "s" || choice === "skip")) {
      return { action: "skip" };
    }

    if (choice === "q" || choice === "quit" || choice === "stop") {
      return { action: "stop" };
    }

    dependencies.writeOutput(
      request.canSkip ? "Choose open, skip, or stop.\n" : "Choose open or stop.\n",
    );
  }
}
