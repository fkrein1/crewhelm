import {
  controlPlaneStatusResultSchema,
  ownerAuthoritySchema,
  type ControlPlaneStatusResult,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { DurableObject } from "cloudflare:workers";

const CONTROL_PLANE_SCHEMA_VERSION = 1;

export class OwnerControlPlane extends DurableObject {
  readonly #objectName: string | undefined;
  readonly #sql: SqlStorage;

  constructor(state: DurableObjectState, environment: Cloudflare.Env) {
    super(state, environment);
    this.#objectName = state.id.name;
    this.#sql = state.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS control_plane (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_key TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1)
      )
    `);
  }

  status(authorityInput: unknown): ControlPlaneStatusResult {
    const authority = this.#parseAuthority(authorityInput);

    if (!authority || !this.#objectName) {
      return this.#denied("invalid_authority");
    }

    if (authority.ownerKey !== this.#objectName) {
      return this.#denied("owner_mismatch");
    }

    this.#sql.exec(
      `INSERT OR IGNORE INTO control_plane (singleton, owner_key, schema_version)
       VALUES (1, ?, ?)`,
      authority.ownerKey,
      CONTROL_PLANE_SCHEMA_VERSION,
    );

    const row = this.#sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT owner_key, schema_version FROM control_plane WHERE singleton = 1",
      )
      .one();

    if (row["owner_key"] !== authority.ownerKey) {
      return this.#denied("owner_mismatch");
    }

    if (row["schema_version"] !== CONTROL_PLANE_SCHEMA_VERSION) {
      return this.#denied("incompatible_schema");
    }

    return controlPlaneStatusResultSchema.parse({
      ok: true,
      status: {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        status: "ready",
      },
    });
  }

  #denied(
    code: "incompatible_schema" | "invalid_authority" | "owner_mismatch",
  ): ControlPlaneStatusResult {
    return controlPlaneStatusResultSchema.parse({
      error: {
        code,
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  }

  #parseAuthority(authorityInput: unknown): OwnerAuthority | undefined {
    const result = ownerAuthoritySchema.safeParse(authorityInput);

    if (!result.success) {
      return undefined;
    }

    return result.data;
  }
}
