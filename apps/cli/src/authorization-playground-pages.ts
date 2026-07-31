import { renderCodexBrowserHandoffPage } from "./codex-browser.js";
import {
  renderGitHubAppConnectedPage,
  renderGitHubAppSetupPage,
  renderGitHubAppStoppedPage,
} from "./github-app.js";
import { LOCAL_PAGE_STYLES } from "./local-page.js";
import type { AuthorizationPlaygroundPage } from "./authorization-playground.js";

export const CLI_AUTHORIZATION_PLAYGROUND_STYLES = LOCAL_PAGE_STYLES;

export const CLI_AUTHORIZATION_PLAYGROUND_PAGES = [
  {
    description: "Safe local bridge into the signed remote authorization URL.",
    group: "CLI loopback",
    html: renderCodexBrowserHandoffPage("/playground/noop"),
    path: "/pages/codex-browser-handoff",
    title: "Codex browser handoff",
  },
  {
    description: "Private, zero-permission GitHub App creation handoff.",
    group: "CLI loopback",
    html: renderGitHubAppSetupPage(
      "/playground/noop",
      JSON.stringify({
        default_events: [],
        default_permissions: {},
        name: "Crewhelm fixture",
        public: false,
      }),
    ),
    path: "/pages/github-app-setup",
    title: "GitHub App setup",
  },
  {
    description: "Verified GitHub App setup return.",
    group: "CLI loopback",
    html: renderGitHubAppConnectedPage(),
    path: "/pages/github-app-connected",
    title: "GitHub App connected",
  },
  {
    description: "Rejected or unverifiable GitHub App setup return.",
    group: "CLI loopback",
    html: renderGitHubAppStoppedPage(),
    path: "/pages/github-app-stopped",
    title: "GitHub App stopped",
  },
] as const satisfies readonly AuthorizationPlaygroundPage[];
