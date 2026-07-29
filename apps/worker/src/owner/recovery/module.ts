import {
  batchDisableAgentsResultSchema,
  changeAuthorityResultSchema,
  type BatchDisableAgentReceipt,
  type BatchDisableAgentsInput,
  type BatchDisableAgentsResult,
  type ChangeAuthorityInput,
  type ChangeAuthorityResult,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { and, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { recordRecoveryEvent } from "../../observability/recovery.js";
import {
  agents,
  auditEvents,
  capabilityGrants,
  connections,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RecoveryDatabase = Database | Transaction;
type Failure = Extract<ChangeAuthorityResult, { ok: false }>;
type BatchFailure = Extract<BatchDisableAgentsResult, { ok: false }>;
type AgentDisableOutcome = BatchDisableAgentReceipt["outcome"];

export function deniedAuthorityControl(code: Failure["error"]["code"]): Failure {
  return {
    error: {
      code,
      message: "Authority control request denied.",
    },
    ok: false,
  };
}

export function deniedBatchAgentDisable(code: BatchFailure["error"]["code"]): BatchFailure {
  return {
    error: {
      code,
      message: "Batch Agent disable request denied.",
    },
    ok: false,
  };
}

export class AuthorityControls {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  change(authority: OwnerAuthority, input: ChangeAuthorityInput): ChangeAuthorityResult {
    const changedAt = Date.now();
    const result = this.#database.transaction((transaction) => {
      if (input.target === "agent") {
        const outcome = this.#disableAgent(
          transaction,
          authority,
          { agentId: input.agentId },
          changedAt,
        );

        if (outcome === "agent_not_found") {
          return deniedAuthorityControl("agent_not_found");
        }

        return changeAuthorityResultSchema.parse({
          changed: outcome === "disabled",
          ok: true,
          state: { agentId: input.agentId, status: "disabled", target: "agent" },
        });
      }

      if (input.target === "connection") {
        const row = transaction
          .select({ status: connections.status })
          .from(connections)
          .where(eq(connections.connectionId, input.connectionId))
          .get();

        if (row === undefined) {
          return deniedAuthorityControl("connection_not_found");
        }

        const changed =
          row.status !== "revoked" &&
          transaction
            .update(connections)
            .set({ revokedAt: changedAt, status: "revoked" })
            .where(
              and(
                eq(connections.connectionId, input.connectionId),
                eq(connections.status, row.status),
              ),
            )
            .returning({ connectionId: connections.connectionId })
            .all().length === 1;

        if (changed) {
          transaction
            .update(capabilityGrants)
            .set({ revokedAt: changedAt, status: "revoked" })
            .where(
              and(
                eq(capabilityGrants.connectionId, input.connectionId),
                eq(capabilityGrants.status, "active"),
              ),
            )
            .run();
          transaction
            .insert(auditEvents)
            .values({
              action: "connection.revoked",
              clientId: authority.clientId,
              occurredAt: changedAt,
              subjectId: input.connectionId,
            })
            .run();
        }

        return changeAuthorityResultSchema.parse({
          changed,
          ok: true,
          state: { connectionId: input.connectionId, status: "revoked", target: "connection" },
        });
      }

      const row = transaction
        .select({ status: capabilityGrants.status })
        .from(capabilityGrants)
        .where(eq(capabilityGrants.grantId, input.grantId))
        .get();

      if (row === undefined) {
        return deniedAuthorityControl("capability_not_found");
      }

      const changed =
        row.status === "active" &&
        transaction
          .update(capabilityGrants)
          .set({ revokedAt: changedAt, status: "revoked" })
          .where(
            and(eq(capabilityGrants.grantId, input.grantId), eq(capabilityGrants.status, "active")),
          )
          .returning({ grantId: capabilityGrants.grantId })
          .all().length === 1;

      if (changed) {
        transaction
          .insert(auditEvents)
          .values({
            action: "capability.revoked",
            clientId: authority.clientId,
            occurredAt: changedAt,
            subjectId: input.grantId,
          })
          .run();
      }

      return changeAuthorityResultSchema.parse({
        changed,
        ok: true,
        state: { grantId: input.grantId, status: "revoked", target: "capability" },
      });
    });

    if (result.ok) {
      recordRecoveryEvent(
        result.state.target === "agent"
          ? {
              agentId: result.state.agentId,
              operation: "agent.disable",
              outcome: result.changed ? "changed" : "replayed",
            }
          : result.state.target === "connection"
            ? {
                connectionId: result.state.connectionId,
                operation: "connection.revoke",
                outcome: result.changed ? "changed" : "replayed",
              }
            : {
                grantId: result.state.grantId,
                operation: "capability.revoke",
                outcome: result.changed ? "changed" : "replayed",
              },
      );
    }

    return result;
  }

  disableAgents(
    authority: OwnerAuthority,
    input: BatchDisableAgentsInput,
  ): BatchDisableAgentsResult {
    const changedAt = Date.now();
    const result = this.#database.transaction((transaction) =>
      batchDisableAgentsResultSchema.parse({
        ok: true,
        receipts: input.agents.map((agent) => ({
          ...agent,
          outcome: this.#disableAgent(transaction, authority, agent, changedAt),
        })),
      }),
    );

    if (!result.ok) {
      return result;
    }

    for (const receipt of result.receipts) {
      if (receipt.outcome === "disabled" || receipt.outcome === "already_disabled") {
        recordRecoveryEvent({
          agentId: receipt.agentId,
          operation: "agent.disable",
          outcome: receipt.outcome === "disabled" ? "changed" : "replayed",
        });
      }
    }

    return result;
  }

  #disableAgent(
    database: RecoveryDatabase,
    authority: OwnerAuthority,
    input: { agentId: string; expectedRevision?: number },
    changedAt: number,
  ): AgentDisableOutcome {
    const row = database
      .select({
        currentRevision: agents.currentRevision,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.agentId, input.agentId))
      .get();

    if (row === undefined) {
      return "agent_not_found";
    }

    if (input.expectedRevision !== undefined && row.currentRevision !== input.expectedRevision) {
      return "revision_conflict";
    }

    if (row.status === "disabled") {
      return "already_disabled";
    }

    const changed =
      database
        .update(agents)
        .set({ disabledAt: changedAt, status: "disabled" })
        .where(
          and(
            eq(agents.agentId, input.agentId),
            eq(agents.currentRevision, row.currentRevision),
            eq(agents.status, "active"),
          ),
        )
        .returning({ agentId: agents.agentId })
        .all().length === 1;

    if (!changed) {
      return "revision_conflict";
    }

    database
      .insert(auditEvents)
      .values({
        action: "agent.disabled",
        clientId: authority.clientId,
        occurredAt: changedAt,
        subjectId: input.agentId,
      })
      .run();

    return "disabled";
  }
}
