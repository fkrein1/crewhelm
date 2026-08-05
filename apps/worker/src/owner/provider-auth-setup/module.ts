import {
  MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER,
  MAXIMUM_PROVIDER_AUTH_SETUP_REQUESTS_PER_OWNER,
  CONNECTIONS_WRITE_SCOPE,
  PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS,
  PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS,
  PROVIDER_AUTH_SETUP_UNKNOWN_RECOVERY_MS,
  completeProviderAuthSetupInputSchema,
  exchangeProviderAuthSetupInputSchema,
  prepareProviderAuthSetupInputSchema,
  prepareProviderAuthSetupResultSchema,
  providerAuthSetupAuthorityResultSchema,
  providerAuthSetupMutationResultSchema,
  providerAuthSetupPlanResultSchema,
  providerAuthSetupSessionInputSchema,
  rejectProviderAuthSetupInputSchema,
  reconcileProviderAuthSetupInputSchema,
  type OwnerAuthority,
  type PrepareProviderAuthSetupResult,
  type ProviderAuthSetupAuthorityResult,
  type ProviderAuthSetupMutationResult,
  type ProviderAuthSetupPlan,
  type ProviderAuthSetupPlanResult,
} from "@crewhelm/contracts";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  auditEvents,
  integrationEnablementRequests,
  providerAuthConfigs,
  providerAuthSetupRequests,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;

const denied = { error: "provider_auth_setup_denied", ok: false } as const;

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

function stablePlan(plan: ProviderAuthSetupPlan): string {
  return JSON.stringify({
    authorizeConnection: plan.authorizeConnection,
    authScheme: plan.authScheme,
    callbackUrl: plan.callbackUrl ?? null,
    documentationUrl: plan.documentationUrl ?? null,
    fieldSchemaDigest: plan.fieldSchemaDigest,
    fields: plan.fields,
    integrationName: plan.integrationName,
    integrationSlug: plan.integrationSlug,
    support: plan.support,
  });
}

export class ProviderAuthSetups {
  readonly #database: Database;
  readonly #ownerKey: string | undefined;

  constructor(ownerKey: string | undefined, database: Database) {
    this.#database = database;
    this.#ownerKey = ownerKey;
  }

  async prepare(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<PrepareProviderAuthSetupResult> {
    const request = prepareProviderAuthSetupInputSchema.safeParse(input);
    if (!request.success) {
      return prepareProviderAuthSetupResultSchema.parse({
        error: {
          code: "invalid_request",
          message: "Provider authentication setup request denied.",
        },
        ok: false,
      });
    }
    if (
      request.data.plan.authorizeConnection &&
      !authority.scopes.includes(CONNECTIONS_WRITE_SCOPE)
    ) {
      return prepareProviderAuthSetupResultSchema.parse({
        error: {
          code: "insufficient_scope",
          message: "Provider authentication setup request denied.",
        },
        ok: false,
      });
    }
    if (
      request.data.plan.support === "unsupported" &&
      (request.data.plan.fields.length !== 0 ||
        request.data.plan.callbackUrl !== undefined ||
        request.data.plan.documentationUrl !== undefined)
    ) {
      return prepareProviderAuthSetupResultSchema.parse({
        error: {
          code: "invalid_request",
          message: "Provider authentication setup request denied.",
        },
        ok: false,
      });
    }

    const now = Date.now();
    if (
      request.data.capabilityExpiresAt <= now ||
      request.data.capabilityExpiresAt > now + PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS ||
      request.data.setupExpiresAt < request.data.capabilityExpiresAt ||
      request.data.setupExpiresAt > now + PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS
    ) {
      return prepareProviderAuthSetupResultSchema.parse({
        error: {
          code: "invalid_request",
          message: "Provider authentication setup request denied.",
        },
        ok: false,
      });
    }

    const requestDigest = await digest(stablePlan(request.data.plan));
    return this.#database.transaction((transaction) => {
      transaction
        .delete(providerAuthSetupRequests)
        .where(sql`(
          ${providerAuthSetupRequests.status} IN ('prepared', 'exchanged', 'rejected')
          AND ${providerAuthSetupRequests.setupExpiresAt} <= ${now}
        ) OR (
          ${providerAuthSetupRequests.status} = 'configured'
          AND ${providerAuthSetupRequests.sessionExpiresAt} <= ${now}
        )`)
        .run();
      const existing = transaction
        .select()
        .from(providerAuthSetupRequests)
        .where(
          and(
            eq(providerAuthSetupRequests.clientId, authority.clientId),
            eq(providerAuthSetupRequests.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .get();

      if (existing !== undefined) {
        return prepareProviderAuthSetupResultSchema.parse(
          existing.requestDigest === requestDigest
            ? {
                capabilityExpiresAt: existing.capabilityExpiresAt,
                ok: true,
                setupExpiresAt: existing.setupExpiresAt,
                setupId: existing.setupId,
                state: "replay",
              }
            : {
                error: {
                  code: "idempotency_conflict",
                  message: "Provider authentication setup request denied.",
                },
                ok: false,
              },
        );
      }

      const setupCount =
        transaction.select({ value: count() }).from(providerAuthSetupRequests).get()?.value ?? 0;
      if (setupCount >= MAXIMUM_PROVIDER_AUTH_SETUP_REQUESTS_PER_OWNER) {
        return prepareProviderAuthSetupResultSchema.parse({
          error: {
            code: "provider_auth_setup_limit_exceeded",
            message: "Provider authentication setup request denied.",
          },
          ok: false,
        });
      }

      transaction
        .insert(providerAuthSetupRequests)
        .values({
          capabilityDigest: request.data.capabilityDigest,
          capabilityExpiresAt: request.data.capabilityExpiresAt,
          clientId: authority.clientId,
          createdAt: now,
          idempotencyKey: request.data.idempotencyKey,
          plan: request.data.plan,
          requestDigest,
          setupExpiresAt: request.data.setupExpiresAt,
          setupId: request.data.plan.setupId,
          status: "prepared",
          updatedAt: now,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "integration.auth_setup_prepared",
          clientId: authority.clientId,
          occurredAt: now,
          subjectId: request.data.plan.setupId,
        })
        .run();

      return prepareProviderAuthSetupResultSchema.parse({
        capabilityExpiresAt: request.data.capabilityExpiresAt,
        ok: true,
        setupExpiresAt: request.data.setupExpiresAt,
        setupId: request.data.plan.setupId,
        state: "prepared",
      });
    });
  }

  exchange(input: unknown): ProviderAuthSetupPlanResult {
    const request = exchangeProviderAuthSetupInputSchema.safeParse(input);
    if (!request.success) return denied;
    const now = Date.now();

    return this.#database.transaction((transaction) => {
      const row = transaction
        .select()
        .from(providerAuthSetupRequests)
        .where(eq(providerAuthSetupRequests.setupId, request.data.setupId))
        .get();
      if (
        row === undefined ||
        row.status !== "prepared" ||
        row.capabilityDigest !== request.data.capabilityDigest ||
        now >= row.capabilityExpiresAt ||
        now >= row.setupExpiresAt
      ) {
        return denied;
      }

      const sessionExpiresAt = row.setupExpiresAt + 2 * PROVIDER_AUTH_SETUP_UNKNOWN_RECOVERY_MS;
      transaction
        .update(providerAuthSetupRequests)
        .set({
          sessionDigest: request.data.sessionDigest,
          sessionExpiresAt,
          status: "exchanged",
          updatedAt: now,
        })
        .where(eq(providerAuthSetupRequests.setupId, row.setupId))
        .run();

      return providerAuthSetupPlanResultSchema.parse({
        ok: true,
        plan: row.plan,
        sessionExpiresAt,
        status: "exchanged",
      });
    });
  }

  read(input: unknown): ProviderAuthSetupPlanResult {
    const request = providerAuthSetupSessionInputSchema.safeParse(input);
    if (!request.success) return denied;
    const row = this.#sessionRow(request.data, Date.now());
    if (
      row === undefined ||
      row.status === "prepared" ||
      (row.status === "exchanged" && row.setupExpiresAt <= Date.now())
    ) {
      return denied;
    }

    return providerAuthSetupPlanResultSchema.parse({
      ...(row.authConfigId === null ? {} : { authConfigId: row.authConfigId }),
      ok: true,
      plan: row.plan,
      ...(row.recoverAfter === null ? {} : { recoverAfter: row.recoverAfter }),
      sessionExpiresAt: row.sessionExpiresAt,
      status: row.status === "submitting" ? "outcome_unknown" : row.status,
    });
  }

  reserveConfiguration(input: unknown): ProviderAuthSetupPlanResult {
    const request = providerAuthSetupSessionInputSchema.safeParse(input);
    if (!request.success) return denied;
    const now = Date.now();

    return this.#database.transaction((transaction) => {
      const row = this.#sessionRow(request.data, now);
      if (row?.status !== "exchanged" || row.setupExpiresAt <= now) return denied;
      const configCount =
        transaction.select({ value: count() }).from(providerAuthConfigs).get()?.value ?? 0;
      const reservedCount =
        transaction
          .select({ value: count() })
          .from(providerAuthSetupRequests)
          .where(inArray(providerAuthSetupRequests.status, ["submitting", "outcome_unknown"]))
          .get()?.value ?? 0;
      const managedReservedCount =
        transaction
          .select({ value: count() })
          .from(integrationEnablementRequests)
          .where(eq(integrationEnablementRequests.status, "pending"))
          .get()?.value ?? 0;
      if (
        configCount + reservedCount + managedReservedCount >=
        MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER
      ) {
        return denied;
      }
      transaction
        .update(providerAuthSetupRequests)
        .set({
          recoverAfter: now + PROVIDER_AUTH_SETUP_UNKNOWN_RECOVERY_MS,
          status: "submitting",
          updatedAt: now,
        })
        .where(eq(providerAuthSetupRequests.setupId, row.setupId))
        .run();
      return providerAuthSetupPlanResultSchema.parse({
        ok: true,
        plan: row.plan,
        sessionExpiresAt: row.sessionExpiresAt,
        status: "exchanged",
      });
    });
  }

  complete(input: unknown): ProviderAuthSetupMutationResult {
    const request = completeProviderAuthSetupInputSchema.safeParse(input);
    if (!request.success) return denied;
    const now = Date.now();

    return this.#database.transaction((transaction) => {
      const row = this.#sessionRow(request.data, now);
      if (
        (row?.status !== "submitting" &&
          !(
            row?.status === "outcome_unknown" &&
            row.recoverAfter !== null &&
            row.recoverAfter <= now
          )) ||
        request.data.authConfig.integrationSlug !== row.plan.integrationSlug ||
        request.data.authConfig.authScheme !== row.plan.authScheme ||
        request.data.authConfig.source !== "crewhelm_custom"
      ) {
        return denied;
      }

      const existing = transaction
        .select()
        .from(providerAuthConfigs)
        .where(eq(providerAuthConfigs.authConfigId, request.data.authConfig.authConfigId))
        .get();
      if (
        existing !== undefined &&
        (existing.integrationSlug !== request.data.authConfig.integrationSlug ||
          existing.authScheme !== request.data.authConfig.authScheme ||
          existing.source !== request.data.authConfig.source)
      ) {
        return denied;
      }
      const configCount =
        transaction.select({ value: count() }).from(providerAuthConfigs).get()?.value ?? 0;
      if (existing === undefined && configCount >= MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER) {
        return denied;
      }

      transaction
        .insert(providerAuthConfigs)
        .values({
          authConfigId: request.data.authConfig.authConfigId,
          authScheme: request.data.authConfig.authScheme,
          createdAt: now,
          displayName: request.data.authConfig.name,
          integrationSlug: request.data.authConfig.integrationSlug,
          source: request.data.authConfig.source,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          set: { displayName: request.data.authConfig.name, updatedAt: now },
          target: providerAuthConfigs.authConfigId,
        })
        .run();
      transaction
        .update(providerAuthSetupRequests)
        .set({
          authConfigId: request.data.authConfig.authConfigId,
          recoverAfter: null,
          status: "configured",
          updatedAt: now,
        })
        .where(eq(providerAuthSetupRequests.setupId, row.setupId))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "integration.auth_setup_completed",
          clientId: row.clientId,
          occurredAt: now,
          subjectId: request.data.authConfig.authConfigId,
        })
        .run();

      return providerAuthSetupMutationResultSchema.parse({
        authConfigId: request.data.authConfig.authConfigId,
        ok: true,
      });
    });
  }

  reject(input: unknown): ProviderAuthSetupMutationResult {
    const request = rejectProviderAuthSetupInputSchema.safeParse(input);
    if (!request.success) return denied;
    const now = Date.now();
    const row = this.#sessionRow(request.data, now);
    if (row?.status !== "submitting") return denied;

    this.#database
      .update(providerAuthSetupRequests)
      .set({
        recoverAfter: request.data.outcome === "credentials_rejected" ? null : row.recoverAfter,
        status: request.data.outcome === "credentials_rejected" ? "rejected" : "outcome_unknown",
        updatedAt: now,
      })
      .where(eq(providerAuthSetupRequests.setupId, row.setupId))
      .run();
    return providerAuthSetupMutationResultSchema.parse({ ok: true });
  }

  reconcile(input: unknown): ProviderAuthSetupMutationResult {
    const request = reconcileProviderAuthSetupInputSchema.safeParse(input);
    if (!request.success) return denied;
    const now = Date.now();
    const row = this.#sessionRow(request.data, now);
    if (
      (row?.status !== "submitting" && row?.status !== "outcome_unknown") ||
      row.recoverAfter === null ||
      row.recoverAfter > now
    ) {
      return denied;
    }

    this.#database
      .update(providerAuthSetupRequests)
      .set({
        recoverAfter:
          request.data.outcome === "absent" ? null : now + PROVIDER_AUTH_SETUP_UNKNOWN_RECOVERY_MS,
        status: request.data.outcome === "absent" ? "rejected" : "outcome_unknown",
        updatedAt: now,
      })
      .where(eq(providerAuthSetupRequests.setupId, row.setupId))
      .run();
    return providerAuthSetupMutationResultSchema.parse({ ok: true });
  }

  authority(input: unknown): ProviderAuthSetupAuthorityResult {
    const request = providerAuthSetupSessionInputSchema.safeParse(input);
    if (!request.success || this.#ownerKey === undefined) return denied;
    const row = this.#sessionRow(request.data, Date.now());
    if (
      row?.status !== "configured" ||
      row.authConfigId === null ||
      !row.plan.authorizeConnection
    ) {
      return denied;
    }

    return providerAuthSetupAuthorityResultSchema.parse({
      authConfigId: row.authConfigId,
      clientId: row.clientId,
      ok: true,
      ownerKey: this.#ownerKey,
    });
  }

  #sessionRow(input: { sessionDigest: string; setupId: string }, now: number) {
    const row = this.#database
      .select()
      .from(providerAuthSetupRequests)
      .where(
        and(
          eq(providerAuthSetupRequests.setupId, input.setupId),
          eq(providerAuthSetupRequests.sessionDigest, input.sessionDigest),
        ),
      )
      .get();
    return row !== undefined && row.sessionExpiresAt !== null && row.sessionExpiresAt > now
      ? row
      : undefined;
  }
}
