import { HEALTH_PATH, healthReportSchema } from "@crewhelm/contracts";
import * as z from "zod";

const MAX_HEALTH_RESPONSE_BYTES = 4_096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const deploymentOriginInputSchema = z.string().trim().min(1).max(2_048);

export const doctorReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  checks: z.tuple([
    z.strictObject({
      code: z.enum([
        "healthy",
        "timeout",
        "request_failed",
        "response_too_large",
        "http_status",
        "content_type",
        "invalid_json",
        "invalid_payload",
      ]),
      endpoint: z.url(),
      message: z.string(),
      name: z.literal("worker-health"),
      status: z.enum(["pass", "fail"]),
    }),
  ]),
});

export type DoctorReport = z.infer<typeof doctorReportSchema>;

export class DoctorInputError extends Error {
  override readonly name = "DoctorInputError";
}

class ResponseTooLargeError extends Error {
  override readonly name = "ResponseTooLargeError";
}

export function parseDeploymentOrigin(input: string): URL {
  const parsedInput = deploymentOriginInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw new DoctorInputError("The endpoint must be a URL no longer than 2048 characters.");
  }

  let origin: URL;

  try {
    origin = new URL(parsedInput.data);
  } catch {
    throw new DoctorInputError("The endpoint must be a valid absolute URL.");
  }

  if (origin.username || origin.password) {
    throw new DoctorInputError("The endpoint must not include credentials.");
  }

  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new DoctorInputError(
      "The endpoint must be an origin without a path, query, or fragment.",
    );
  }

  const isHttps = origin.protocol === "https:";
  const isLoopbackHttp = origin.protocol === "http:" && LOOPBACK_HOSTS.has(origin.hostname);

  if (!isHttps && !isLoopbackHttp) {
    throw new DoctorInputError("Use HTTPS, or HTTP only for an exact loopback host.");
  }

  return new URL(origin.origin);
}

type DoctorCheckCode = DoctorReport["checks"][0]["code"];

function createReport(endpoint: URL, code: DoctorCheckCode, message: string): DoctorReport {
  const passed = code === "healthy";

  return doctorReportSchema.parse({
    schemaVersion: 1,
    ok: passed,
    checks: [
      {
        code,
        endpoint: endpoint.href,
        message,
        name: "worker-health",
        status: passed ? "pass" : "fail",
      },
    ],
  });
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    byteLength += result.value.byteLength;

    if (byteLength > MAX_HEALTH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }

    chunks.push(result.value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export interface DoctorDependencies {
  fetch: typeof globalThis.fetch;
}

export interface DoctorOptions {
  origin: URL;
  timeoutMs: number;
}

export async function checkWorkerHealth(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const endpoint = new URL(HEALTH_PATH, options.origin);
  let response: Response;
  let body: string;

  try {
    response = await dependencies.fetch(endpoint, {
      headers: {
        accept: "application/json",
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    body = await readBoundedBody(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return createReport(
        endpoint,
        "response_too_large",
        `Health response exceeded ${MAX_HEALTH_RESPONSE_BYTES} bytes.`,
      );
    }

    return createReport(
      endpoint,
      isTimeout(error) ? "timeout" : "request_failed",
      isTimeout(error) ? "Health request timed out." : "Health request failed.",
    );
  }

  if (response.status !== 200) {
    return createReport(
      endpoint,
      "http_status",
      "Health endpoint returned an unexpected HTTP status.",
    );
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

  if (contentType !== "application/json") {
    return createReport(endpoint, "content_type", "Health endpoint did not return JSON.");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    return createReport(endpoint, "invalid_json", "Health endpoint returned invalid JSON.");
  }

  if (!healthReportSchema.safeParse(payload).success) {
    return createReport(
      endpoint,
      "invalid_payload",
      "Health endpoint returned an invalid Crewhelm health report.",
    );
  }

  return createReport(endpoint, "healthy", "Worker health contract is valid.");
}
