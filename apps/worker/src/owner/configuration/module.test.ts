import {
  AUTONOMY_WRITE_SCOPE,
  DEFAULT_FLEET_INBOX_RETENTION_SECONDS,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
  DEFAULT_FLEET_MAX_AGENTS,
  DEFAULT_FLEET_MAX_CONCURRENT_RUNS,
  DEFAULT_FLEET_MAX_CONNECTIONS,
  DEFAULT_FLEET_RUN_RETENTION_SECONDS,
  OWNER_READ_SCOPE,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { authorityFor } from "../testkit.js";

describe("OwnerControlPlane fleet configuration", () => {
  it("previews and applies a revision-checked partial configuration idempotently", async () => {
    const authority = await authorityFor("fleet-configuration-1", [
      OWNER_READ_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const current = await stub.getFleetConfiguration(authority, {
      target: { kind: "fleet" },
    });

    expect(current).toMatchObject({
      configuration: {
        data: {
          capacity: {
            maxAgents: DEFAULT_FLEET_MAX_AGENTS,
            maxConcurrentRuns: DEFAULT_FLEET_MAX_CONCURRENT_RUNS,
            maxConnections: DEFAULT_FLEET_MAX_CONNECTIONS,
          },
          integrations: { callsPerDay: DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY },
          retention: {
            inboxSeconds: DEFAULT_FLEET_INBOX_RETENTION_SECONDS,
            runSeconds: DEFAULT_FLEET_RUN_RETENTION_SECONDS,
          },
        },
        revision: 1,
      },
      ok: true,
    });
    if (!current.ok) {
      throw new Error("Expected the default fleet configuration.");
    }

    const patch = {
      integrations: {
        duplicateToolCallLimit: 3,
        maxCallsPerRun: 10,
      },
    };
    await expect(
      stub.configureFleetConfiguration(authority, {
        expectedRevision: current.configuration.revision,
        mode: "preview",
        patch,
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({
      applied: false,
      configuration: {
        data: {
          integrations: patch.integrations,
        },
        revision: 2,
      },
      ok: true,
    });
    await expect(
      stub.getFleetConfiguration(authority, { target: { kind: "fleet" } }),
    ).resolves.toMatchObject({ configuration: { revision: 1 }, ok: true });

    const applied = await stub.configureFleetConfiguration(authority, {
      expectedRevision: current.configuration.revision,
      idempotencyKey: "fleet-configuration-apply-1",
      mode: "apply",
      patch,
      target: { kind: "fleet" },
    });

    expect(applied).toMatchObject({
      applied: true,
      configuration: {
        data: {
          integrations: patch.integrations,
        },
        revision: 2,
      },
      ok: true,
    });
    await expect(
      stub.configureFleetConfiguration(authority, {
        expectedRevision: current.configuration.revision,
        idempotencyKey: "fleet-configuration-apply-1",
        mode: "apply",
        patch,
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({
      applied: false,
      configuration: { revision: 2 },
      ok: true,
    });
    await expect(
      stub.configureFleetConfiguration(authority, {
        expectedRevision: 2,
        idempotencyKey: "fleet-configuration-apply-1",
        mode: "apply",
        patch: { integrations: { callsPerDay: 200 } },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
      ok: false,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT action, client_id, subject_id FROM audit_events WHERE action = 'fleet_configuration.updated'",
          )
          .toArray(),
      ),
    ).resolves.toEqual([
      {
        action: "fleet_configuration.updated",
        client_id: authority.clientId,
        subject_id: "fleet_configuration:2",
      },
    ]);
  });

  it("enforces scopes and revision conflicts", async () => {
    const readOnlyAuthority = await authorityFor("fleet-configuration-2", [OWNER_READ_SCOPE]);
    const authority = await authorityFor(
      "fleet-configuration-2",
      [OWNER_READ_SCOPE, AUTONOMY_WRITE_SCOPE],
      readOnlyAuthority.clientId,
    );
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const current = await stub.getFleetConfiguration(authority, {
      target: { kind: "fleet" },
    });

    if (!current.ok) {
      throw new Error("Expected the default fleet configuration.");
    }

    await expect(
      stub.configureFleetConfiguration(readOnlyAuthority, {
        expectedRevision: 1,
        idempotencyKey: "fleet-configuration-no-scope",
        mode: "apply",
        patch: { integrations: { callsPerDay: 200 } },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });
    await expect(
      stub.configureFleetConfiguration(authority, {
        expectedRevision: current.configuration.revision + 1,
        idempotencyKey: "fleet-configuration-stale",
        mode: "apply",
        patch: { integrations: { callsPerDay: 200 } },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({ error: { code: "revision_conflict" }, ok: false });
  });
});
