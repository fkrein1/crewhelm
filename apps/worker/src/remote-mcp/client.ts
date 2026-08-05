import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  MAXIMUM_REMOTE_MCP_CATALOG_BYTES,
  MAXIMUM_REMOTE_MCP_DESCRIPTION_CHARACTERS,
  MAXIMUM_REMOTE_MCP_SCHEMA_BYTES,
  MAXIMUM_REMOTE_MCP_TOOLS,
  remoteMcpCatalogSchema,
  type RemoteMcpTool,
} from "@crewhelm/contracts";

import { createRemoteMcpInputSchema } from "./schema.js";

const CLIENT_INFO = { name: "crewhelm", version: "1" } as const;
const MAXIMUM_DISCOVERY_PAGES = 100;
const MAXIMUM_PROTOCOL_OVERHEAD_BYTES = 64 * 1_024;
const MAXIMUM_REMOTE_MCP_REDIRECTS = 3;
const REMOTE_MCP_USER_AGENT = "crewhelm/1 (+https://crewhelm.app)";
const encoder = new TextEncoder();

export type DiscoveredRemoteMcpCatalog = {
  catalogBytes: number;
  digest: string;
  server: { name: string; version: string };
  tools: RemoteMcpTool[];
};

type RemoteMcpAuthentication =
  | { apiKey?: never; bearerToken?: never }
  | { apiKey: { headerName: string; value: string }; bearerToken?: never }
  | { apiKey?: never; bearerToken: string };

type RemoteMcpClientOptions = RemoteMcpAuthentication & {
  endpoint: string;
  fetchImplementation?: typeof fetch;
  signal: AbortSignal;
};

function credentialValue(options: RemoteMcpAuthentication): string | undefined {
  return options.apiKey?.value ?? options.bearerToken;
}

export class RemoteMcpClientError extends Error {
  readonly code:
    | "catalog_too_large"
    | "credential_reflected"
    | "invalid_catalog"
    | "invalid_endpoint"
    | "output_too_large"
    | "response_too_large"
    | "request_failed";
  readonly failureKind:
    | "network_or_protocol"
    | "timeout"
    | "upstream_denied"
    | "upstream_error"
    | "upstream_rate_limited"
    | undefined;
  readonly upstreamStatus: number | undefined;

  constructor(
    code: RemoteMcpClientError["code"],
    details?: {
      failureKind: NonNullable<RemoteMcpClientError["failureKind"]>;
      upstreamStatus?: number;
    },
  ) {
    super(`Remote MCP request failed: ${code}.`);
    this.name = "RemoteMcpClientError";
    this.code = code;
    this.failureKind = details?.failureKind;
    this.upstreamStatus = details?.upstreamStatus;
  }
}

function upstreamStatusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599
    ? code
    : undefined;
}

function requestFailureDetails(error: unknown): {
  failureKind: NonNullable<RemoteMcpClientError["failureKind"]>;
  upstreamStatus?: number;
} {
  const upstreamStatus = upstreamStatusFromError(error);
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return { failureKind: "upstream_denied", upstreamStatus };
  }
  if (upstreamStatus === 429) {
    return { failureKind: "upstream_rate_limited", upstreamStatus };
  }
  if (upstreamStatus !== undefined) {
    return { failureKind: "upstream_error", upstreamStatus };
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { failureKind: "timeout" };
  }
  return { failureKind: "network_or_protocol" };
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

export function normalizeRemoteMcpPublicHttpsUrl(
  value: string,
  options: { allowQuery: boolean },
): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new RemoteMcpClientError("invalid_endpoint");
  }

  const encodedHostname = url.hostname.toLowerCase();
  const hostname = encodedHostname.replace(/\.+$/, "");

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    (!options.allowQuery && url.search !== "") ||
    url.hash !== "" ||
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
    throw new RemoteMcpClientError("invalid_endpoint");
  }

  url.hostname = hostname;
  if (url.port === "443") url.port = "";
  return url.toString();
}

export function normalizeRemoteMcpEndpoint(value: string): string {
  return normalizeRemoteMcpPublicHttpsUrl(value, { allowQuery: false });
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestCatalog(canonicalCatalog: string): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalCatalog))),
  );
}

function canonicalTool(tool: RemoteMcpTool): RemoteMcpTool {
  const description = tool.description?.trim();
  const annotations = tool.annotations;

  return {
    ...(annotations === undefined
      ? {}
      : {
          annotations: {
            ...(annotations.destructiveHint === undefined
              ? {}
              : { destructiveHint: annotations.destructiveHint }),
            ...(annotations.idempotentHint === undefined
              ? {}
              : { idempotentHint: annotations.idempotentHint }),
            ...(annotations.openWorldHint === undefined
              ? {}
              : { openWorldHint: annotations.openWorldHint }),
            ...(annotations.readOnlyHint === undefined
              ? {}
              : { readOnlyHint: annotations.readOnlyHint }),
            ...(annotations.title === undefined ? {} : { title: annotations.title }),
          },
        }),
    ...(description === undefined || description.length === 0 ? {} : { description }),
    inputSchema: tool.inputSchema,
    name: tool.name,
  };
}

function validateCatalog(tools: RemoteMcpTool[]): RemoteMcpTool[] {
  if (tools.length > MAXIMUM_REMOTE_MCP_TOOLS) {
    throw new RemoteMcpClientError("catalog_too_large");
  }

  const canonical = tools
    .map(canonicalTool)
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const names = new Set<string>();

  for (const tool of canonical) {
    const schemaBytes = encoder.encode(JSON.stringify(tool.inputSchema)).byteLength;

    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(tool.name) ||
      names.has(tool.name) ||
      (tool.description?.length ?? 0) > MAXIMUM_REMOTE_MCP_DESCRIPTION_CHARACTERS ||
      schemaBytes > MAXIMUM_REMOTE_MCP_SCHEMA_BYTES
    ) {
      throw new RemoteMcpClientError("invalid_catalog");
    }

    try {
      createRemoteMcpInputSchema(tool.inputSchema);
    } catch {
      throw new RemoteMcpClientError("invalid_catalog");
    }

    names.add(tool.name);
  }

  const parsed = remoteMcpCatalogSchema.safeParse(canonical);
  if (!parsed.success) throw new RemoteMcpClientError("invalid_catalog");
  return parsed.data;
}

function boundedResponse(response: Response, maximumBytes: number): Response {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw new RemoteMcpClientError("response_too_large");
    }
  }
  if (response.body === null) return response;

  let receivedBytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maximumBytes) {
          throw new RemoteMcpClientError("response_too_large");
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function sameOriginFetch(
  endpoint: string,
  implementation: typeof fetch,
  maximumResponseBytes: number,
): typeof fetch {
  const origin = new URL(endpoint).origin;

  return async (input, init) => {
    let requestUrl = normalizeRemoteMcpEndpoint(
      input instanceof Request ? input.url : input instanceof URL ? input.toString() : input,
    );

    for (let redirects = 0; ; redirects += 1) {
      if (new URL(requestUrl).origin !== origin) {
        throw new RemoteMcpClientError("invalid_endpoint");
      }

      const headers = new Headers(init?.headers);
      headers.set("user-agent", REMOTE_MCP_USER_AGENT);
      const response = await implementation(requestUrl, {
        ...init,
        headers,
        redirect: "manual",
      });
      if (response.status !== 307 && response.status !== 308) {
        return boundedResponse(response, maximumResponseBytes);
      }
      if (redirects >= MAXIMUM_REMOTE_MCP_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined);
        throw new RemoteMcpClientError("request_failed");
      }

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null) throw new RemoteMcpClientError("request_failed");
      requestUrl = normalizeRemoteMcpEndpoint(new URL(location, requestUrl).toString());
    }
  };
}

async function withRemoteClient<T>(
  options: RemoteMcpClientOptions,
  maximumResponseBytes: number,
  operation: "discovery" | "tool_call",
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const endpoint = normalizeRemoteMcpEndpoint(options.endpoint);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: sameOriginFetch(endpoint, options.fetchImplementation ?? fetch, maximumResponseBytes),
    reconnectionOptions: {
      initialReconnectionDelay: 1,
      maxReconnectionDelay: 1,
      maxRetries: 0,
      reconnectionDelayGrowFactor: 1,
    },
    requestInit: {
      ...(options.apiKey !== undefined
        ? { headers: { [options.apiKey.headerName]: options.apiKey.value } }
        : options.bearerToken === undefined
          ? {}
          : { headers: { Authorization: `Bearer ${options.bearerToken}` } }),
      redirect: "manual",
    },
  });
  const client = new Client(CLIENT_INFO, {
    capabilities: {},
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
  const compatibleTransport: Transport = {
    close: () => transport.close(),
    send: (message, sendOptions) =>
      transport.send(
        message,
        sendOptions === undefined
          ? undefined
          : {
              ...(sendOptions.onresumptiontoken === undefined
                ? {}
                : { onresumptiontoken: sendOptions.onresumptiontoken }),
              ...(sendOptions.resumptionToken === undefined
                ? {}
                : { resumptionToken: sendOptions.resumptionToken }),
            },
      ),
    setProtocolVersion: (version) => {
      transport.setProtocolVersion(version);
    },
    start: () => transport.start(),
  };
  Reflect.set(transport, "onclose", () => {
    compatibleTransport.onclose?.();
  });
  Reflect.set(transport, "onerror", (error: Error) => {
    compatibleTransport.onerror?.(error);
  });
  Reflect.set(transport, "onmessage", (message: unknown) => {
    const parsed = JSONRPCMessageSchema.safeParse(message);
    if (parsed.success) compatibleTransport.onmessage?.(parsed.data);
  });

  try {
    // Adapt the SDK's narrower callback declaration to its public Transport interface.
    await client.connect(compatibleTransport, { signal: options.signal });
    return await run(client);
  } catch (error) {
    if (error instanceof RemoteMcpClientError) throw error;
    const details = requestFailureDetails(error);
    console.warn({
      authKind:
        options.apiKey !== undefined
          ? "api_key"
          : options.bearerToken !== undefined
            ? "bearer"
            : "public",
      endpointHost: new URL(endpoint).hostname,
      errorName: error instanceof Error ? error.name : "unknown",
      event: "crewhelm.remote_mcp.request_failed",
      failureKind: details.failureKind,
      operation,
      ...(details.upstreamStatus === undefined ? {} : { upstreamStatus: details.upstreamStatus }),
    });
    throw new RemoteMcpClientError("request_failed", details);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function discoverRemoteMcpTools(
  options: RemoteMcpClientOptions,
): Promise<DiscoveredRemoteMcpCatalog> {
  return withRemoteClient(
    options,
    MAXIMUM_REMOTE_MCP_CATALOG_BYTES + MAXIMUM_PROTOCOL_OVERHEAD_BYTES,
    "discovery",
    async (client) => {
      const tools: RemoteMcpTool[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        if (pages >= MAXIMUM_DISCOVERY_PAGES) {
          throw new RemoteMcpClientError("catalog_too_large");
        }

        const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
          signal: options.signal,
        });
        tools.push(
          ...page.tools.map((tool) => ({
            ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
            name: tool.name,
          })),
        );
        if (
          tools.length > MAXIMUM_REMOTE_MCP_TOOLS ||
          encoder.encode(JSON.stringify(tools)).byteLength > MAXIMUM_REMOTE_MCP_CATALOG_BYTES
        ) {
          throw new RemoteMcpClientError("catalog_too_large");
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined);

      const canonical = validateCatalog(tools);
      const serialized = JSON.stringify(canonical);
      const catalogBytes = encoder.encode(serialized).byteLength;

      if (catalogBytes > MAXIMUM_REMOTE_MCP_CATALOG_BYTES) {
        throw new RemoteMcpClientError("catalog_too_large");
      }

      const server = client.getServerVersion();
      if (server === undefined) throw new RemoteMcpClientError("invalid_catalog");
      const credential = credentialValue(options);
      if (
        credential !== undefined &&
        containsCredential({ server, tools: canonical }, credential)
      ) {
        throw new RemoteMcpClientError("credential_reflected");
      }

      return {
        catalogBytes,
        digest: await digestCatalog(serialized),
        server: { name: server.name, version: server.version },
        tools: canonical,
      };
    },
  );
}

function containsCredential(value: unknown, credential: string): boolean {
  const pending: unknown[] = [value];
  const credentialFragments: string[] = [];
  const fragments =
    credential.length < 8
      ? []
      : [
          credential.slice(0, Math.ceil(credential.length / 2)),
          credential.slice(Math.floor(credential.length / 2)),
        ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (
        current.includes(credential) ||
        fragments.some((fragment) => current.includes(fragment))
      ) {
        return true;
      }
      if (current.length > 0 && credential.includes(current)) {
        credentialFragments.push(current);
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of (current as unknown[]).toReversed()) pending.push(item);
      continue;
    }
    if (typeof current === "object" && current !== null) {
      for (const [key, item] of Object.entries(current).toReversed()) {
        if (key.includes(credential) || fragments.some((fragment) => key.includes(fragment))) {
          return true;
        }
        pending.push(item);
      }
    }
  }

  return credentialFragments.join("").includes(credential);
}

export async function callRemoteMcpTool(
  options: RemoteMcpClientOptions & {
    arguments: Record<string, unknown>;
    maximumOutputBytes: number;
    toolName: string;
  },
): Promise<unknown> {
  return withRemoteClient(
    options,
    options.maximumOutputBytes + MAXIMUM_PROTOCOL_OVERHEAD_BYTES,
    "tool_call",
    async (client) => {
      const output = await client.callTool(
        { arguments: options.arguments, name: options.toolName },
        undefined,
        { signal: options.signal },
      );
      const serialized = JSON.stringify(output);

      if (encoder.encode(serialized).byteLength > options.maximumOutputBytes) {
        throw new RemoteMcpClientError("output_too_large");
      }

      const credential = credentialValue(options);
      if (credential !== undefined && containsCredential(output, credential)) {
        throw new RemoteMcpClientError("credential_reflected");
      }

      return output;
    },
  );
}
