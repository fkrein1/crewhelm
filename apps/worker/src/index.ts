import { healthReportSchema } from "@crewhelm/contracts";
import { Hono } from "hono";

const HEALTH_REPORT = healthReportSchema.parse({
  service: "crewhelm",
  status: "ok",
});
const HEALTH_BODY = `${JSON.stringify(HEALTH_REPORT)}\n`;
const METHOD_NOT_ALLOWED_BODY = `${JSON.stringify({
  error: {
    code: "method_not_allowed",
    message: "Method not allowed.",
  },
})}\n`;
const NOT_FOUND_BODY = `${JSON.stringify({
  error: {
    code: "not_found",
    message: "Not found.",
  },
})}\n`;
const INTERNAL_ERROR_BODY = `${JSON.stringify({
  error: {
    code: "internal_error",
    message: "Internal server error.",
  },
})}\n`;

function jsonResponse(
  body: string | null,
  bodyLength: number,
  status: number,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-length", String(bodyLength));
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");

  return new Response(body, { headers, status });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const HEALTH_BODY_LENGTH = byteLength(HEALTH_BODY);
const METHOD_NOT_ALLOWED_BODY_LENGTH = byteLength(METHOD_NOT_ALLOWED_BODY);
const NOT_FOUND_BODY_LENGTH = byteLength(NOT_FOUND_BODY);
const INTERNAL_ERROR_BODY_LENGTH = byteLength(INTERNAL_ERROR_BODY);

export function createWorker(): Hono {
  const worker = new Hono({
    getPath: (request) => new URL(request.url).pathname,
  });

  worker.onError((_error, context) =>
    jsonResponse(
      context.req.method === "HEAD" ? null : INTERNAL_ERROR_BODY,
      INTERNAL_ERROR_BODY_LENGTH,
      500,
    ),
  );

  worker.on(["GET", "HEAD"], "/health", (context) =>
    jsonResponse(context.req.method === "HEAD" ? null : HEALTH_BODY, HEALTH_BODY_LENGTH, 200),
  );

  worker.all("/health", () =>
    jsonResponse(METHOD_NOT_ALLOWED_BODY, METHOD_NOT_ALLOWED_BODY_LENGTH, 405, {
      allow: "GET, HEAD",
    }),
  );

  worker.notFound((context) =>
    jsonResponse(context.req.method === "HEAD" ? null : NOT_FOUND_BODY, NOT_FOUND_BODY_LENGTH, 404),
  );

  return worker;
}

export default createWorker();
