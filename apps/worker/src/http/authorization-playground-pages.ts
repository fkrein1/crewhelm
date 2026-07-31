import { AGENTS_READ_SCOPE } from "@crewhelm/contracts";

import { renderConnectionAuthorizationReturnPage } from "./connection-authorization-return.js";
import { WORKER_PAGE_STYLES } from "./page.js";
import { FULL_ACCESS_SCOPE, USE_ACCESS_SCOPE, VIEW_ACCESS_SCOPE } from "../oauth/access-levels.js";
import { OFFLINE_ACCESS_SCOPE } from "../oauth/scopes.js";
import {
  OAUTH_ACTIONS_SCRIPT,
  renderOAuthCompletionPage,
  renderOAuthConsentPage,
  renderOAuthLoginPage,
} from "../oauth/ui.js";

const OAUTH_QUERY =
  "client_id=fixture-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&scope=crewhelm%3Afull%20offline_access";
const FIXTURE_CLIENT = { id: "fixture-client", name: "Codex Desktop" };
const FIXTURE_REDIRECT_ORIGIN = "https://client.example";
const CONSENT_FIXTURES = [
  ["View access", VIEW_ACCESS_SCOPE],
  ["Use access", USE_ACCESS_SCOPE],
  ["Full control", FULL_ACCESS_SCOPE],
  ["Legacy client access", AGENTS_READ_SCOPE],
] as const;
const CONNECTION_RETURN_FIXTURES = [
  ["Connection returned", "returned"],
  ["Connection stopped", "stopped"],
  ["Connection denied", "denied"],
] as const;

export const WORKER_AUTHORIZATION_PLAYGROUND_ACTIONS_SCRIPT = OAUTH_ACTIONS_SCRIPT;
export const WORKER_AUTHORIZATION_PLAYGROUND_STYLES = WORKER_PAGE_STYLES;

export const WORKER_AUTHORIZATION_PLAYGROUND_PAGES = [
  {
    description: "Owner identity handoff before OAuth consent.",
    group: "Worker OAuth",
    html: renderOAuthLoginPage(OAUTH_QUERY),
    path: "/pages/oauth-login",
    title: "Owner login",
  },
  ...CONSENT_FIXTURES.map(([title, scope]) => ({
    description: `${title} plus rotating offline access.`,
    group: "Worker OAuth",
    html: renderOAuthConsentPage(
      OAUTH_QUERY,
      FIXTURE_CLIENT,
      FIXTURE_REDIRECT_ORIGIN,
      `${scope} ${OFFLINE_ACCESS_SCOPE}`,
    ),
    path: `/pages/oauth-consent-${title.toLowerCase().replaceAll(" ", "-")}`,
    title,
  })),
  {
    description: "OAuth authorization returned to the requesting client.",
    group: "Worker OAuth",
    html: renderOAuthCompletionPage(),
    path: "/pages/oauth-complete",
    title: "OAuth complete",
  },
  ...CONNECTION_RETURN_FIXTURES.map(([title, outcome]) => ({
    description: `Provider connection authorization ${outcome}.`,
    group: "Connection return",
    html: renderConnectionAuthorizationReturnPage(outcome),
    path: `/pages/connection-${outcome}`,
    title,
  })),
];
