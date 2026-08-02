import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { DOCS_ROUTES } from "../apps/site/src/lib/docs-manifest.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const contentRoot = path.join(repositoryRoot, "apps/site/src/content/docs/docs");
const templateRoot = path.join(repositoryRoot, "docs/documentation/templates");

const expectedRoutes = new Set(DOCS_ROUTES);

const allowedTypes = new Set(["explanation", "how-to", "reference", "tutorial"]);
const allowedAudiences = new Set(["contributor", "mcp-client", "operator", "owner"]);

interface Frontmatter {
  area: string;
  audience: string;
  availability: "available";
  description: string;
  sources: string[];
  title: string;
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonemptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry: unknown) => isNonemptyString(entry))
  );
}

function validateFrontmatter(value: unknown, file: string): Frontmatter {
  if (
    !isRecord(value) ||
    !isNonemptyString(value.area) ||
    !isNonemptyString(value.audience) ||
    !allowedAudiences.has(value.audience) ||
    value.availability !== "available" ||
    !isNonemptyString(value.description) ||
    !isNonemptyStringArray(value.sources) ||
    !isNonemptyString(value.title) ||
    !isNonemptyString(value.type) ||
    !allowedTypes.has(value.type)
  ) {
    throw new Error(`${file} has invalid documentation frontmatter`);
  }

  return {
    area: value.area,
    audience: value.audience,
    availability: value.availability,
    description: value.description,
    sources: value.sources,
    title: value.title,
    type: value.type,
  };
}

function contentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return contentFiles(entryPath);
    }

    return /\.mdx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function routeFor(file: string): string {
  const relative = path.relative(contentRoot, file).replaceAll(path.sep, "/");
  const slug = relative.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
  return `/docs/${slug}`.replace(/\/$/, "") + "/";
}

function parseDocument(file: string): { body: string; data: Frontmatter } {
  const source = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);

  expect(match, `${file} must begin with YAML frontmatter`).not.toBeNull();
  const frontmatter = match?.[1] ?? "";
  const data: unknown = parse(frontmatter);

  return {
    body: source.slice(match?.[0].length ?? 0),
    data: validateFrontmatter(data, file),
  };
}

describe("public documentation contract", () => {
  it("publishes the complete route manifest", () => {
    const routes = new Set(contentFiles(contentRoot).map(routeFor));

    expect(DOCS_ROUTES).toHaveLength(expectedRoutes.size);
    expect(routes).toEqual(expectedRoutes);
  });

  it("keeps metadata typed and source-backed", () => {
    for (const file of contentFiles(contentRoot)) {
      const { body, data } = parseDocument(file);

      expect(data.title, `${file} title`).not.toBe("");
      expect(data.description, `${file} description`).not.toBe("");
      expect(data.area, `${file} area`).not.toBe("");
      expect(data.availability, `${file} availability`).toBe("available");
      expect(data.sources.length, `${file} sources`).toBeGreaterThan(0);
      expect(body.trimStart(), `${file} must rely on the Starlight page title`).not.toMatch(/^# /);

      for (const source of data.sources) {
        const sourcePath = source.split("#", 1)[0];
        expect(sourcePath, `${file} source path`).toBeTruthy();
        expect(existsSync(path.join(repositoryRoot, sourcePath ?? "")), `${file}: ${source}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps authoring templates aligned with the published schema", () => {
    const templates = contentFiles(templateRoot);

    expect(templates).toHaveLength(4);
    for (const template of templates) {
      expect(() => parseDocument(template)).not.toThrow();
    }
  });

  it("uses canonical documentation routes for internal links", () => {
    for (const file of contentFiles(contentRoot)) {
      const { body } = parseDocument(file);
      const localLinks = [...body.matchAll(/\]\((\/docs\/[^)#?]*)(?:#[^)]+)?\)/g)];

      for (const link of localLinks) {
        const route = `${link[1]?.replace(/\/$/, "") ?? ""}/`;
        expect(expectedRoutes.has(route), `${file}: ${link[0]}`).toBe(true);
      }

      expect(body, `${file} must not link to repository Markdown paths`).not.toMatch(
        /\]\((?:\.\.?\/|\/)?[^)]+\.md(?:#[^)]+)?\)/,
      );
    }
  });

  it("keeps the MCP tool reference generated", () => {
    const reference = path.join(contentRoot, "reference/mcp-tools.md");
    const { body } = parseDocument(reference);

    expect(body).toContain("Generated by `pnpm docs:mcp`. Do not edit manually.");
  });
});
