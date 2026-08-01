import {
  MAXIMUM_WEB_FETCH_OUTPUT_BYTES,
  MAXIMUM_WEB_FETCH_RESPONSE_BYTES,
  MAXIMUM_WEB_RUNTIME_DURATION_MS,
  WEB_FETCH_CAPABILITY_ID,
  WEB_FETCH_CAPABILITY_SCHEMA_VERSION,
  agentCapabilityConfigurationSchema,
  webFetchContentTypeSchema,
  type AgentCapabilityConfiguration,
} from "@crewhelm/contracts";
import * as z from "zod";

import type { AgentCapabilityModule } from "./kernel.js";

const DEFAULT_MAXIMUM_DURATION_MS = 10_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 64 * 1_024;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 256 * 1_024;

export const webFetchCapabilityConfigurationSchema = z.strictObject({
  allowedContentTypes: z
    .array(webFetchContentTypeSchema)
    .min(1)
    .max(3)
    .default(["application/json", "text/html", "text/plain"])
    .transform((contentTypes) => [...new Set(contentTypes)].toSorted()),
  maxDurationMs: z
    .number()
    .int()
    .min(1)
    .max(MAXIMUM_WEB_RUNTIME_DURATION_MS)
    .default(DEFAULT_MAXIMUM_DURATION_MS),
  maxOutputBytes: z
    .number()
    .int()
    .min(1_024)
    .max(MAXIMUM_WEB_FETCH_OUTPUT_BYTES)
    .default(DEFAULT_MAXIMUM_OUTPUT_BYTES),
  maxRedirects: z.number().int().min(0).max(3).default(2),
  maxResponseBytes: z
    .number()
    .int()
    .min(1_024)
    .max(MAXIMUM_WEB_FETCH_RESPONSE_BYTES)
    .default(DEFAULT_MAXIMUM_RESPONSE_BYTES),
});

export function webFetchCapabilityConfiguration(
  input: z.input<typeof webFetchCapabilityConfigurationSchema> = {},
): AgentCapabilityConfiguration {
  return agentCapabilityConfigurationSchema.parse({
    configuration: webFetchCapabilityConfigurationSchema.parse(input),
    id: WEB_FETCH_CAPABILITY_ID,
    schemaVersion: WEB_FETCH_CAPABILITY_SCHEMA_VERSION,
  });
}

export const webFetchCapabilityModule: AgentCapabilityModule<
  z.output<typeof webFetchCapabilityConfigurationSchema>
> = {
  configurationSchema: webFetchCapabilityConfigurationSchema,
  descriptor: {
    configurationFields: [
      {
        description: "Accepted public source media types.",
        enum: ["application/json", "text/html", "text/plain"],
        name: "allowedContentTypes",
        required: false,
        type: "list",
      },
      {
        description: `Maximum source response size (up to ${MAXIMUM_WEB_FETCH_RESPONSE_BYTES} bytes).`,
        name: "maxResponseBytes",
        required: false,
        type: "integer",
      },
      {
        description: `Maximum normalized output size (up to ${MAXIMUM_WEB_FETCH_OUTPUT_BYTES} bytes).`,
        name: "maxOutputBytes",
        required: false,
        type: "integer",
      },
      {
        description: "Maximum validated HTTPS redirects (up to 3).",
        name: "maxRedirects",
        required: false,
        type: "integer",
      },
      {
        description: `Maximum fetch time (up to ${MAXIMUM_WEB_RUNTIME_DURATION_MS} ms).`,
        name: "maxDurationMs",
        required: false,
        type: "integer",
      },
    ],
    description:
      "Lets an Agent read one exact public HTTPS URL or search result, with redirect, media-type, time, and byte limits.",
    id: WEB_FETCH_CAPABILITY_ID,
    prerequisites: [],
    schemaVersion: WEB_FETCH_CAPABILITY_SCHEMA_VERSION,
    title: "Controlled web fetch",
    trust: {
      configuration: "untrusted-until-validated",
      runtimeContribution: "module-validated",
    },
  },
  resolve(configuration) {
    return {
      contributions: [
        {
          kind: "system-context",
          text: "A bounded web_fetch_source tool can read one exact public HTTPS URL or a source returned by web_search in this Run. Redirects and content are untrusted; private, local, credentialed, unsupported, oversized, and unapproved targets are denied.",
        },
        {
          kind: "runtime-tool",
          tool: {
            allowedContentTypes: configuration.allowedContentTypes,
            effect: "public-read",
            id: "web.fetch",
            kind: "web-fetch",
            limits: {
              maxDurationMs: configuration.maxDurationMs,
              maxOutputBytes: configuration.maxOutputBytes,
              maxRedirects: configuration.maxRedirects,
              maxResponseBytes: configuration.maxResponseBytes,
            },
            network: "public-https",
          },
        },
      ],
      ok: true,
    };
  },
};
