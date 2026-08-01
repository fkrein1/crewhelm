import { describe, expect, it } from "vitest";

import { includesOfficialCloudflareDevelopersUrl } from "../src/web-research-smoke.js";

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
