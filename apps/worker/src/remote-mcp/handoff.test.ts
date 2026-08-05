import { describe, expect, it } from "vitest";

import {
  createRemoteMcpApiKeySetup,
  createRemoteMcpBearerSetup,
  createRemoteMcpOAuthSetup,
  createRemoteMcpOAuthState,
  readRemoteMcpApiKeySetup,
  readRemoteMcpBearerSetup,
  readRemoteMcpOAuthSetup,
  readRemoteMcpOAuthState,
  REMOTE_MCP_API_KEY_SETUP_PATH_PREFIX,
  REMOTE_MCP_BEARER_SETUP_PATH_PREFIX,
  REMOTE_MCP_OAUTH_SETUP_PATH_PREFIX,
} from "./handoff.js";

const signingSecret = "s".repeat(64);
const claims = {
  endpoint: "https://mcp.example.com/rpc",
  expiresAt: Date.now() + 60_000,
  idempotencyKey: "remote-mcp-handoff",
  name: "Project MCP",
  operation: "create" as const,
  ownerKey: `owner_${"o".repeat(43)}`,
};

function parameters(url: string): { encodedClaims: string; signature: string } {
  const segments = new URL(url).pathname
    .slice(REMOTE_MCP_BEARER_SETUP_PATH_PREFIX.length)
    .split("/");
  return { encodedClaims: segments[0] ?? "", signature: segments[1] ?? "" };
}

describe("remote MCP bearer handoff", () => {
  it("round-trips exact signed, expiring setup claims", async () => {
    const setup = await createRemoteMcpBearerSetup({
      claims,
      origin: "https://crewhelm.example",
      signingSecret,
    });

    expect(setup.url).toMatch(
      /^https:\/\/crewhelm\.example\/connections\/remote-mcp\/setup\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]{43}$/,
    );
    await expect(
      readRemoteMcpBearerSetup({ ...parameters(setup.url), signingSecret }),
    ).resolves.toEqual(claims);
  });

  it("rejects tampering, the wrong key, expiration, and malformed encodings", async () => {
    const setup = await createRemoteMcpBearerSetup({
      claims,
      origin: "https://crewhelm.example",
      signingSecret,
    });
    const exact = parameters(setup.url);

    await expect(
      readRemoteMcpBearerSetup({
        ...exact,
        signature: `${exact.signature.slice(0, -1)}${exact.signature.endsWith("A") ? "B" : "A"}`,
        signingSecret,
      }),
    ).resolves.toBeNull();
    await expect(
      readRemoteMcpBearerSetup({ ...exact, signingSecret: "x".repeat(64) }),
    ).resolves.toBeNull();

    const expired = await createRemoteMcpBearerSetup({
      claims: { ...claims, expiresAt: Date.now() - 1 },
      origin: "https://crewhelm.example",
      signingSecret,
    });
    await expect(
      readRemoteMcpBearerSetup({ ...parameters(expired.url), signingSecret }),
    ).resolves.toBeNull();
    await expect(
      readRemoteMcpBearerSetup({
        encodedClaims: "not-json",
        signature: "a".repeat(43),
        signingSecret,
      }),
    ).resolves.toBeNull();
  });
});

describe("remote MCP API-key handoff", () => {
  it("round-trips the exact normalized header in separately signed claims", async () => {
    const setup = await createRemoteMcpApiKeySetup({
      claims: { ...claims, apiKeyHeaderName: "X-API-Key" },
      origin: "https://crewhelm.example",
      signingSecret,
    });
    const [encodedClaims = "", signature = ""] = new URL(setup.url).pathname
      .slice(REMOTE_MCP_API_KEY_SETUP_PATH_PREFIX.length)
      .split("/");

    await expect(
      readRemoteMcpApiKeySetup({ encodedClaims, signature, signingSecret }),
    ).resolves.toEqual({ ...claims, apiKeyHeaderName: "x-api-key" });
  });
});

describe("remote MCP OAuth handoff", () => {
  const oauthClaims = {
    expiresAt: Date.now() + 60_000,
    ownerKey: claims.ownerKey,
    requestId: `remote_mcp_oauth_${crypto.randomUUID()}`,
  };

  it("round-trips separately signed setup and callback state", async () => {
    const setup = await createRemoteMcpOAuthSetup({
      claims: oauthClaims,
      origin: "https://crewhelm.example",
      signingSecret,
    });
    const [encodedClaims = "", signature = ""] = new URL(setup.url).pathname
      .slice(REMOTE_MCP_OAUTH_SETUP_PATH_PREFIX.length)
      .split("/");
    const state = await createRemoteMcpOAuthState({ claims: oauthClaims, signingSecret });

    await expect(
      readRemoteMcpOAuthSetup({ encodedClaims, signature, signingSecret }),
    ).resolves.toEqual(oauthClaims);
    await expect(readRemoteMcpOAuthState({ signingSecret, state })).resolves.toEqual(oauthClaims);
    await expect(
      readRemoteMcpOAuthState({
        signingSecret,
        state: `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`,
      }),
    ).resolves.toBeNull();
  });
});
