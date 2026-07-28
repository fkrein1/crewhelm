import {
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  OWNER_READ_SCOPE,
  listConnectionsResultSchema,
  recordConnectionAuthorizationReturnResultSchema,
} from "@crewhelm/contracts";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  authorityFor,
  connectionLinkInput,
  fixedConnectionAuthorizationReturnFailure,
  fixedConnectionLinkFailure,
  fixedConnectionReadFailure,
} from "../testkit.js";

describe("OwnerControlPlane connections", () => {
  it("reserves, completes, replays, and audits integration enablement", async () => {
    const authority = await authorityFor("111-enable", [CONNECTION_CONFIGS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = {
      idempotencyKey: "enable-github-111",
      integrationSlug: "github",
    };
    const reservation = await stub.reserveIntegrationEnablement(authority, input);

    expect(reservation).toMatchObject({ ok: true, state: "dispatch" });
    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected integration enablement dispatch reservation.");
    }

    const completion = {
      authConfigId: "ac_github_managed",
      authScheme: "oauth2",
      created: true,
      integrationSlug: "github",
      managed: true,
      reservationId: reservation.reservationId,
    };

    await expect(stub.completeIntegrationEnablement(authority, completion)).resolves.toEqual({
      authConfigId: completion.authConfigId,
      authScheme: completion.authScheme,
      created: true,
      integrationSlug: "github",
      managed: true,
      ok: true,
    });
    await expect(stub.completeIntegrationEnablement(authority, completion)).resolves.toMatchObject({
      created: false,
      ok: true,
    });
    await expect(stub.reserveIntegrationEnablement(authority, input)).resolves.toMatchObject({
      authConfigId: completion.authConfigId,
      ok: true,
      state: "replay",
    });
    await expect(
      stub.reserveIntegrationEnablement(authority, {
        ...input,
        integrationSlug: "slack",
      }),
    ).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
      ok: false,
    });

    const stored = await runInDurableObject(stub, (_instance, state) => ({
      audit: state.storage.sql
        .exec("SELECT action, subject_id FROM audit_events ORDER BY event_id")
        .toArray(),
      requests: state.storage.sql
        .exec(
          `SELECT client_id, integration_slug, auth_config_id, auth_scheme, status
           FROM integration_enablement_requests`,
        )
        .toArray(),
    }));

    expect(stored.audit).toEqual([
      {
        action: "integration.enablement_reserved",
        subject_id: reservation.reservationId,
      },
      {
        action: "integration.enabled",
        subject_id: completion.authConfigId,
      },
    ]);
    expect(stored.requests).toEqual([
      {
        auth_config_id: completion.authConfigId,
        auth_scheme: completion.authScheme,
        client_id: authority.clientId,
        integration_slug: "github",
        status: "completed",
      },
    ]);
  });

  it("reserves, completes, replays, audits, and survives eviction without credentials", async () => {
    const authority = await authorityFor("112", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = connectionLinkInput("connection-link-112");
    const reservation = await stub.reserveConnectionLink(authority, input);

    expect(reservation).toMatchObject({ ok: true, state: "dispatch" });
    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected connection-link dispatch reservation.");
    }

    const completion = {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId: "ca_owner_112",
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_owner_112",
    };
    const created = await stub.completeConnectionLink(authority, completion);

    expect(created).toMatchObject({
      connectionLink: {
        connectionId: expect.stringMatching(/^connection_/),
        expiresAt: completion.expiresAt,
        url: completion.url,
      },
      created: true,
      ok: true,
    });
    await expect(stub.completeConnectionLink(authority, completion)).resolves.toMatchObject({
      connectionLink: created.ok ? created.connectionLink : {},
      created: false,
      ok: true,
    });
    await expect(stub.reserveConnectionLink(authority, input)).resolves.toMatchObject({
      connectionLink: created.ok ? created.connectionLink : {},
      ok: true,
      state: "replay",
    });

    const stored = await runInDurableObject(stub, (_instance, state) => ({
      audit: state.storage.sql
        .exec("SELECT action, subject_id FROM audit_events ORDER BY event_id")
        .toArray(),
      connections: state.storage.sql
        .exec(
          `SELECT connection_id, provider, provider_connection_id, auth_config_id, status
           FROM connections`,
        )
        .toArray(),
      requests: state.storage.sql
        .exec(
          `SELECT client_id, idempotency_key, request_digest, auth_config_id, status
           FROM connection_link_requests`,
        )
        .toArray(),
    }));
    const serialized = JSON.stringify(stored);

    expect(stored.audit).toEqual([
      {
        action: "connection.link_reserved",
        subject_id: reservation.reservationId,
      },
      {
        action: "connection.link_created",
        subject_id: created.ok ? created.connectionLink.connectionId : "",
      },
    ]);
    expect(stored.connections).toEqual([
      {
        auth_config_id: input.authConfigId,
        connection_id: created.ok ? created.connectionLink.connectionId : "",
        provider: "composio",
        provider_connection_id: completion.providerConnectionId,
        status: "initiated",
      },
    ]);
    expect(stored.requests).toMatchObject([
      {
        auth_config_id: input.authConfigId,
        client_id: authority.clientId,
        idempotency_key: input.idempotencyKey,
        request_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        status: "completed",
      },
    ]);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("api_key");

    await evictDurableObject(stub);
    await expect(stub.reserveConnectionLink(authority, input)).resolves.toMatchObject({
      connectionLink: created.ok ? created.connectionLink : {},
      ok: true,
      state: "replay",
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          "UPDATE connection_link_requests SET expires_at = 1 WHERE idempotency_key = ?",
          input.idempotencyKey,
        );
        state.storage.sql.exec(
          "UPDATE connection_authorization_returns SET expires_at = 1 WHERE reservation_id = ?",
          reservation.reservationId,
        );
      });
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               r.status,
               r.redirect_url,
               a.status AS authorization_status
             FROM connection_link_requests r
             JOIN connection_authorization_returns a
               ON a.reservation_id = r.reservation_id
             WHERE r.idempotency_key = ?`,
            input.idempotencyKey,
          )
          .one(),
      ),
    ).resolves.toEqual({
      authorization_status: "expired",
      redirect_url: null,
      status: "expired",
    });
    await expect(stub.completeConnectionLink(authority, completion)).resolves.toEqual(
      fixedConnectionLinkFailure("connection_link_expired"),
    );
  });

  it("records an exact connection authorization return once without claiming activation", async () => {
    const authority = await authorityFor("126", [CONNECTIONS_READ_SCOPE, CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("authorization-return-126"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected connection authorization return reservation.");
    }

    const providerConnectionId = "ca_authorization_return_126";
    const completion = await stub.completeConnectionLink(authority, {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId,
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_authorization_return_126",
    });

    if (!completion.ok) {
      throw new Error("Expected connection authorization return completion.");
    }

    await expect(stub.listConnections(authority, {})).resolves.toMatchObject({
      connections: [{ authorizationOutcome: "pending", status: "initiated" }],
      ok: true,
    });
    const input = {
      authorizationToken: reservation.authorizationToken,
      providerConnectionId,
      reservationId: reservation.reservationId,
      status: "success",
    };

    expect(
      recordConnectionAuthorizationReturnResultSchema.parse(
        await stub.recordConnectionAuthorizationReturn(input),
      ),
    ).toEqual({ ok: true, outcome: "returned", recorded: true });
    await evictDurableObject(stub);
    await expect(stub.recordConnectionAuthorizationReturn(input)).resolves.toEqual({
      ok: true,
      outcome: "returned",
      recorded: false,
    });
    await expect(
      stub.recordConnectionAuthorizationReturn({ ...input, status: "failed" }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(stub.listConnections(authority, {})).resolves.toEqual({
      connections: [
        {
          authorizationOutcome: "returned",
          authConfigId: "ac_github_managed",
          connectionId: completion.connectionLink.connectionId,
          createdAt: expect.any(String),
          status: "initiated",
        },
      ],
      nextCursor: null,
      ok: true,
    });

    const stored = await runInDurableObject(stub, (_instance, state) => ({
      audit: state.storage.sql
        .exec("SELECT action, subject_id FROM audit_events ORDER BY event_id")
        .toArray(),
      authorizationReturns: state.storage.sql
        .exec(
          `SELECT reservation_id, token_digest, status, connection_id, completed_at
           FROM connection_authorization_returns`,
        )
        .toArray(),
    }));

    expect(stored.audit).toEqual([
      {
        action: "connection.link_reserved",
        subject_id: reservation.reservationId,
      },
      {
        action: "connection.link_created",
        subject_id: completion.connectionLink.connectionId,
      },
      {
        action: "connection.authorization_returned",
        subject_id: completion.connectionLink.connectionId,
      },
    ]);
    expect(stored.authorizationReturns).toEqual([
      {
        completed_at: expect.any(Number),
        connection_id: completion.connectionLink.connectionId,
        reservation_id: reservation.reservationId,
        status: "returned",
        token_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(reservation.authorizationToken);
  });

  it("denies malformed, cross-owner, substituted, and expired authorization returns", async () => {
    const authority = await authorityFor("127", [CONNECTIONS_WRITE_SCOPE]);
    const other = await authorityFor("128", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("authorization-return-127"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected denied authorization return reservation.");
    }

    await stub.completeConnectionLink(authority, {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId: "ca_authorization_return_127",
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_authorization_return_127",
    });
    const input = {
      authorizationToken: reservation.authorizationToken,
      providerConnectionId: "ca_authorization_return_127",
      reservationId: reservation.reservationId,
      status: "success",
    };

    await expect(
      env.OWNER_CONTROL_PLANE.getByName(other.ownerKey).recordConnectionAuthorizationReturn(input),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(
      stub.recordConnectionAuthorizationReturn({
        ...input,
        authorizationToken: "a".repeat(43),
      }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(
      stub.recordConnectionAuthorizationReturn({
        ...input,
        providerConnectionId: "ca_substituted_127",
      }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(
      stub.recordConnectionAuthorizationReturn({ ...input, credential: "must-not-reflect" }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE connection_authorization_returns SET expires_at = 1 WHERE reservation_id = ?",
        reservation.reservationId,
      );
    });
    await expect(stub.recordConnectionAuthorizationReturn(input)).resolves.toEqual(
      fixedConnectionAuthorizationReturnFailure(),
    );
  });

  it("rolls back an authorization return when audit persistence fails", async () => {
    const authority = await authorityFor("130", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("authorization-return-rollback-130"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected an authorization-return rollback reservation.");
    }

    await stub.completeConnectionLink(authority, {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId: "ca_authorization_return_rollback_130",
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_authorization_return_rollback_130",
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_connection_authorization_return_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'connection.authorization_returned'
        BEGIN
          SELECT RAISE(ABORT, 'forced authorization-return audit failure');
        END
      `);
    });
    const input = {
      authorizationToken: reservation.authorizationToken,
      providerConnectionId: "ca_authorization_return_rollback_130",
      reservationId: reservation.reservationId,
      status: "success",
    };

    await expect(
      runInDurableObject(stub, (instance) => instance.recordConnectionAuthorizationReturn(input)),
    ).rejects.toThrow("forced authorization-return audit failure");
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        audit: state.storage.sql
          .exec("SELECT action FROM audit_events ORDER BY event_id")
          .toArray(),
        authorizationReturn: state.storage.sql
          .exec(
            `SELECT status, completed_at
             FROM connection_authorization_returns
             WHERE reservation_id = ?`,
            reservation.reservationId,
          )
          .one(),
      })),
    ).resolves.toEqual({
      audit: [{ action: "connection.link_reserved" }, { action: "connection.link_created" }],
      authorizationReturn: {
        completed_at: null,
        status: "pending",
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER reject_connection_authorization_return_audit");
    });
    await expect(stub.recordConnectionAuthorizationReturn(input)).resolves.toEqual({
      ok: true,
      outcome: "returned",
      recorded: true,
    });
  });

  it("lists only bounded owner connection summaries across pagination and eviction", async () => {
    const authority = await authorityFor("122", [CONNECTIONS_READ_SCOPE]);
    const other = await authorityFor("123", [CONNECTIONS_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
        VALUES
          ('connection_00000000-0000-4000-8000-000000000001',
           'composio', 'ca_private_1', 'ac_github_managed', 'initiated', 1),
          ('connection_00000000-0000-4000-8000-000000000002',
           'composio', 'ca_private_2', 'ac_slack_managed', 'initiated', 2)
      `);
    });

    const firstPage = listConnectionsResultSchema.parse(
      await stub.listConnections(authority, { limit: 1 }),
    );

    expect(firstPage).toEqual({
      connections: [
        {
          authorizationOutcome: "untracked",
          authConfigId: "ac_github_managed",
          connectionId: "connection_00000000-0000-4000-8000-000000000001",
          createdAt: "1970-01-01T00:00:00.001Z",
          status: "initiated",
        },
      ],
      nextCursor: "connection_00000000-0000-4000-8000-000000000001",
      ok: true,
    });
    expect(JSON.stringify(firstPage)).not.toContain("ca_private");

    await evictDurableObject(stub);
    await expect(
      stub.listConnections(authority, {
        cursor: firstPage.ok ? (firstPage.nextCursor ?? undefined) : undefined,
        limit: 1,
      }),
    ).resolves.toEqual({
      connections: [
        {
          authorizationOutcome: "untracked",
          authConfigId: "ac_slack_managed",
          connectionId: "connection_00000000-0000-4000-8000-000000000002",
          createdAt: "1970-01-01T00:00:00.002Z",
          status: "initiated",
        },
      ],
      nextCursor: null,
      ok: true,
    });
    await expect(
      env.OWNER_CONTROL_PLANE.getByName(other.ownerKey).listConnections(other, {}),
    ).resolves.toEqual({ connections: [], nextCursor: null, ok: true });
  });

  it("rejects unauthorized, cross-owner, and malformed connection listings", async () => {
    const authority = await authorityFor("124", [CONNECTIONS_READ_SCOPE]);
    const insufficient = await authorityFor("124", [CONNECTIONS_WRITE_SCOPE]);
    const other = await authorityFor("125", [CONNECTIONS_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.listConnections(insufficient, {})).resolves.toEqual(
      fixedConnectionReadFailure("insufficient_scope"),
    );
    await expect(stub.listConnections(other, {})).resolves.toEqual(
      fixedConnectionReadFailure("owner_mismatch"),
    );
    await expect(
      stub.listConnections(authority, { cursor: "connection_not-an-opaque-id" }),
    ).resolves.toEqual(fixedConnectionReadFailure("invalid_request"));
    await expect(
      stub.listConnections(authority, { credential: "must-not-reflect" }),
    ).resolves.toEqual(fixedConnectionReadFailure("invalid_request"));
  });

  it("rolls back a connection-link reservation when audit persistence fails", async () => {
    const authority = await authorityFor("120", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_connection_reservation_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'connection.link_reserved'
        BEGIN
          SELECT RAISE(ABORT, 'forced reservation audit failure');
        END
      `);
    });

    await expect(
      runInDurableObject(stub, (instance) =>
        instance.reserveConnectionLink(authority, connectionLinkInput("rollback-reservation-120")),
      ),
    ).rejects.toThrow("forced reservation audit failure");
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               (SELECT COUNT(*) FROM connection_link_requests) AS requests,
               (SELECT COUNT(*) FROM connection_authorization_returns) AS authorization_returns,
               (SELECT COUNT(*) FROM audit_events) AS audit_events`,
          )
          .one(),
      ),
    ).resolves.toEqual({ audit_events: 0, authorization_returns: 0, requests: 0 });
  });

  it("rolls back a connection-link completion when audit persistence fails", async () => {
    const authority = await authorityFor("121", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("rollback-completion-121"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected connection-link dispatch reservation.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_connection_completion_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'connection.link_created'
        BEGIN
          SELECT RAISE(ABORT, 'forced completion audit failure');
        END
      `);
    });
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.completeConnectionLink(authority, {
          authorizationToken: reservation.authorizationToken,
          expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
          providerConnectionId: "ca_rollback_121",
          reservationId: reservation.reservationId,
          url: "https://connect.composio.dev/link/ln_rollback_121",
        }),
      ),
    ).rejects.toThrow("forced completion audit failure");
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        audit: state.storage.sql
          .exec("SELECT action FROM audit_events ORDER BY event_id")
          .toArray(),
        authorizationReturn: state.storage.sql
          .exec(
            `SELECT status, connection_id, completed_at
             FROM connection_authorization_returns
             WHERE reservation_id = ?`,
            reservation.reservationId,
          )
          .one(),
        connections: state.storage.sql.exec("SELECT COUNT(*) AS count FROM connections").one(),
        request: state.storage.sql
          .exec(
            `SELECT status, connection_id, redirect_url, expires_at, completed_at
             FROM connection_link_requests
             WHERE reservation_id = ?`,
            reservation.reservationId,
          )
          .one(),
      })),
    ).resolves.toEqual({
      audit: [{ action: "connection.link_reserved" }],
      authorizationReturn: {
        completed_at: null,
        connection_id: null,
        status: "pending",
      },
      connections: { count: 0 },
      request: {
        completed_at: null,
        connection_id: null,
        expires_at: null,
        redirect_url: null,
        status: "pending",
      },
    });
  });

  it("serializes connection-link intent and scopes idempotency to the MCP client", async () => {
    const first = await authorityFor(
      "113",
      [CONNECTIONS_WRITE_SCOPE],
      "https://first-client.example/mcp.json",
    );
    const second = await authorityFor(
      "113",
      [CONNECTIONS_WRITE_SCOPE],
      "https://second-client.example/mcp.json",
    );
    const stub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);
    const [firstResult, concurrentResult] = await Promise.all([
      stub.reserveConnectionLink(first, connectionLinkInput("first-key")),
      stub.reserveConnectionLink(first, connectionLinkInput("concurrent-key")),
    ]);

    expect([firstResult, concurrentResult].filter((result) => result.ok)).toHaveLength(1);
    expect([firstResult, concurrentResult].filter((result) => !result.ok)).toEqual([
      fixedConnectionLinkFailure("connection_link_in_progress"),
    ]);
    await expect(
      stub.reserveConnectionLink(first, connectionLinkInput("first-key", "ac_linear_managed")),
    ).resolves.toEqual(fixedConnectionLinkFailure("idempotency_conflict"));
    await expect(
      stub.reserveConnectionLink(second, connectionLinkInput("first-key")),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_in_progress"));
  });

  it("holds an unknown connection-link outcome until its bounded recovery window passes", async () => {
    const authority = await authorityFor("114", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const firstInput = connectionLinkInput("unknown-114");
    const reservation = await stub.reserveConnectionLink(authority, firstInput);

    expect(reservation).toMatchObject({ ok: true, state: "dispatch" });
    await expect(stub.reserveConnectionLink(authority, firstInput)).resolves.toEqual(
      fixedConnectionLinkFailure("connection_link_outcome_unknown"),
    );
    await expect(
      stub.reserveConnectionLink(authority, connectionLinkInput("blocked-114")),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_in_progress"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE connection_link_requests SET recover_after = 1 WHERE idempotency_key = ?",
        firstInput.idempotencyKey,
      );
    });

    await expect(
      stub.reserveConnectionLink(authority, connectionLinkInput("recovered-114")),
    ).resolves.toMatchObject({ ok: true, state: "dispatch" });
    await expect(stub.reserveConnectionLink(authority, firstInput)).resolves.toEqual(
      fixedConnectionLinkFailure("connection_link_outcome_unknown"),
    );
  });

  it("rejects malformed, unauthorized, cross-owner, and late connection completions safely", async () => {
    const authority = await authorityFor("115", [CONNECTIONS_WRITE_SCOPE]);
    const other = await authorityFor("116", [CONNECTIONS_WRITE_SCOPE]);
    const insufficient = await authorityFor("115", [OWNER_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(
      stub.reserveConnectionLink(insufficient, connectionLinkInput("denied-115")),
    ).resolves.toEqual(fixedConnectionLinkFailure("insufficient_scope"));
    await expect(
      stub.reserveConnectionLink(other, connectionLinkInput("cross-owner-115")),
    ).resolves.toEqual(fixedConnectionLinkFailure("owner_mismatch"));
    await expect(
      stub.reserveConnectionLink(authority, {
        ...connectionLinkInput("hostile-115"),
        credential: "must-not-reflect",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("invalid_request"));

    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("late-115"),
    );
    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected late-completion reservation.");
    }
    await expect(
      stub.completeConnectionLink(authority, {
        authorizationToken: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        providerConnectionId: "ca_wrong_capability_115",
        reservationId: reservation.reservationId,
        url: "https://connect.composio.dev/link/ln_wrong_capability_115",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("invalid_request"));
    await expect(
      stub.completeConnectionLink(authority, {
        authorizationToken: reservation.authorizationToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        providerConnectionId: "ca_substituted_115",
        reservationId: reservation.reservationId,
        url: "https://attacker.example/link/ln_substituted_115",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("invalid_request"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE connection_link_requests SET recover_after = 1 WHERE reservation_id = ?",
        reservation.reservationId,
      );
    });
    await expect(
      stub.completeConnectionLink(authority, {
        authorizationToken: reservation.authorizationToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        providerConnectionId: "ca_late_115",
        reservationId: reservation.reservationId,
        url: "https://connect.composio.dev/link/ln_late_115",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_outcome_unknown"));
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT COUNT(*) AS count FROM connections").one(),
      ),
    ).resolves.toEqual({ count: 0 });
  });

  it("bounds owner-local connection and link-intent storage", async () => {
    const connectionAuthority = await authorityFor("117", [CONNECTIONS_WRITE_SCOPE]);
    const connectionStub = env.OWNER_CONTROL_PLANE.getByName(connectionAuthority.ownerKey);

    await runInDurableObject(connectionStub, (_instance, state) => {
      state.storage.sql.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 1000
        )
        INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
        SELECT
          'connection_fixture_' || value,
          'composio',
          'ca_fixture_' || value,
          'ac_fixture',
          'initiated',
          value
        FROM sequence
      `);
    });
    await expect(
      connectionStub.reserveConnectionLink(
        connectionAuthority,
        connectionLinkInput("connection-cap-117"),
      ),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_limit_exceeded"));

    const requestAuthority = await authorityFor("118", [CONNECTIONS_WRITE_SCOPE]);
    const requestStub = env.OWNER_CONTROL_PLANE.getByName(requestAuthority.ownerKey);

    await runInDurableObject(requestStub, (_instance, state) => {
      state.storage.sql.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 5000
        )
        INSERT INTO connection_link_requests
          (client_id, idempotency_key, request_digest, auth_config_id, reservation_id,
           status, recover_after, created_at)
        SELECT
          'fixture-client',
          'fixture-key-' || value,
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'ac_fixture',
          'connection_link_fixture_' || value,
          'abandoned',
          1,
          value
        FROM sequence
      `);
    });
    await expect(
      requestStub.reserveConnectionLink(requestAuthority, connectionLinkInput("request-cap-118")),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_request_limit_exceeded"));
  });
});
