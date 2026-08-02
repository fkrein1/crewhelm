import { describe, expect, it } from "vitest";

import {
  CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX,
  callbackParametersSchema,
  createConnectionAuthorizationCallback,
  hasValidCallbackAuthenticator,
} from "./authorization-return.js";

describe("connection authorization return", () => {
  it("authenticates only the exact callback claims and signing secret", async () => {
    const signingSecret = "s".repeat(32);
    const callback = await createConnectionAuthorizationCallback({
      authorizationExpiresAt: "2026-08-02T12:00:00.000Z",
      authorizationToken: "a".repeat(43),
      origin: "https://crewhelm.example",
      ownerKey: `owner_${"o".repeat(43)}`,
      reservationId: "connection_link_00000000-0000-4000-8000-000000000001",
      signingSecret,
    });
    const url = new URL(callback.callbackUrl);
    const [ownerKey, reservationId, expiresAt, authorizationToken, authenticator] = url.pathname
      .slice(CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX.length)
      .split("/");
    const parameters = callbackParametersSchema.parse({
      authenticator,
      authorizationToken,
      expiresAt,
      ownerKey,
      reservationId,
    });

    expect(callback.callbackSecrets).toEqual([authorizationToken, authenticator]);
    await expect(hasValidCallbackAuthenticator(signingSecret, parameters)).resolves.toBe(true);
    await expect(hasValidCallbackAuthenticator("x".repeat(32), parameters)).resolves.toBe(false);
    await expect(
      hasValidCallbackAuthenticator(signingSecret, {
        ...parameters,
        authorizationToken: "b".repeat(43),
      }),
    ).resolves.toBe(false);
    await expect(hasValidCallbackAuthenticator("too-short", parameters)).resolves.toBe(false);
  });
});
