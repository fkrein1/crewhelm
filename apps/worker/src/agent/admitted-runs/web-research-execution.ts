import type {
  WebFetchContentType,
  WebFetchRuntimeTool,
  WebSearchFreshness,
  WebSearchRuntimeTool,
} from "@crewhelm/contracts";
import * as z from "zod";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const SOURCE_TOKEN_AUDIENCE = "crewhelm:web-fetch-source:v1";
const encoder = new TextEncoder();

const braveSearchResponseSchema = z
  .object({
    web: z
      .object({
        results: z
          .array(
            z.object({
              age: z.string().max(256).optional(),
              description: z.string().max(16_384).optional(),
              title: z.string().max(4_096),
              url: z.string().max(4_096),
            }),
          )
          .max(100)
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type WebSearchEvidence = {
  age?: string;
  snippet: string;
  title: string;
  url: string;
};

export type ControlledWebFetchResult = {
  contentType: WebFetchContentType;
  digest: string;
  finalUrl: string;
  redirects: number;
  text: string;
  title?: string;
  truncated: boolean;
};

type PublicHttpsUrlResult = { code: "invalid_source"; ok: false } | { ok: true; url: string };

export class WebResearchExecutionError extends Error {
  readonly code:
    | "content_too_large"
    | "invalid_provider_response"
    | "invalid_source"
    | "provider_failed"
    | "redirect_denied"
    | "timed_out"
    | "unsupported_content_type";
  readonly status: number | null;

  constructor(code: WebResearchExecutionError["code"], status: number | null = null) {
    super(`Web research execution failed: ${code}.`);
    this.name = "WebResearchExecutionError";
    this.code = code;
    this.status = status;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function isDeniedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parsePublicHttpsUrl(value: string, base?: string): PublicHttpsUrlResult {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return { code: "invalid_source", ok: false };
  }

  const encodedHostname = url.hostname.toLowerCase();
  const hostname = encodedHostname.replace(/\.+$/, "");
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== "443") ||
    hostname.length === 0 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".onion") ||
    isDeniedIpv4(hostname) ||
    encodedHostname.startsWith("[")
  ) {
    return { code: "invalid_source", ok: false };
  }

  url.hash = "";
  url.hostname = hostname;
  if (url.port === "443") url.port = "";
  return { ok: true, url: url.toString() };
}

export function normalizePublicHttpsUrl(value: string): string {
  const result = parsePublicHttpsUrl(value);
  if (!result.ok) throw new WebResearchExecutionError(result.code);
  return result.url;
}

function tokenPayload(runId: string, normalizedUrl: string): Uint8Array {
  return encoder.encode(JSON.stringify([SOURCE_TOKEN_AUDIENCE, runId, normalizedUrl]));
}

async function sourceTokenSignature(
  secret: string,
  runId: string,
  normalizedUrl: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, tokenPayload(runId, normalizedUrl)));
}

export async function issueWebSourceToken(
  secret: string,
  runId: string,
  sourceUrl: string,
): Promise<{ token: string; url: string }> {
  const url = normalizePublicHttpsUrl(sourceUrl);
  return { token: bytesToBase64Url(await sourceTokenSignature(secret, runId, url)), url };
}

export async function verifyWebSourceToken(
  secret: string,
  runId: string,
  sourceUrl: string,
  token: string,
): Promise<string> {
  const url = normalizePublicHttpsUrl(sourceUrl);
  const expected = bytesToBase64Url(await sourceTokenSignature(secret, runId, url));
  if (expected.length !== token.length) throw new WebResearchExecutionError("invalid_source");
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ token.charCodeAt(index);
  }
  if (difference !== 0) throw new WebResearchExecutionError("invalid_source");
  return url;
}

function createBoundedSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  cleanup: () => void;
  signal: AbortSignal;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => {
    controller.abort(parent.reason);
  };
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error("Timed out."));
  }, timeoutMs);
  return {
    cleanup: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
    signal: controller.signal,
    timedOut: () => timeoutReached,
  };
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new WebResearchExecutionError("content_too_large");
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new WebResearchExecutionError("content_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function normalizeText(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function decodeCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10_ff_ff &&
    !(codePoint >= 0xd8_00 && codePoint <= 0xdf_ff)
    ? String.fromCodePoint(codePoint)
    : fallback;
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replaceAll(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    const normalized = String(entity).toLowerCase();
    if (normalized.startsWith("#x")) {
      return decodeCodePoint(normalized.slice(2), 16, match);
    }
    if (normalized.startsWith("#")) {
      return decodeCodePoint(normalized.slice(1), 10, match);
    }
    return entities[normalized] ?? match;
  });
}

function htmlToText(html: string): { text: string; title?: string } {
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title =
    titleMatch === null ? undefined : normalizeText(decodeHtmlEntities(titleMatch[1] ?? ""));
  const text = normalizeText(
    decodeHtmlEntities(
      html
        .replaceAll(/<(script|style|noscript|svg)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, " ")
        .replaceAll(/<!--([\s\S]*?)-->/g, " ")
        .replaceAll(/<[^>]*>/g, " "),
    ),
  );
  return { text, ...(title === undefined || title.length === 0 ? {} : { title }) };
}

function truncateForSerializedOutput(
  fixed: Omit<ControlledWebFetchResult, "text" | "truncated">,
  value: string,
  maximumBytes: number,
): { text: string; truncated: boolean } {
  if (serializedBytes({ ...fixed, text: value, truncated: false }) <= maximumBytes) {
    return { text: value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      serializedBytes({ ...fixed, text: value.slice(0, middle), truncated: true }) <= maximumBytes
    ) {
      low = middle;
    } else high = middle - 1;
  }
  return { text: value.slice(0, low), truncated: true };
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedContentType(response: Response): WebFetchContentType {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const parsed = z.enum(["application/json", "text/html", "text/plain"]).safeParse(value);
  if (!parsed.success) throw new WebResearchExecutionError("unsupported_content_type");
  return parsed.data;
}

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export async function runBraveWebSearch(input: {
  apiKey: string;
  fetchImplementation?: typeof fetch;
  freshness?: WebSearchFreshness;
  query: string;
  signal: AbortSignal;
  tool: WebSearchRuntimeTool;
}): Promise<{ query: string; results: WebSearchEvidence[] }> {
  const query = normalizeText(input.query);
  if (query.length === 0 || query.length > input.tool.limits.maxQueryCharacters) {
    throw new WebResearchExecutionError("invalid_source");
  }
  const endpoint = new URL(BRAVE_SEARCH_ENDPOINT);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", String(input.tool.limits.maxResults));
  endpoint.searchParams.set("safesearch", input.tool.safeSearch);
  if (input.freshness !== undefined) {
    endpoint.searchParams.set(
      "freshness",
      { day: "pd", month: "pm", week: "pw", year: "py" }[input.freshness],
    );
  }
  const bounded = createBoundedSignal(input.signal, input.tool.limits.maxDurationMs);
  try {
    const response = await (input.fetchImplementation ?? fetch)(endpoint, {
      headers: { Accept: "application/json", "X-Subscription-Token": input.apiKey },
      redirect: "manual",
      signal: bounded.signal,
    });
    if (!response.ok) throw new WebResearchExecutionError("provider_failed", response.status);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new WebResearchExecutionError("invalid_provider_response");
    }
    const body = await readBoundedBody(response, input.tool.limits.maxOutputBytes * 4);
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
      );
    } catch {
      throw new WebResearchExecutionError("invalid_provider_response");
    }
    const parsed = braveSearchResponseSchema.safeParse(decoded);
    if (!parsed.success) throw new WebResearchExecutionError("invalid_provider_response");
    const results: WebSearchEvidence[] = [];
    const seen = new Set<string>();
    for (const candidate of parsed.data.web?.results ?? []) {
      if (results.length >= input.tool.limits.maxResults) break;
      const source = parsePublicHttpsUrl(candidate.url);
      if (!source.ok) continue;
      const url = source.url;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({
        ...(candidate.age === undefined ? {} : { age: normalizeText(candidate.age) }),
        snippet: normalizeText(candidate.description ?? "").slice(0, 1_024),
        title: normalizeText(candidate.title).slice(0, 512),
        url,
      });
    }
    while (
      results.length > 0 &&
      serializedBytes({ query, results }) > input.tool.limits.maxOutputBytes
    ) {
      results.pop();
    }
    if (serializedBytes({ query, results }) > input.tool.limits.maxOutputBytes) {
      throw new WebResearchExecutionError("content_too_large");
    }
    return { query, results };
  } catch (error) {
    if (error instanceof WebResearchExecutionError) throw error;
    if (input.signal.aborted) throw input.signal.reason;
    throw new WebResearchExecutionError(bounded.timedOut() ? "timed_out" : "provider_failed");
  } finally {
    bounded.cleanup();
  }
}

export async function runControlledWebFetch(input: {
  fetchImplementation?: typeof fetch;
  signal: AbortSignal;
  tool: WebFetchRuntimeTool;
  url: string;
}): Promise<ControlledWebFetchResult> {
  let currentUrl = normalizePublicHttpsUrl(input.url);
  const visited = new Set([currentUrl]);
  const bounded = createBoundedSignal(input.signal, input.tool.limits.maxDurationMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await (input.fetchImplementation ?? fetch)(currentUrl, {
        headers: { Accept: input.tool.allowedContentTypes.join(", ") },
        redirect: "manual",
        signal: bounded.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= input.tool.limits.maxRedirects) {
          throw new WebResearchExecutionError("redirect_denied");
        }
        const location = response.headers.get("location");
        if (location === null) throw new WebResearchExecutionError("redirect_denied");
        const next = parsePublicHttpsUrl(location, currentUrl);
        if (!next.ok) throw new WebResearchExecutionError("redirect_denied");
        const nextUrl = next.url;
        if (visited.has(nextUrl)) throw new WebResearchExecutionError("redirect_denied");
        visited.add(nextUrl);
        currentUrl = nextUrl;
        continue;
      }
      if (!response.ok) throw new WebResearchExecutionError("provider_failed", response.status);
      const contentType = normalizedContentType(response);
      if (!input.tool.allowedContentTypes.includes(contentType)) {
        throw new WebResearchExecutionError("unsupported_content_type");
      }
      const body = await readBoundedBody(response, input.tool.limits.maxResponseBytes);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
      } catch {
        throw new WebResearchExecutionError("unsupported_content_type");
      }
      const normalized = contentType === "text/html" ? htmlToText(decoded) : { text: decoded };
      const fixed: Omit<ControlledWebFetchResult, "text" | "truncated"> = {
        contentType,
        digest: await digestHex(body),
        finalUrl: currentUrl,
        redirects,
        ...(normalized.title === undefined ? {} : { title: normalized.title.slice(0, 512) }),
      };
      const truncated = truncateForSerializedOutput(
        fixed,
        normalized.text,
        input.tool.limits.maxOutputBytes,
      );
      return { ...fixed, ...truncated };
    }
  } catch (error) {
    if (error instanceof WebResearchExecutionError) throw error;
    if (input.signal.aborted) throw input.signal.reason;
    throw new WebResearchExecutionError(bounded.timedOut() ? "timed_out" : "provider_failed");
  } finally {
    bounded.cleanup();
  }
}
