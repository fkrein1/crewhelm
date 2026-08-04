import { describe, expect, it, vi } from "vitest";

import {
  createProviderAuthSetupCapability,
  createProviderAuthSetupSession,
  readProviderAuthSetupCapability,
  readProviderAuthSetupSession,
} from "./capability.js";

const signingSecret = "provider-auth-setup-signing-secret-long-enough";
const claims = {
  expiresAt: Date.now() + 60_000,
  ownerKey: `owner_${"a".repeat(43)}`,
  setupId: "provider_auth_setup_12345678-1234-4123-8123-123456789abc",
};

describe("provider auth setup capabilities", () => {
  it("keeps the signed capability in a fragment and verifies its exact claims", async () => {
    const created = await createProviderAuthSetupCapability({
      claims,
      origin: "https://crewhelm.example",
      signingSecret,
    });

    expect(created.url).toBe(
      `https://crewhelm.example/setup/provider-auth#capability=${created.capability}`,
    );
    await expect(
      readProviderAuthSetupCapability({ capability: created.capability, signingSecret }),
    ).resolves.toEqual({ capabilityDigest: created.capabilityDigest, claims });
  });

  it("rejects substitution, malformed values, and expired capabilities", async () => {
    const created = await createProviderAuthSetupCapability({
      claims,
      origin: "https://crewhelm.example",
      signingSecret,
    });
    await expect(
      readProviderAuthSetupCapability({
        capability: `${created.capability.slice(0, -1)}x`,
        signingSecret,
      }),
    ).resolves.toBeNull();
    await expect(
      readProviderAuthSetupCapability({ capability: "malformed", signingSecret }),
    ).resolves.toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(claims.expiresAt + 1);
    await expect(
      readProviderAuthSetupCapability({ capability: created.capability, signingSecret }),
    ).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("routes opaque sessions without accepting mutated tokens", async () => {
    const session = await createProviderAuthSetupSession({ ...claims, signingSecret });

    await expect(
      readProviderAuthSetupSession({ signingSecret, token: session.token }),
    ).resolves.toEqual({
      claims: { ownerKey: claims.ownerKey, setupId: claims.setupId },
      sessionDigest: session.sessionDigest,
    });
    await expect(
      readProviderAuthSetupSession({
        signingSecret,
        token: `${session.token.slice(0, -1)}!`,
      }),
    ).resolves.toBeNull();
  });
});
