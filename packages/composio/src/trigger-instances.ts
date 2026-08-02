import {
  composioConnectedAccountIdSchema,
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolParameterMapSchema,
  integrationToolSlugSchema,
  ownerKeySchema,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";
import { isUnknownRecord } from "./safe-values.js";

const COMPOSIO_TRIGGER_INSTANCES_URL = "https://backend.composio.dev/api/v3.1/trigger_instances";
const COMPOSIO_TRIGGER_INSTANCE_TIMEOUT_MS = 5_000;
const MAXIMUM_COMPOSIO_TRIGGER_INSTANCE_RESPONSE_BYTES = 128 * 1_024;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioTriggerInstanceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^ti_[A-Za-z0-9_-]+$/);
const lookupInputSchema = z.strictObject({
  configuration: integrationToolParameterMapSchema,
  providerConnectionId: composioConnectedAccountIdSchema,
  sourceSlug: integrationToolSlugSchema,
  sourceVersion: integrationToolkitVersionSchema,
  ownerKey: ownerKeySchema,
});
const upsertInputSchema = lookupInputSchema.extend({ integrationSlug: integrationSlugSchema });
const manageInputSchema = z.strictObject({
  providerTriggerId: composioTriggerInstanceIdSchema,
});
const setEnabledInputSchema = manageInputSchema.extend({ enabled: z.boolean() });
const upsertResponseSchema = z.looseObject({
  trigger_id: composioTriggerInstanceIdSchema,
});
const activeTriggerSchema = z.looseObject({
  connected_account_id: composioConnectedAccountIdSchema,
  id: composioTriggerInstanceIdSchema,
  trigger_config: integrationToolParameterMapSchema,
  trigger_name: integrationToolSlugSchema,
  user_id: ownerKeySchema,
  version: integrationToolkitVersionSchema,
});
const activeTriggerListSchema = z.looseObject({
  items: z.array(activeTriggerSchema).max(2),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});
const manageResponseSchema = z.looseObject({
  status: z.literal("success"),
});
const deleteResponseSchema = z.looseObject({
  trigger_id: composioTriggerInstanceIdSchema,
});

export type ComposioTriggerInstanceResult =
  | { ok: true; providerTriggerId: string }
  | {
      error: {
        code: "trigger_operation_unknown" | "trigger_unavailable";
        message: "Integration trigger request denied.";
      };
      ok: false;
    };

export type ComposioTriggerManageResult =
  | { ok: true }
  | {
      error: {
        code: "trigger_operation_unknown" | "trigger_unavailable";
        message: "Integration trigger request denied.";
      };
      ok: false;
    };

export type ComposioTriggerLookupResult =
  | { ok: true; providerTriggerId: string | null }
  | {
      error: {
        code: "trigger_operation_unknown" | "trigger_unavailable";
        message: "Integration trigger request denied.";
      };
      ok: false;
    };

export interface ComposioTriggerInstances {
  delete(input: { providerTriggerId: string }): Promise<ComposioTriggerManageResult>;
  find(input: {
    configuration: Record<string, unknown>;
    ownerKey: string;
    providerConnectionId: string;
    sourceSlug: string;
    sourceVersion: string;
  }): Promise<ComposioTriggerLookupResult>;
  setEnabled(input: {
    enabled: boolean;
    providerTriggerId: string;
  }): Promise<ComposioTriggerManageResult>;
  upsert(input: {
    configuration: Record<string, unknown>;
    integrationSlug: string;
    ownerKey: string;
    providerConnectionId: string;
    sourceSlug: string;
    sourceVersion: string;
  }): Promise<ComposioTriggerInstanceResult>;
}

export interface ComposioTriggerInstancesOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

function denied(
  code: "trigger_operation_unknown" | "trigger_unavailable",
): Extract<ComposioTriggerInstanceResult, { ok: false }> {
  return { error: { code, message: "Integration trigger request denied." }, ok: false };
}

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
      pending.push(...Object.keys(current), ...Object.values(current));
    }
  }

  return false;
}

function canonicalUnknownJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalUnknownJson).join(",")}]`;
  }

  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalUnknownJson(nested)}`)
      .join(",")}}`;
  }

  throw new TypeError("Expected canonical JSON data.");
}

export function createComposioTriggerInstances(
  options: ComposioTriggerInstancesOptions,
): ComposioTriggerInstances {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  async function providerRequest(
    endpoint: URL,
    method: "DELETE" | "GET" | "PATCH" | "POST",
    body?: Record<string, unknown>,
  ): Promise<Response> {
    if (!apiKey.success) {
      throw new Error("Composio trigger instances are unavailable.");
    }

    return fetchImplementation(endpoint, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-api-key": apiKey.data,
      },
      method,
      redirect: "manual",
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(COMPOSIO_TRIGGER_INSTANCE_TIMEOUT_MS)
          : AbortSignal.any([
              options.signal,
              AbortSignal.timeout(COMPOSIO_TRIGGER_INSTANCE_TIMEOUT_MS),
            ]),
    });
  }

  async function findExactActiveTrigger(
    request: z.infer<typeof lookupInputSchema>,
  ): Promise<ComposioTriggerLookupResult> {
    if (!apiKey.success) {
      return denied("trigger_unavailable");
    }

    try {
      const endpoint = new URL(`${COMPOSIO_TRIGGER_INSTANCES_URL}/active`);
      endpoint.searchParams.append("connected_account_ids", request.providerConnectionId);
      endpoint.searchParams.set("limit", "2");
      endpoint.searchParams.append("trigger_names", request.sourceSlug);
      endpoint.searchParams.append("user_ids", request.ownerKey);
      const response = await providerRequest(endpoint, "GET");

      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        return denied("trigger_operation_unknown");
      }

      const body = await readBoundedJson(
        response,
        MAXIMUM_COMPOSIO_TRIGGER_INSTANCE_RESPONSE_BYTES,
      );
      if (!body.ok) return denied("trigger_operation_unknown");
      const parsed = activeTriggerListSchema.safeParse(body.value);
      const exact = parsed.success
        ? parsed.data.items.filter(
            (item) =>
              item.connected_account_id === request.providerConnectionId &&
              item.trigger_name === request.sourceSlug &&
              item.user_id === request.ownerKey &&
              item.version === request.sourceVersion &&
              canonicalUnknownJson(item.trigger_config) ===
                canonicalUnknownJson(request.configuration),
          )
        : [];

      return !parsed.success ||
        parsed.data.next_cursor != null ||
        exact.length > 1 ||
        containsSecret(parsed.data, apiKey.data)
        ? denied("trigger_operation_unknown")
        : { ok: true, providerTriggerId: exact[0]?.id ?? null };
    } catch {
      return denied("trigger_operation_unknown");
    }
  }

  return {
    async find(input) {
      const request = lookupInputSchema.safeParse(input);

      return !apiKey.success || !request.success
        ? denied("trigger_unavailable")
        : findExactActiveTrigger(request.data);
    },

    async upsert(input) {
      const request = upsertInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return denied("trigger_unavailable");
      }

      try {
        const response = await providerRequest(
          new URL(
            `${COMPOSIO_TRIGGER_INSTANCES_URL}/${encodeURIComponent(request.data.sourceSlug)}/upsert`,
          ),
          "POST",
          {
            connected_account_id: request.data.providerConnectionId,
            toolkit_versions: {
              [request.data.integrationSlug]: request.data.sourceVersion,
            },
            trigger_config: request.data.configuration,
            user_id: request.data.ownerKey,
          },
        );

        if (response.status === 204) {
          const reconciled = await findExactActiveTrigger(request.data);

          return !reconciled.ok || reconciled.providerTriggerId === null
            ? denied("trigger_operation_unknown")
            : { ok: true, providerTriggerId: reconciled.providerTriggerId };
        }

        if (
          ![200, 201].includes(response.status) ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          return denied("trigger_operation_unknown");
        }

        const body = await readBoundedJson(
          response,
          MAXIMUM_COMPOSIO_TRIGGER_INSTANCE_RESPONSE_BYTES,
        );
        if (!body.ok) return denied("trigger_operation_unknown");
        const parsed = upsertResponseSchema.safeParse(body.value);

        return !parsed.success || containsSecret(parsed.data, apiKey.data)
          ? denied("trigger_operation_unknown")
          : { ok: true, providerTriggerId: parsed.data.trigger_id };
      } catch {
        return denied("trigger_operation_unknown");
      }
    },

    async setEnabled(input) {
      const request = setEnabledInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return denied("trigger_unavailable");
      }

      try {
        const response = await providerRequest(
          new URL(
            `${COMPOSIO_TRIGGER_INSTANCES_URL}/manage/${encodeURIComponent(request.data.providerTriggerId)}`,
          ),
          "PATCH",
          { status: request.data.enabled ? "enable" : "disable" },
        );

        if (
          response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          return denied("trigger_operation_unknown");
        }

        const body = await readBoundedJson(
          response,
          MAXIMUM_COMPOSIO_TRIGGER_INSTANCE_RESPONSE_BYTES,
        );
        if (!body.ok) return denied("trigger_operation_unknown");
        const parsed = manageResponseSchema.safeParse(body.value);

        return !parsed.success || containsSecret(parsed.data, apiKey.data)
          ? denied("trigger_operation_unknown")
          : { ok: true };
      } catch {
        return denied("trigger_operation_unknown");
      }
    },

    async delete(input) {
      const request = manageInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return denied("trigger_unavailable");
      }

      try {
        const response = await providerRequest(
          new URL(
            `${COMPOSIO_TRIGGER_INSTANCES_URL}/manage/${encodeURIComponent(request.data.providerTriggerId)}`,
          ),
          "DELETE",
        );

        if (response.status === 404 || response.status === 410) {
          return { ok: true };
        }

        if (
          response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          return denied("trigger_operation_unknown");
        }

        const body = await readBoundedJson(
          response,
          MAXIMUM_COMPOSIO_TRIGGER_INSTANCE_RESPONSE_BYTES,
        );
        if (!body.ok) return denied("trigger_operation_unknown");
        const parsed = deleteResponseSchema.safeParse(body.value);

        return !parsed.success ||
          parsed.data.trigger_id !== request.data.providerTriggerId ||
          containsSecret(parsed.data, apiKey.data)
          ? denied("trigger_operation_unknown")
          : { ok: true };
      } catch {
        return denied("trigger_operation_unknown");
      }
    },
  };
}
