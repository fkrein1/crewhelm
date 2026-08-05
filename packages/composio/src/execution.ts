import {
  composioConnectedAccountIdSchema,
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolParameterMapSchema,
  integrationToolSlugSchema,
  ownerKeySchema,
} from "@crewhelm/contracts";
import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";
import { isUnknownRecord } from "./safe-values.js";

const COMPOSIO_CONNECTED_ACCOUNTS_URL = "https://backend.composio.dev/api/v3.1/connected_accounts";
const COMPOSIO_TOOL_EXECUTION_URL = "https://backend.composio.dev/api/v3/tools/execute";
const COMPOSIO_FILE_UPLOAD_REQUEST_URL =
  "https://backend.composio.dev/api/v3.1/files/upload/request";
const MAXIMUM_CONNECTION_RESPONSE_BYTES = 256 * 1_024;
const MAXIMUM_UPLOAD_REQUEST_RESPONSE_BYTES = 32 * 1_024;
const MAXIMUM_STAGED_FILE_BYTES = 20 * 1_024 * 1_024;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const connectedAccountStatusSchema = z.enum([
  "ACTIVE",
  "EXPIRED",
  "FAILED",
  "INACTIVE",
  "INITIALIZING",
  "INITIATED",
  "REVOKED",
]);
const connectedAccountSchema = z.object({
  alias: z.unknown().optional(),
  id: composioConnectedAccountIdSchema,
  status: connectedAccountStatusSchema,
  toolkit: z.object({
    slug: integrationSlugSchema,
  }),
});
const toolExecutionResponseSchema = z.object({
  data: z.unknown(),
  error: z.string().nullish(),
  log_id: z.string().min(1).max(512).nullish(),
  success: z.boolean().optional(),
  successful: z.boolean().optional(),
});
const toolExecutionErrorSchema = z.object({
  error: z.object({
    code: z.number().int().nonnegative().safe(),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._-]+$/),
  }),
});
const stagedFileSourceSchema = z.strictObject({
  mimetype: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => {
      if (value.includes("/") || value.includes("\\")) return false;
      for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint < 32 || codePoint === 127) return false;
      }
      return true;
    }),
  source_url: z.url().max(8_192),
});
const fileUploadRequestResponseSchema = z.object({
  key: z.string().min(1).max(2_048),
  newPresignedUrl: z.url().max(8_192).optional(),
  new_presigned_url: z.url().max(8_192).optional(),
  type: z.enum(["existing", "new"]),
});

export interface ComposioRuntime {
  createInputSchema(parametersJson: string): z.ZodType<Record<string, unknown>>;
  execute(input: {
    arguments: Record<string, unknown>;
    maximumOutputBytes: number;
    providerConnectionId: string;
    signal: AbortSignal;
    timeoutMs: number;
    toolSlug: string;
    toolkitSlug?: string;
    toolkitVersion: string;
    userId: string;
  }): Promise<unknown>;
  verifyConnection(
    providerConnectionId: string,
    signal?: AbortSignal,
  ): Promise<ComposioConnectionVerificationResult>;
}

export type ComposioConnectionVerificationResult =
  | { accountLabel: string | null; ok: true; toolkitSlug: string }
  | {
      ok: false;
      reason:
        | "configuration_unavailable"
        | "invalid_request"
        | "invalid_response"
        | "provider_rejected"
        | "provider_unavailable"
        | "transport_error";
    };

export interface ComposioRuntimeOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  onResponse?: (event: ComposioRuntimeResponseEvent) => void;
}

export type ComposioRuntimeResponseEvent =
  | {
      durationMs: number;
      operation: "execute";
      outcome:
        | "accepted"
        | "invalid_response"
        | "provider_rejected"
        | "sensitive_response"
        | "transport_error";
      providerErrorCode?: number;
      status: number | null;
      toolSlug: string;
    }
  | {
      durationMs: number;
      operation: "stage_file";
      outcome:
        | "object_upload_failed"
        | "object_upload_rejected"
        | "processing_failed"
        | "source_download_aborted"
        | "source_download_failed"
        | "source_download_invalid_url"
        | "source_download_request_context"
        | "source_download_subrequest_limit"
        | "source_response_rejected"
        | "source_too_large"
        | "source_url_rejected"
        | "upload_request_failed"
        | "upload_request_invalid"
        | "upload_request_rejected"
        | "upload_url_rejected";
      status: number | null;
      toolSlug: string;
    }
  | {
      durationMs: number;
      operation: "verify";
      outcome:
        | "accepted"
        | "configuration_unavailable"
        | "invalid_response"
        | "provider_rejected"
        | "provider_unavailable"
        | "transport_error";
      status: number | null;
    };

function accountLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const label = value.trim();
  let printable = true;

  for (const character of label) {
    const codePoint = character.codePointAt(0);

    if (codePoint === undefined || codePoint < 32 || codePoint > 126) {
      printable = false;
      break;
    }
  }

  return label.length >= 1 && label.length <= 160 && printable ? label : null;
}
type WithoutDuration<Event> = Event extends unknown ? Omit<Event, "durationMs"> : never;

function containsSecret(value: unknown, secret: string): boolean {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (typeof current === "string" && current.includes(secret)) {
      return true;
    }

    if (Array.isArray(current)) {
      for (const item of current as unknown[]) {
        pending.push(item);
      }
    } else if (isUnknownRecord(current)) {
      pending.push(...Object.values(current));
    }
  }

  return false;
}

function containsSensitiveProviderOutput(
  value: unknown,
  providerConnectionId: string,
  apiKey: string,
): boolean {
  const sensitiveKeys = new Set([
    "accesskey",
    "accesstoken",
    "apikey",
    "apisecret",
    "authcode",
    "authorization",
    "authorizationcode",
    "bearer",
    "clientsecret",
    "cookie",
    "credential",
    "credentials",
    "idtoken",
    "jwt",
    "oauthcode",
    "password",
    "passphrase",
    "privatekey",
    "refreshtoken",
    "secret",
    "secretkey",
    "sessioncookie",
    "sessionid",
    "sessiontoken",
    "setcookie",
    "token",
  ]);
  const sensitiveStringPatterns = [
    /^Bearer\s+\S+/i,
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    /(?:^|;\s*)(?:auth|session|sessionid|token)=[^;\s]+/i,
    /^(?:github_pat_|gh[oprsu]_|sk-|xox[a-z]-)[A-Za-z0-9_-]+$/,
  ];
  const sensitiveKeyFragments = [
    "accesskey",
    "accesstoken",
    "apikey",
    "apisecret",
    "authorizationcode",
    "clientsecret",
    "idtoken",
    "privatekey",
    "refreshtoken",
    "secretkey",
    "sessioncookie",
    "sessiontoken",
  ];
  const isSensitiveKey = (key: string): boolean => {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

    return (
      sensitiveKeys.has(normalizedKey) ||
      sensitiveKeyFragments.some((fragment) => normalizedKey.includes(fragment)) ||
      /(?:^|auth|oauth|bearer|jwt)token(?:value|string|text|data)?$/.test(normalizedKey) ||
      /secret(?:value|string|text|data)$/.test(normalizedKey)
    );
  };
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (
      typeof current === "string" &&
      (current.includes(apiKey) ||
        current.includes(providerConnectionId) ||
        sensitiveStringPatterns.some((pattern) => pattern.test(current)))
    ) {
      return true;
    }

    if (Array.isArray(current)) {
      for (const item of current as unknown[]) {
        pending.push(item);
      }
    } else if (isUnknownRecord(current)) {
      const entries = Object.entries(current);
      const descriptor = entries.find(
        ([key, item]) =>
          ["key", "label", "name", "type"].includes(key.toLowerCase().replaceAll(/[^a-z]/g, "")) &&
          typeof item === "string",
      )?.[1];

      if (typeof descriptor === "string" && isSensitiveKey(descriptor)) {
        return true;
      }

      for (const [key, item] of entries) {
        if (isSensitiveKey(key)) {
          return true;
        }

        pending.push(item);
      }
    }
  }

  return false;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

const stagedFileSourceJsonSchema = {
  additionalProperties: false,
  description:
    "A public HTTPS file for Crewhelm to stage privately before this action. Redirects, credentials, private hosts, and files over 20 MiB are rejected.",
  properties: {
    mimetype: {
      description: "Exact expected media type, such as application/pdf.",
      maxLength: 255,
      minLength: 3,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$",
      type: "string",
    },
    name: {
      description: "Safe attachment filename without path separators.",
      maxLength: 255,
      minLength: 1,
      pattern: "^[^\\\\/\\u0000-\\u001f\\u007f]+$",
      type: "string",
    },
    source_url: {
      description: "Public HTTPS URL Crewhelm should download and stage.",
      format: "uri",
      maxLength: 8192,
      type: "string",
    },
  },
  required: ["mimetype", "name", "source_url"],
  type: "object",
} as const;

function exposeStagedFileSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(exposeStagedFileSources);
  if (!isUnknownRecord(value)) return value;

  const transformed = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, exposeStagedFileSources(item)]),
  );

  return value.file_uploadable === true
    ? {
        anyOf: [transformed, stagedFileSourceJsonSchema],
        description:
          typeof value.description === "string"
            ? `${value.description} You may also provide a Crewhelm public HTTPS file source.`
            : "Provide the provider file reference or a Crewhelm public HTTPS file source.",
      }
    : transformed;
}

type FileStagingFailure = Extract<
  ComposioRuntimeResponseEvent,
  { operation: "stage_file" }
>["outcome"];

class ComposioFileStagingError extends Error {
  constructor(
    readonly reason: FileStagingFailure,
    readonly status: number | null = null,
  ) {
    super("Composio file staging failed.");
    this.name = "ComposioFileStagingError";
  }
}

export function isComposioFileStagingError(error: unknown): boolean {
  return error instanceof ComposioFileStagingError;
}

function classifySourceDownloadFailure(error: unknown, signal: AbortSignal): FileStagingFailure {
  if (signal.aborted) return "source_download_aborted";

  const errorRecord = isUnknownRecord(error) ? error : undefined;
  const rawName =
    error instanceof Error
      ? error.name
      : typeof errorRecord?.name === "string"
        ? errorRecord.name
        : "";
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof errorRecord?.message === "string"
        ? errorRecord.message
        : "";
  const name = rawName.toLowerCase();
  const message = rawMessage.toLowerCase();

  if (name === "aborterror" || name === "timeouterror") return "source_download_aborted";
  if (message.includes("different request") || message.includes("request context")) {
    return "source_download_request_context";
  }
  if (
    message.includes("subrequest") &&
    (message.includes("limit") || message.includes("too many"))
  ) {
    return "source_download_subrequest_limit";
  }
  if (
    message.includes("fetch api cannot load") ||
    message.includes("invalid url") ||
    message.includes("url is invalid")
  ) {
    return "source_download_invalid_url";
  }
  return "source_download_failed";
}

function validatePublicHttpsFileUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ComposioFileStagingError("source_url_rejected");
  }
  const encodedHostname = parsed.hostname.toLowerCase();
  const hostname = encodedHostname.replace(/\.+$/, "");
  const ipv4 = hostname.split(".");
  const numericIpv4 =
    ipv4.length === 4 && ipv4.every((part) => /^\d+$/.test(part)) ? ipv4.map(Number) : undefined;
  const [first = 0, second = 0] = numericIpv4 ?? [];
  const deniedIpv4 =
    numericIpv4 !== undefined &&
    (numericIpv4.some((part) => part < 0 || part > 255) ||
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && [18, 19].includes(second)) ||
      first >= 224);

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "443") ||
    hostname === "" ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".onion") ||
    encodedHostname.startsWith("[") ||
    deniedIpv4
  ) {
    throw new ComposioFileStagingError("source_url_rejected");
  }
  return value;
}

function exactFileRequest(
  url: string,
  init: RequestInit,
  rejectedOutcome: "source_download_invalid_url" | "upload_url_rejected",
): Request {
  let request: Request;
  try {
    request = new Request(url, init);
  } catch {
    throw new ComposioFileStagingError(rejectedOutcome);
  }
  if (request.url !== url) throw new ComposioFileStagingError(rejectedOutcome);
  return request;
}

async function readBoundedFile(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_STAGED_FILE_BYTES) {
    throw new ComposioFileStagingError("source_too_large");
  }

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAXIMUM_STAGED_FILE_BYTES) {
        await reader.cancel();
        throw new ComposioFileStagingError("source_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function stageFileSource(input: {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  file: z.infer<typeof stagedFileSourceSchema>;
  signal: AbortSignal;
  toolkitSlug: string | undefined;
  toolSlug: string;
}): Promise<{ mimetype: string; name: string; s3key: string }> {
  if (input.toolkitSlug === undefined) throw new ComposioFileStagingError("processing_failed");
  const fetchImplementation = input.fetch;
  const sourceUrl = validatePublicHttpsFileUrl(input.file.source_url);
  const createSourceRequest = (): Request =>
    exactFileRequest(
      sourceUrl,
      {
        headers: { accept: input.file.mimetype },
        method: "GET",
        redirect: "manual",
        signal: input.signal,
      },
      "source_download_invalid_url",
    );
  let sourceResponse: Response;
  try {
    sourceResponse = await fetchImplementation(createSourceRequest());
  } catch (firstError) {
    if (firstError instanceof ComposioFileStagingError) throw firstError;
    const firstFailure = classifySourceDownloadFailure(firstError, input.signal);
    if (firstFailure !== "source_download_failed") {
      throw new ComposioFileStagingError(firstFailure);
    }

    try {
      sourceResponse = await fetchImplementation(createSourceRequest());
    } catch (secondError) {
      if (secondError instanceof ComposioFileStagingError) throw secondError;
      throw new ComposioFileStagingError(classifySourceDownloadFailure(secondError, input.signal));
    }
  }
  const sourceType = sourceResponse.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (
    sourceResponse.status !== 200 ||
    sourceType?.toLowerCase() !== input.file.mimetype.toLowerCase()
  ) {
    throw new ComposioFileStagingError("source_response_rejected", sourceResponse.status);
  }
  const bytes = await readBoundedFile(sourceResponse);
  let uploadRequest: Response;
  try {
    uploadRequest = await fetchImplementation(COMPOSIO_FILE_UPLOAD_REQUEST_URL, {
      body: JSON.stringify({
        filename: input.file.name,
        md5: bytesToHex(md5(bytes)),
        mimetype: input.file.mimetype,
        toolkit_slug: input.toolkitSlug,
        tool_slug: input.toolSlug,
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": input.apiKey,
      },
      method: "POST",
      redirect: "manual",
      signal: input.signal,
    });
  } catch {
    throw new ComposioFileStagingError("upload_request_failed");
  }
  if (
    uploadRequest.status !== 200 ||
    !uploadRequest.headers.get("content-type")?.toLowerCase().startsWith("application/json")
  ) {
    throw new ComposioFileStagingError("upload_request_rejected", uploadRequest.status);
  }
  const uploadBody = await readBoundedJson(uploadRequest, MAXIMUM_UPLOAD_REQUEST_RESPONSE_BYTES);
  const upload = uploadBody.ok ? fileUploadRequestResponseSchema.safeParse(uploadBody.value) : null;
  if (upload === null || !upload.success) {
    throw new ComposioFileStagingError("upload_request_invalid", uploadRequest.status);
  }

  if (upload.data.type === "new") {
    const presignedValue = upload.data.new_presigned_url ?? upload.data.newPresignedUrl;
    if (presignedValue === undefined) {
      throw new ComposioFileStagingError("upload_request_invalid", uploadRequest.status);
    }
    let presignedUrl: string;
    try {
      presignedUrl = validatePublicHttpsFileUrl(presignedValue);
    } catch {
      throw new ComposioFileStagingError("upload_url_rejected");
    }
    let uploaded: Response;
    try {
      uploaded = await fetchImplementation(
        exactFileRequest(
          presignedUrl,
          {
            body: new Uint8Array(bytes).buffer,
            headers: { "content-type": input.file.mimetype },
            method: "PUT",
            redirect: "manual",
            signal: input.signal,
          },
          "upload_url_rejected",
        ),
      );
    } catch (error) {
      if (error instanceof ComposioFileStagingError) throw error;
      throw new ComposioFileStagingError("object_upload_failed");
    }
    if (uploaded.status < 200 || uploaded.status >= 300) {
      throw new ComposioFileStagingError("object_upload_rejected", uploaded.status);
    }
  }

  return { mimetype: input.file.mimetype, name: input.file.name, s3key: upload.data.key };
}

async function stageFileSources(
  value: unknown,
  context: Omit<Parameters<typeof stageFileSource>[0], "file"> & { stagedFiles: { count: number } },
): Promise<unknown> {
  const source = stagedFileSourceSchema.safeParse(value);
  if (source.success) {
    context.stagedFiles.count += 1;
    if (context.stagedFiles.count > 4) {
      throw new ComposioFileStagingError("processing_failed");
    }
    return stageFileSource({ ...context, file: source.data });
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(await stageFileSources(item, context));
    return result;
  }
  if (!isUnknownRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = await stageFileSources(item, context);
  }
  return result;
}

function normalizeProviderArguments(
  toolSlug: string,
  argumentsValue: Record<string, unknown>,
): Record<string, unknown> {
  if (toolSlug !== "SLACK_SEND_MESSAGE") return argumentsValue;

  const normalized = { ...argumentsValue };
  if (Array.isArray(normalized.blocks) && normalized.blocks.length === 0) delete normalized.blocks;
  if (normalized.fallback_text === "") delete normalized.fallback_text;
  if (normalized.thread_ts === "") delete normalized.thread_ts;
  return normalized;
}

type ZodJsonSchema = Parameters<typeof z.fromJSONSchema>[0];

function isJsonSchema(value: unknown): value is Exclude<ZodJsonSchema, boolean> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRootObjectJsonSchema(value: Record<string, unknown>): value is Exclude<
  ZodJsonSchema,
  boolean
> & {
  properties: Record<string, unknown>;
  type: "object";
} {
  return value.type === "object" && isJsonSchema(value.properties);
}

export function createComposioRuntime(options: ComposioRuntimeOptions): ComposioRuntime {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  function recordResponse(event: WithoutDuration<ComposioRuntimeResponseEvent>, startedAt: number) {
    try {
      options.onResponse?.({
        ...event,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    } catch {
      // Diagnostic telemetry must not alter provider behavior.
    }
  }

  return {
    createInputSchema(parametersJson) {
      const parsedParameters = integrationToolParameterMapSchema.parse(JSON.parse(parametersJson));

      if (!isRootObjectJsonSchema(parsedParameters)) {
        throw new Error("Composio tool schema is unavailable.");
      }

      const exposedParameters = exposeStagedFileSources({
        ...parsedParameters,
        additionalProperties: false,
      });

      if (!isJsonSchema(exposedParameters)) {
        throw new Error("Composio tool schema is unavailable.");
      }

      const schema = z.fromJSONSchema(exposedParameters);

      return z.pipe(schema, z.record(z.string(), z.unknown()));
    },

    async execute(input) {
      if (!apiKey.success) {
        throw new Error("Composio tool execution is unavailable.");
      }

      const providerConnectionId = composioConnectedAccountIdSchema.parse(
        input.providerConnectionId,
      );
      const toolSlug = integrationToolSlugSchema.parse(input.toolSlug);
      const toolkitVersion = integrationToolkitVersionSchema.parse(input.toolkitVersion);
      const userId = ownerKeySchema.parse(input.userId);
      const executionSignal = requestSignal(input.signal, input.timeoutMs);
      const stagingStartedAt = performance.now();
      let argumentsWithStagedFiles: unknown;

      try {
        argumentsWithStagedFiles = await stageFileSources(
          normalizeProviderArguments(toolSlug, input.arguments),
          {
            apiKey: apiKey.data,
            fetch: fetchImplementation,
            signal: executionSignal,
            stagedFiles: { count: 0 },
            toolkitSlug:
              input.toolkitSlug === undefined
                ? undefined
                : integrationSlugSchema.parse(input.toolkitSlug),
            toolSlug,
          },
        );
      } catch (error) {
        const failure =
          error instanceof ComposioFileStagingError
            ? error
            : new ComposioFileStagingError("processing_failed");
        recordResponse(
          {
            operation: "stage_file",
            outcome: failure.reason,
            status: failure.status,
            toolSlug,
          },
          stagingStartedAt,
        );
        throw failure;
      }
      const endpoint = new URL(`${COMPOSIO_TOOL_EXECUTION_URL}/${encodeURIComponent(toolSlug)}`);
      const startedAt = performance.now();
      let response: Response;

      try {
        response = await fetchImplementation(endpoint, {
          body: JSON.stringify({
            arguments: argumentsWithStagedFiles,
            connected_account_id: providerConnectionId,
            user_id: userId,
            version: toolkitVersion,
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": apiKey.data,
          },
          method: "POST",
          redirect: "manual",
          signal: executionSignal,
        });
      } catch {
        recordResponse(
          {
            operation: "execute",
            outcome: "transport_error",
            status: null,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        let providerError: z.infer<typeof toolExecutionErrorSchema> | undefined;

        if (response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          const errorBody = await readBoundedJson(response, 32 * 1_024);

          if (errorBody.ok) {
            const parsedError = toolExecutionErrorSchema.safeParse(errorBody.value);
            providerError = parsedError.success ? parsedError.data : undefined;
          }
        }

        recordResponse(
          {
            operation: "execute",
            outcome: "provider_rejected",
            ...(providerError === undefined
              ? {}
              : {
                  providerErrorCode: providerError.error.code,
                }),
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      const executionBody = await readBoundedJson(response, input.maximumOutputBytes);

      if (!executionBody.ok) {
        recordResponse(
          {
            operation: "execute",
            outcome: "invalid_response",
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      const execution = toolExecutionResponseSchema.safeParse(executionBody.value);

      if (
        !execution.success ||
        (execution.data.success ?? execution.data.successful) !== true ||
        execution.data.error != null
      ) {
        recordResponse(
          {
            operation: "execute",
            outcome: execution.success ? "provider_rejected" : "invalid_response",
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      if (containsSensitiveProviderOutput(execution.data.data, providerConnectionId, apiKey.data)) {
        recordResponse(
          {
            operation: "execute",
            outcome: "sensitive_response",
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      recordResponse(
        {
          operation: "execute",
          outcome: "accepted",
          status: response.status,
          toolSlug,
        },
        startedAt,
      );
      return execution.data.data;
    },

    async verifyConnection(providerConnectionId, signal) {
      if (!apiKey.success) {
        return { ok: false, reason: "configuration_unavailable" };
      }

      const parsedId = composioConnectedAccountIdSchema.safeParse(providerConnectionId);

      if (!parsedId.success) {
        return { ok: false, reason: "invalid_request" };
      }

      const endpoint = new URL(
        `${COMPOSIO_CONNECTED_ACCOUNTS_URL}/${encodeURIComponent(parsedId.data)}`,
      );
      const startedAt = performance.now();

      try {
        const response = await fetchImplementation(endpoint, {
          headers: {
            accept: "application/json",
            "x-api-key": apiKey.data,
          },
          method: "GET",
          redirect: "manual",
          signal: requestSignal(signal, 5_000),
        });

        if (response.status !== 200) {
          const configurationUnavailable = response.status === 401 || response.status === 403;
          const unavailable = response.status === 429 || response.status >= 500;
          const outcome = configurationUnavailable
            ? "configuration_unavailable"
            : unavailable
              ? "provider_unavailable"
              : "provider_rejected";

          recordResponse(
            {
              operation: "verify",
              outcome,
              status: response.status,
            },
            startedAt,
          );
          return {
            ok: false,
            reason: outcome,
          };
        }

        if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          recordResponse(
            {
              operation: "verify",
              outcome: "invalid_response",
              status: response.status,
            },
            startedAt,
          );
          return { ok: false, reason: "invalid_response" };
        }

        const accountBody = await readBoundedJson(response, MAXIMUM_CONNECTION_RESPONSE_BYTES);

        if (!accountBody.ok) {
          recordResponse(
            {
              operation: "verify",
              outcome: "invalid_response",
              status: response.status,
            },
            startedAt,
          );
          return { ok: false, reason: "invalid_response" };
        }

        const account = connectedAccountSchema.safeParse(accountBody.value);

        if (
          !account.success ||
          account.data.id !== parsedId.data ||
          containsSecret(account.data, apiKey.data)
        ) {
          recordResponse(
            {
              operation: "verify",
              outcome: "invalid_response",
              status: response.status,
            },
            startedAt,
          );
          return { ok: false, reason: "invalid_response" };
        }

        if (account.data.status !== "ACTIVE") {
          recordResponse(
            {
              operation: "verify",
              outcome: "provider_rejected",
              status: response.status,
            },
            startedAt,
          );
          return { ok: false, reason: "provider_rejected" };
        }

        recordResponse(
          {
            operation: "verify",
            outcome: "accepted",
            status: response.status,
          },
          startedAt,
        );
        return {
          accountLabel: accountLabel(account.data.alias),
          ok: true,
          toolkitSlug: account.data.toolkit.slug,
        };
      } catch {
        recordResponse(
          {
            operation: "verify",
            outcome: "transport_error",
            status: null,
          },
          startedAt,
        );
        return { ok: false, reason: "transport_error" };
      }
    },
  };
}
