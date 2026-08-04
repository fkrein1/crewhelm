import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const canonicalOrigin = "https://crewhelm.app";

/**
 * @param {string} directory
 * @param {string} suffix
 * @returns {string[]}
 */
function filesBelow(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return filesBelow(entryPath, suffix);
    }

    return entry.name.endsWith(suffix) ? [entryPath] : [];
  });
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function documentationSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return documentationSourceFiles(entryPath);
    }

    return /\.mdx?$/.test(entry.name) ? [entryPath] : [];
  });
}

/**
 * @param {string} sourceDirectory
 * @param {string} file
 * @returns {string}
 */
function documentationRoute(sourceDirectory, file) {
  const relative = path.relative(sourceDirectory, file).replaceAll(path.sep, "/");
  const slug = relative.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
  return `/docs/${slug}`.replace(/\/$/, "") + "/";
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string | null}
 */
function attribute(tag, name) {
  return new RegExp(`\\b${name}=(["'])(.*?)\\1`, "i").exec(tag)?.[2] ?? null;
}

/** @param {string} value */
function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * @param {string} html
 * @param {string} name
 * @returns {string[]}
 */
function tags(html, name) {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
}

/**
 * @param {string} outputDirectory
 * @param {string} pathname
 * @returns {string}
 */
function routeFile(outputDirectory, pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\//, "");

  if (relative === "") {
    return path.join(outputDirectory, "index.html");
  }

  if (path.extname(relative)) {
    return path.join(outputDirectory, relative);
  }

  const directoryIndex = path.join(outputDirectory, relative, "index.html");
  return existsSync(directoryIndex)
    ? directoryIndex
    : path.join(outputDirectory, `${relative}.html`);
}

/**
 * @param {string[]} values
 * @param {string} message
 * @returns {string}
 */
function requireSingle(values, message) {
  const value = values[0];

  if (values.length !== 1 || value === undefined) {
    throw new Error(`${message}: expected 1, received ${values.length}`);
  }

  return value;
}

/**
 * @param {string} outputDirectory
 * @param {string} file
 * @returns {{ canonical: string, description: string, html: string, pathname: string }}
 */
function validateIndexablePage(outputDirectory, file) {
  const html = readFileSync(file, "utf8");
  const relative = path.relative(outputDirectory, file).replaceAll(path.sep, "/");
  const pathname = `/${relative.replace(/index\.html$/, "")}`;
  const canonicalTag = requireSingle(
    tags(html, "link").filter((tag) => attribute(tag, "rel") === "canonical"),
    `${pathname} canonical`,
  );
  const descriptionTag = requireSingle(
    tags(html, "meta").filter((tag) => attribute(tag, "name") === "description"),
    `${pathname} description`,
  );
  const robotsTag = requireSingle(
    tags(html, "meta").filter((tag) => attribute(tag, "name") === "robots"),
    `${pathname} robots`,
  );
  const canonical = attribute(canonicalTag, "href");
  const description = decodeHtmlAttribute(attribute(descriptionTag, "content") ?? "");

  if (canonical !== new URL(pathname, canonicalOrigin).toString()) {
    throw new Error(`${pathname} has unexpected canonical ${canonical ?? "<missing>"}`);
  }

  if (!description) {
    throw new Error(`${pathname} has an empty description`);
  }

  if (attribute(robotsTag, "content") !== "index, follow") {
    throw new Error(`${pathname} must be indexable`);
  }

  if (tags(html, "title").length !== 1 || tags(html, "h1").length !== 1) {
    throw new Error(`${pathname} must contain one title and one h1`);
  }

  for (const anchor of tags(html, "a")) {
    const href = attribute(anchor, "href");

    if (!href || /^(?:https?:|mailto:)/.test(href)) {
      continue;
    }

    const targetUrl = new URL(href, new URL(pathname, canonicalOrigin));
    if (targetUrl.origin !== canonicalOrigin) {
      continue;
    }

    const targetFile = routeFile(outputDirectory, targetUrl.pathname);
    if (!existsSync(targetFile)) {
      throw new Error(`${pathname} links to missing ${targetUrl.pathname}`);
    }

    if (targetUrl.hash && targetFile.endsWith(".html")) {
      const targetHtml = readFileSync(targetFile, "utf8");
      const fragment = decodeURIComponent(targetUrl.hash.slice(1));
      const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`\\bid=["']${escaped}["']`).test(targetHtml)) {
        throw new Error(
          `${pathname} links to missing fragment ${targetUrl.pathname}${targetUrl.hash}`,
        );
      }
    }
  }

  return { canonical, description, html, pathname };
}

/**
 * @param {string} outputDirectory
 * @param {string} file
 */
function validateDocsPage(outputDirectory, file) {
  const { canonical, description, html, pathname } = validateIndexablePage(outputDirectory, file);
  const structuredDataTag = requireSingle(
    html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [],
    `${pathname} structured data`,
  );
  const serializedStructuredData = structuredDataTag.replace(/^<script\b[^>]*>|<\/script>$/gi, "");
  const structuredData = JSON.parse(serializedStructuredData);
  if (
    structuredData["@context"] !== "https://schema.org" ||
    structuredData["@type"] !== (pathname === "/docs/" ? "CollectionPage" : "TechArticle") ||
    structuredData.description !== description ||
    structuredData.url !== canonical
  ) {
    throw new Error(`${pathname} has inconsistent structured data`);
  }
}

/** @param {string} outputDirectory */
export function validateSiteOutput(outputDirectory) {
  const publicDirectory = existsSync(path.join(outputDirectory, "client"))
    ? path.join(outputDirectory, "client")
    : outputDirectory;
  const workerConfigurationPath = path.join(outputDirectory, "server", "wrangler.json");
  if (existsSync(workerConfigurationPath)) {
    const workerConfiguration = JSON.parse(readFileSync(workerConfigurationPath, "utf8"));
    const workerFirst = workerConfiguration.assets?.run_worker_first;
    if (workerConfiguration.targetEnvironment === "preview") {
      const services = workerConfiguration.services;
      if (
        (Array.isArray(workerFirst) &&
          (workerFirst.includes("/recipes") || workerFirst.includes("/recipes/*"))) ||
        (Array.isArray(services) && services.some((service) => service?.binding === "REGISTRY")) ||
        !existsSync(path.join(publicDirectory, "recipes", "index.html"))
      ) {
        throw new Error("Recipe previews must be static and have no Registry runtime binding");
      }
    } else {
      if (
        !Array.isArray(workerFirst) ||
        !workerFirst.includes("/recipes") ||
        !workerFirst.includes("/recipes/*")
      ) {
        throw new Error("Recipe SSR routes must run through the site Worker");
      }
      if (existsSync(path.join(publicDirectory, "recipes", "index.html"))) {
        throw new Error("Production Recipe routes must remain server-rendered");
      }
    }
  }
  const docsDirectory = path.join(publicDirectory, "docs");
  const docsPages = filesBelow(docsDirectory, ".html");
  const sourceDirectory = path.resolve(outputDirectory, "../src/content/docs/docs");
  const expectedRoutes = new Set(
    documentationSourceFiles(sourceDirectory).map((file) =>
      documentationRoute(sourceDirectory, file),
    ),
  );
  const builtRoutes = new Set(
    docsPages.map((file) => {
      const relative = path.relative(publicDirectory, file).replaceAll(path.sep, "/");
      return `/${relative.replace(/index\.html$/, "")}`;
    }),
  );

  if (
    expectedRoutes.size !== builtRoutes.size ||
    [...expectedRoutes].some((route) => !builtRoutes.has(route))
  ) {
    throw new Error("built documentation routes do not match their source files");
  }

  for (const page of docsPages) {
    validateDocsPage(publicDirectory, page);
  }

  const sitemap = filesBelow(publicDirectory, ".xml")
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  for (const page of docsPages) {
    const relative = path.relative(publicDirectory, page).replaceAll(path.sep, "/");
    const pathname = `/${relative.replace(/index\.html$/, "")}`;
    const canonical = new URL(pathname, canonicalOrigin).toString();
    if (!sitemap.includes(canonical)) {
      throw new Error(`sitemap is missing ${canonical}`);
    }
  }
  if (sitemap.includes("/recipes/explorations/")) {
    throw new Error("sitemap includes a removed Recipe exploration route");
  }

  const llms = readFileSync(path.join(publicDirectory, "llms.txt"), "utf8");
  for (const pathname of [
    "/docs/",
    "/docs/start/install/",
    "/docs/start/first-agent/",
    "/docs/reference/mcp-tools/",
    "/recipes/",
  ]) {
    const url = new URL(pathname, canonicalOrigin).toString();
    if (!llms.includes(url)) {
      throw new Error(`llms.txt is missing ${url}`);
    }
  }

  if (!existsSync(path.join(publicDirectory, "pagefind", "pagefind.js"))) {
    throw new Error("Pagefind search output is missing");
  }
}

function run() {
  const outputDirectory = path.resolve(process.argv[2] ?? "apps/site/dist");
  validateSiteOutput(outputDirectory);
  console.log(`Validated ${outputDirectory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
