import { afterEach, describe, expect, it, vi } from "vitest";

import {
  recordConnectionLinkCompletion,
  recordIntegrationProviderResponse,
} from "./integrations.js";

describe("integration observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits only the allowlisted provider response fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordIntegrationProviderResponse({
      durationMs: 128,
      integrationSlug: "github",
      operation: "create",
      status: 403,
    });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.integration.provider_response",
      durationMs: 128,
      integrationSlug: "github",
      operation: "create",
      status: 403,
    });
  });

  it("accepts connection-link responses", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordIntegrationProviderResponse({
      durationMs: 321,
      operation: "link",
      outcome: "accepted",
      status: 201,
    });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.integration.provider_response",
      durationMs: 321,
      operation: "link",
      outcome: "accepted",
      status: 201,
    });
  });

  it("rejects extra fields without reflecting their values", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secret = "provider-secret-that-must-not-be-logged";

    recordIntegrationProviderResponse({
      durationMs: 128,
      integrationSlug: "github",
      operation: "create",
      secret,
      status: 403,
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.integration.provider_response.telemetry_rejected",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it("emits only allowlisted connection-link completion outcomes", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordConnectionLinkCompletion({ outcome: "invalid_url" });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.integration.connection_link_completion",
      outcome: "invalid_url",
    });
  });
});
