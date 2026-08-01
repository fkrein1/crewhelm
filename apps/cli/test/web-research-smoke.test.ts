import { describe, expect, it } from "vitest";

import {
  hasExactWebResearchToolSequence,
  includesOfficialCloudflareDevelopersUrl,
} from "../src/web-research-smoke.js";

describe("Web research live evidence", () => {
  it("accepts only an exact credential-free Cloudflare Developers HTTPS origin", () => {
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "WEB_RESEARCH_OK [source](https://developers.cloudflare.com/agents/).",
      ),
    ).toBe(true);
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "https://developers.cloudflare.com.evil.example/agents/",
      ),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "https://evil.example/developers.cloudflare.com/agents/",
      ),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl(
        "https://developers.cloudflare.com@evil.example/agents/",
      ),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl("http://developers.cloudflare.com/agents/"),
    ).toBe(false);
    expect(
      includesOfficialCloudflareDevelopersUrl("https://developers.cloudflare.com:444/agents/"),
    ).toBe(false);
  });
});

describe("Web research tool evidence", () => {
  const occurredAt = "2026-08-01T00:00:00.000Z";
  const toolCallId = "tool_call_00000000-0000-4000-8000-000000000000";

  it("requires exactly one completed search followed by one completed fetch", () => {
    expect(
      hasExactWebResearchToolSequence([
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.search", toolCallId },
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.fetch", toolCallId },
      ]),
    ).toBe(true);
    expect(
      hasExactWebResearchToolSequence([
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.search", toolCallId },
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.search", toolCallId },
      ]),
    ).toBe(false);
    expect(
      hasExactWebResearchToolSequence([
        { event: "tool.execution_completed", occurredAt, toolCallId },
        { event: "tool.execution_completed", occurredAt, runtimeToolId: "web.fetch", toolCallId },
      ]),
    ).toBe(false);
  });
});
