import { SQL } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { getTableConfig, SQLiteSyncDialect, type IndexColumn } from "drizzle-orm/sqlite-core";

import {
  CONTROL_PLANE_SCHEMA_VERSION,
  controlPlaneMigrations,
} from "../../control-plane-migrations/index.js";
import {
  controlPlaneSchema,
  controlPlaneMigrations as migrationJournal,
  type ControlPlaneDatabaseSchema,
} from "./schema.js";

export { CONTROL_PLANE_SCHEMA_VERSION };

const INDEX_DIALECT = new SQLiteSyncDialect();
const CONTROL_PLANE_TABLES = Object.values(controlPlaneSchema);
const EXPECTED_TABLES = CONTROL_PLANE_TABLES.map((table) => getTableConfig(table).name);
const EXPECTED_INDEXES = CONTROL_PLANE_TABLES.flatMap((table) => {
  const config = getTableConfig(table);

  return [
    ...config.indexes.map((tableIndex) => ({
      definition: expectedIndexDefinition(
        tableIndex.config.name,
        config.name,
        tableIndex.config.unique,
        tableIndex.config.columns,
        tableIndex.config.where,
      ),
      name: tableIndex.config.name,
      tableName: config.name,
    })),
    ...config.columns.flatMap((column) =>
      column.isUnique && column.uniqueName !== undefined
        ? [
            {
              definition: expectedIndexDefinition(column.uniqueName, config.name, true, [column]),
              name: column.uniqueName,
              tableName: config.name,
            },
          ]
        : [],
    ),
  ];
});
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const FOREIGN_KEYS_PRAGMA = /^PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON)\s*;?$/i;
const DISABLE_FOREIGN_KEYS_PRAGMA = /^PRAGMA\s+foreign_keys\s*=\s*OFF\s*;?$/i;

type ControlPlaneDatabase = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type ResolvedControlPlaneMigration = {
  checksum: string;
  name: string;
  sql: string;
  version: number;
};

function normalizeIndexDefinition(source: string, tableName: string): string {
  return source
    .replaceAll("`", '"')
    .replaceAll(`"${tableName}".`, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .replace(/\s*=\s*/g, "=")
    .replace(/;$/, "")
    .trim()
    .toLowerCase();
}

function renderIndexColumn(column: IndexColumn): string {
  return column instanceof SQL
    ? INDEX_DIALECT.sqlToQuery(column, "indexes").sql
    : INDEX_DIALECT.escapeName(column.name);
}

function expectedIndexDefinition(
  name: string,
  tableName: string,
  unique: boolean,
  columns: IndexColumn[],
  where?: SQL,
): string {
  const source = `CREATE ${unique ? "UNIQUE " : ""}INDEX ${INDEX_DIALECT.escapeName(
    name,
  )} ON ${INDEX_DIALECT.escapeName(tableName)} (${columns
    .map((column) => renderIndexColumn(column))
    .join(",")})${
    where === undefined ? "" : ` WHERE ${INDEX_DIALECT.sqlToQuery(where, "indexes").sql}`
  }`;

  return normalizeIndexDefinition(source, tableName);
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function migrationChecksum(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));

  return encodeHex(new Uint8Array(digest));
}

function tableExists(storage: DurableObjectStorage, tableName: string): boolean {
  return (
    storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        tableName,
      )
      .toArray()[0] !== undefined
  );
}

function indexMatchesSchema(
  storage: DurableObjectStorage,
  expected: (typeof EXPECTED_INDEXES)[number],
): boolean {
  const record = storage.sql
    .exec<{ sql: string | null; tableName: string }>(
      `SELECT sql, tbl_name AS tableName
       FROM sqlite_master
       WHERE type = 'index' AND name = ?`,
      expected.name,
    )
    .toArray()[0];

  if (record === undefined || record.tableName !== expected.tableName || record.sql === null) {
    return false;
  }

  return normalizeIndexDefinition(record.sql, expected.tableName) === expected.definition;
}

export function applyControlPlaneMigrationSql(storage: DurableObjectStorage, source: string): void {
  const statements = source
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    if (!FOREIGN_KEYS_PRAGMA.test(statement)) {
      storage.sql.exec(statement);
    }
  }

  if (storage.sql.exec("PRAGMA foreign_key_check").toArray().length > 0) {
    throw new Error("Control-plane migration violated foreign-key integrity.");
  }
}

export async function runControlPlaneMigrationTransaction<Result>(
  storage: DurableObjectStorage,
  sources: readonly string[],
  callback: () => Result,
): Promise<Result> {
  const disablesForeignKeys = sources.some((source) =>
    source
      .split(STATEMENT_BREAKPOINT)
      .some((statement) => DISABLE_FOREIGN_KEYS_PRAGMA.test(statement.trim())),
  );

  if (disablesForeignKeys) {
    storage.sql.exec("PRAGMA foreign_keys = OFF");
  }

  let outcome: { ok: true; value: Result } | { error: unknown; ok: false };

  try {
    outcome = { ok: true, value: storage.transactionSync(callback) };
  } catch (error) {
    outcome = { error, ok: false };
  }

  if (disablesForeignKeys) {
    let restorationFailed = false;

    try {
      await storage.sync();
    } catch {
      restorationFailed = true;
    }

    try {
      storage.sql.exec("PRAGMA foreign_keys = ON");

      if (
        storage.sql.exec<{ foreign_keys: number }>("PRAGMA foreign_keys").one().foreign_keys !== 1
      ) {
        restorationFailed = true;
      }
    } catch {
      restorationFailed = true;
    }

    if (restorationFailed) {
      throw new Error("Control-plane migration did not restore foreign-key enforcement.");
    }
  }

  if (!outcome.ok) {
    throw outcome.error;
  }

  return outcome.value;
}

function missingExpectedTable(storage: DurableObjectStorage): string | undefined {
  return EXPECTED_TABLES.find((tableName) => !tableExists(storage, tableName));
}

function mismatchedExpectedIndex(storage: DurableObjectStorage): string | undefined {
  return EXPECTED_INDEXES.find((expected) => !indexMatchesSchema(storage, expected))?.name;
}

export function applyControlPlaneMigration(
  database: ControlPlaneDatabase,
  storage: DurableObjectStorage,
  migration: ResolvedControlPlaneMigration,
): void {
  applyControlPlaneMigrationSql(storage, migration.sql);
  database
    .insert(migrationJournal)
    .values({
      appliedAt: Date.now(),
      checksum: migration.checksum,
      name: migration.name,
      version: migration.version,
    })
    .run();
}

export async function migrateControlPlane(
  database: ControlPlaneDatabase,
  storage: DurableObjectStorage,
): Promise<boolean> {
  const migrations = await Promise.all(
    controlPlaneMigrations.map(async (migration) => ({
      ...migration,
      checksum: await migrationChecksum(migration.sql),
    })),
  );
  const versions = new Set(migrations.map((migration) => migration.version));
  const names = new Set(migrations.map((migration) => migration.name));

  if (
    migrations.length === 0 ||
    migrations.at(-1)?.version !== CONTROL_PLANE_SCHEMA_VERSION ||
    versions.size !== migrations.length ||
    names.size !== migrations.length ||
    migrations.some((migration, index) => migration.version !== index + 1)
  ) {
    return false;
  }

  try {
    const journalExistsBeforeMigration = tableExists(storage, "control_plane_migrations");
    const appliedCountBeforeMigration = journalExistsBeforeMigration
      ? database.select().from(migrationJournal).all().length
      : 0;
    const pendingMigrationSources = migrations
      .slice(appliedCountBeforeMigration)
      .map((migration) => migration.sql);

    return await runControlPlaneMigrationTransaction(storage, pendingMigrationSources, () => {
      const journalExists = tableExists(storage, "control_plane_migrations");

      if (
        !journalExists &&
        EXPECTED_TABLES.some(
          (tableName) =>
            tableName !== "control_plane_migrations" && tableExists(storage, tableName),
        )
      ) {
        return false;
      }

      const applied = journalExists
        ? database.select().from(migrationJournal).orderBy(migrationJournal.version).all()
        : [];

      for (const [index, record] of applied.entries()) {
        const migration = migrations[index];

        if (
          migration === undefined ||
          record.version !== migration.version ||
          record.name !== migration.name ||
          record.checksum !== migration.checksum
        ) {
          return false;
        }
      }

      let appliedMigration = false;

      for (const migration of migrations.slice(applied.length)) {
        applyControlPlaneMigration(database, storage, migration);
        appliedMigration = true;
      }

      const missingTable = missingExpectedTable(storage);
      const mismatchedIndex = mismatchedExpectedIndex(storage);

      if (missingTable !== undefined || mismatchedIndex !== undefined) {
        if (appliedMigration) {
          throw new Error("Control-plane migration did not create the complete schema.");
        }
        return false;
      }

      const recorded = database
        .select()
        .from(migrationJournal)
        .orderBy(migrationJournal.version)
        .all();

      return (
        recorded.length === migrations.length &&
        recorded.every((entry, index) => {
          const migration = migrations[index];

          return (
            migration !== undefined &&
            entry.version === migration.version &&
            entry.name === migration.name &&
            entry.checksum === migration.checksum
          );
        })
      );
    });
  } catch {
    console.error("crewhelm.control_plane_migration_failed");
    throw new Error("Control-plane migration failed.");
  }
}
