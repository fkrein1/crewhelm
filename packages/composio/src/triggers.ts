import {
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  type IntegrationToolParameterValue,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";

const COMPOSIO_TRIGGER_TYPES_URL = "https://backend.composio.dev/api/v3.1/triggers_types";
const COMPOSIO_TRIGGER_CATALOG_TIMEOUT_MS = 5_000;
const MAXIMUM_COMPOSIO_TRIGGER_CATALOG_PAGES = 4;
const MAXIMUM_COMPOSIO_TRIGGER_RESPONSE_BYTES = 512 * 1_024;
const MAXIMUM_COMPOSIO_WATCHABLE_EVENTS = 20;
const SLACK_CHANNEL_FILTER_SOURCES = new Set([
  "SLACK_RECEIVE_BOT_MESSAGE",
  "SLACK_RECEIVE_MESSAGE",
]);
const SLACK_CHANNEL_FILTER_ID = "channelId";

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioTriggerConfigurationFieldIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/);
const composioTriggerConfigurationSchema = z
  .record(composioTriggerConfigurationFieldIdSchema, z.unknown())
  .refine((configuration) => Object.keys(configuration).length <= 32);
const composioTriggerConfigurationFieldSchema = z.looseObject({
  description: z.string().min(1).max(300).nullish(),
  display_name: z.string().min(1).max(120).nullish(),
  enum: z
    .array(z.union([z.string().min(1).max(160), z.number().finite(), z.boolean()]))
    .max(50)
    .optional(),
  label: z.string().min(1).max(120).nullish(),
  name: z.string().min(1).max(120).nullish(),
  options: z
    .array(z.union([z.string().min(1).max(160), z.number().finite(), z.boolean()]))
    .max(50)
    .optional(),
  required: z.boolean().optional(),
  title: z.string().min(1).max(120).nullish(),
  type: z.string().min(1).max(32),
});
const composioTriggerJsonSchemaConfigurationSchema = z.looseObject({
  properties: z
    .record(composioTriggerConfigurationFieldIdSchema, z.unknown())
    .refine((properties) => Object.keys(properties).length <= 32),
  required: z.array(composioTriggerConfigurationFieldIdSchema).max(32).optional(),
  type: z.literal("object"),
});
const composioTriggerTypeSchema = z.looseObject({
  config: composioTriggerConfigurationSchema,
  description: z.string().min(1).max(500).nullish(),
  name: z.string().min(1).max(160),
  requires_webhook_endpoint_setup: z.boolean(),
  slug: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Z0-9_]+$/),
  toolkit: z.looseObject({
    name: z.string().min(1).max(160),
    slug: integrationSlugSchema,
  }),
  type: z.string().min(1).max(32),
  version: integrationToolkitVersionSchema,
});
const composioTriggerCatalogResponseSchema = z.looseObject({
  items: z.array(composioTriggerTypeSchema).max(50),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});

const supportedWatchCohorts = {
  github: (slug: string) => /(?:^|_)(?:ISSUE|PULL_REQUEST)(?:_|$)/.test(slug),
  gmail: (slug: string) =>
    /(?:^|_)(?:NEW|RECEIVED?)(?:_[A-Z0-9]+)*_MESSAGE(?:_|$)|(?:^|_)MESSAGE(?:_[A-Z0-9]+)*_(?:NEW|RECEIVED?)(?:_|$)/.test(
      slug,
    ),
  linear: (slug: string) => /(?:^|_)ISSUE(?:_|$)/.test(slug),
  slack: (slug: string) => SLACK_CHANNEL_FILTER_SOURCES.has(slug),
} as const;

export interface ComposioWatchableEventConfigurationField {
  description: string | null;
  id: string;
  label: string;
  options: (boolean | number | string)[];
  required: boolean;
  type: "boolean" | "number" | "select" | "string";
}

export interface ComposioWatchableEvent {
  configuration: ComposioWatchableEventConfigurationField[];
  delivery: "provider_polling" | "realtime";
  description: string | null;
  integration: {
    name: string;
    slug: string;
  };
  name: string;
  slug: string;
  version: string;
}

export type ComposioWatchableEventCatalogResult =
  | { events: ComposioWatchableEvent[]; ok: true }
  | {
      error: {
        code: "integration_catalog_unavailable";
        message: "Integration event catalog request denied.";
      };
      ok: false;
    };

export interface ComposioEventCatalog {
  listWatchableEvents(input: {
    integrationSlug: string;
  }): Promise<ComposioWatchableEventCatalogResult>;
}

export interface ComposioEventCatalogOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

function unavailable(): ComposioWatchableEventCatalogResult {
  return {
    error: {
      code: "integration_catalog_unavailable",
      message: "Integration event catalog request denied.",
    },
    ok: false,
  };
}

function containsSecret(value: unknown, secret: string): boolean {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (typeof current === "string" && current.includes(secret)) {
      return true;
    }

    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }

    if (typeof current === "object" && current !== null) {
      pending.push(...Object.values(current));
    }
  }

  return false;
}

function labelFromId(id: string): string {
  return id
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_.-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function normalizeConfiguration(
  configuration: z.infer<typeof composioTriggerConfigurationSchema>,
): ComposioWatchableEventConfigurationField[] | null {
  const jsonSchema = composioTriggerJsonSchemaConfigurationSchema.safeParse(configuration);
  const configurationFields = jsonSchema.success ? jsonSchema.data.properties : configuration;
  const requiredFields = new Set(jsonSchema.success ? (jsonSchema.data.required ?? []) : []);
  const fields: ComposioWatchableEventConfigurationField[] = [];

  if ([...requiredFields].some((id) => !Object.hasOwn(configurationFields, id))) {
    return null;
  }

  for (const [id, value] of Object.entries(configurationFields).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const parsed = composioTriggerConfigurationFieldSchema.safeParse(value);

    if (!parsed.success) {
      return null;
    }

    const providerType = parsed.data.type.toLowerCase();
    const type =
      providerType === "boolean"
        ? "boolean"
        : providerType === "integer" || providerType === "number"
          ? "number"
          : providerType === "enum" ||
              parsed.data.options !== undefined ||
              parsed.data.enum !== undefined
            ? "select"
            : providerType === "string"
              ? "string"
              : null;

    if (type === null) {
      return null;
    }

    fields.push({
      description: parsed.data.description ?? null,
      id,
      label:
        parsed.data.display_name ??
        parsed.data.label ??
        parsed.data.title ??
        parsed.data.name ??
        labelFromId(id),
      options: parsed.data.options ?? parsed.data.enum ?? [],
      required: requiredFields.has(id) || (parsed.data.required ?? false),
      type,
    });
  }

  return fields;
}

function normalizeEvent(
  trigger: z.infer<typeof composioTriggerTypeSchema>,
): ComposioWatchableEvent | null {
  const cohort =
    trigger.toolkit.slug === "github"
      ? supportedWatchCohorts.github
      : trigger.toolkit.slug === "gmail"
        ? supportedWatchCohorts.gmail
        : trigger.toolkit.slug === "linear"
          ? supportedWatchCohorts.linear
          : trigger.toolkit.slug === "slack"
            ? supportedWatchCohorts.slack
            : undefined;

  if (cohort === undefined || !cohort(trigger.slug) || trigger.requires_webhook_endpoint_setup) {
    return null;
  }

  const providerType = trigger.type.toLowerCase();
  const delivery =
    providerType === "webhook"
      ? "realtime"
      : providerType === "poll" || providerType === "polling"
        ? "provider_polling"
        : null;
  const configuration = normalizeConfiguration(trigger.config);

  if (delivery === null || configuration === null) {
    return null;
  }

  if (SLACK_CHANNEL_FILTER_SOURCES.has(trigger.slug)) {
    if (configuration.some((field) => field.id === SLACK_CHANNEL_FILTER_ID)) {
      return null;
    }

    configuration.push({
      description: "Only messages from this Slack channel are sent to the Agent.",
      id: SLACK_CHANNEL_FILTER_ID,
      label: "Slack channel",
      options: [],
      required: true,
      type: "string",
    });
  }

  return {
    configuration,
    delivery,
    description: trigger.description ?? null,
    integration: {
      name: trigger.toolkit.name,
      slug: trigger.toolkit.slug,
    },
    name: trigger.name,
    slug: trigger.slug,
    version: trigger.version,
  };
}

export type ComposioProviderTriggerConfigurationResult =
  | { configuration: Record<string, IntegrationToolParameterValue>; ok: true }
  | { ok: false };

export function composioProviderTriggerConfiguration(
  sourceSlug: string,
  configuration: Record<string, IntegrationToolParameterValue>,
): ComposioProviderTriggerConfigurationResult {
  if (!SLACK_CHANNEL_FILTER_SOURCES.has(sourceSlug)) {
    return { configuration, ok: true };
  }

  const expectedChannel = configuration[SLACK_CHANNEL_FILTER_ID];

  if (typeof expectedChannel !== "string" || !/^[A-Z0-9]{1,64}$/u.test(expectedChannel)) {
    return { ok: false };
  }

  const providerConfiguration = { ...configuration };

  delete providerConfiguration[SLACK_CHANNEL_FILTER_ID];

  return { configuration: providerConfiguration, ok: true };
}

export function composioEventMatchesConfiguration(
  sourceSlug: string,
  configuration: Record<string, IntegrationToolParameterValue>,
  data: Record<string, IntegrationToolParameterValue>,
): boolean {
  if (!SLACK_CHANNEL_FILTER_SOURCES.has(sourceSlug)) {
    return true;
  }

  const expectedChannel = configuration[SLACK_CHANNEL_FILTER_ID];
  const deliveredChannel = data.channel;

  return (
    typeof expectedChannel === "string" &&
    /^[A-Z0-9]{1,64}$/u.test(expectedChannel) &&
    typeof deliveredChannel === "string" &&
    deliveredChannel === expectedChannel
  );
}

export function createComposioEventCatalog(
  options: ComposioEventCatalogOptions,
): ComposioEventCatalog {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    async listWatchableEvents(input) {
      const integrationSlug = integrationSlugSchema.safeParse(input.integrationSlug);

      if (!apiKey.success || !integrationSlug.success) {
        return unavailable();
      }

      if (!Object.hasOwn(supportedWatchCohorts, integrationSlug.data)) {
        return { events: [], ok: true };
      }

      try {
        const events = new Map<
          string,
          { event: ComposioWatchableEvent | null; serialized: string | null }
        >();
        const seenCursors = new Set<string>();
        let cursor: string | null = null;

        for (let page = 0; page < MAXIMUM_COMPOSIO_TRIGGER_CATALOG_PAGES; page += 1) {
          const endpoint = new URL(COMPOSIO_TRIGGER_TYPES_URL);
          endpoint.searchParams.set("limit", "50");
          endpoint.searchParams.set("toolkit_slugs", integrationSlug.data);
          endpoint.searchParams.set("toolkit_versions", "latest");

          if (cursor !== null) {
            endpoint.searchParams.set("cursor", cursor);
          }

          const response = await fetchImplementation(endpoint, {
            headers: {
              accept: "application/json",
              "x-api-key": apiKey.data,
            },
            method: "GET",
            redirect: "manual",
            signal:
              options.signal === undefined
                ? AbortSignal.timeout(COMPOSIO_TRIGGER_CATALOG_TIMEOUT_MS)
                : AbortSignal.any([
                    options.signal,
                    AbortSignal.timeout(COMPOSIO_TRIGGER_CATALOG_TIMEOUT_MS),
                  ]),
          });

          if (
            response.status !== 200 ||
            !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
          ) {
            return unavailable();
          }

          const body = await readBoundedJson(response, MAXIMUM_COMPOSIO_TRIGGER_RESPONSE_BYTES);
          if (!body.ok) return unavailable();
          const catalog = composioTriggerCatalogResponseSchema.safeParse(body.value);

          if (
            !catalog.success ||
            catalog.data.items.some((item) => item.toolkit.slug !== integrationSlug.data)
          ) {
            return unavailable();
          }

          for (const item of catalog.data.items) {
            const identity = `${item.slug}@${item.version}`;
            const event = normalizeEvent(item);
            const serialized = event === null ? null : JSON.stringify(event);
            const previous = events.get(identity);

            if (previous !== undefined && previous.serialized !== serialized) {
              return unavailable();
            }

            events.set(identity, { event, serialized });
          }

          cursor = catalog.data.next_cursor ?? null;

          if (cursor !== null && cursor.includes(apiKey.data)) {
            return unavailable();
          }

          if (cursor === null) {
            const result: ComposioWatchableEventCatalogResult = {
              events: [...events.values()]
                .map(({ event }) => event)
                .filter((event): event is ComposioWatchableEvent => event !== null)
                .toSorted((left, right) =>
                  left.name === right.name
                    ? left.slug.localeCompare(right.slug)
                    : left.name.localeCompare(right.name),
                )
                .slice(0, MAXIMUM_COMPOSIO_WATCHABLE_EVENTS),
              ok: true,
            };

            return containsSecret(result, apiKey.data) ? unavailable() : result;
          }

          if (seenCursors.has(cursor)) {
            return unavailable();
          }

          seenCursors.add(cursor);
        }

        return unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
