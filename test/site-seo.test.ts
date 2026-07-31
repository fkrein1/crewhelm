import { describe, expect, it } from "vitest";

import {
  CREWHELM_SITE,
  absoluteSiteUrl,
  homeStructuredData,
  llmsText,
  robotsText,
  serializeJsonLd,
} from "../apps/site/src/lib/seo.js";

describe("Crewhelm site discovery foundation", () => {
  it("keeps canonical URLs on the production origin", () => {
    expect(absoluteSiteUrl("/")).toBe("https://crewhelm.app/");
    expect(absoluteSiteUrl("/recipes/example")).toBe("https://crewhelm.app/recipes/example");
  });

  it("publishes a neutral crawler policy and generated sitemap location", () => {
    expect(robotsText()).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://crewhelm.app/sitemap-index.xml\n",
    );
  });

  it("describes only claims supported by the product and repository", () => {
    const structuredData = homeStructuredData();
    const serialized = JSON.stringify(structuredData);

    expect(serialized).toContain('"@type":"WebSite"');
    expect(serialized).toContain('"@type":"SoftwareApplication"');
    expect(serialized).toContain(`"sameAs":"${CREWHELM_SITE.githubUrl}"`);
    expect(serialized).toContain(CREWHELM_SITE.githubUrl);
    expect(serialized).not.toContain("codeRepository");
    expect(serialized).not.toContain("operatingSystem");
  });

  it("escapes executable markup in structured data", () => {
    expect(serializeJsonLd({ value: "</script><script>alert(1)</script>" })).toBe(
      '{"value":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}',
    );
  });

  it("keeps llms.txt concise and source-linked", () => {
    const content = llmsText();

    expect(content).toContain("# Crewhelm");
    expect(content).toContain("> The open-source personal control plane");
    expect(content).toContain("[GitHub repository](https://github.com/fkrein1/crewhelm)");
    expect(content).not.toContain("## Optional");
  });
});
