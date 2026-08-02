import { describe, expect, it, vi } from "vitest";

import { destroyAndPurgeSandbox, type SandboxPurgeStorage } from "../sandbox.js";

function sandboxStorage() {
  const keys = new Map<string, unknown>([
    ["labels", { runId: "run-1" }],
    ["transport", "rpc"],
  ]);
  const tables = new Set([
    "_cf_internal",
    "acfXlookalike",
    "container_schedules",
    "sandbox_runtime",
  ]);
  let alarm: number | undefined;
  let interruptNextTransaction = false;
  const storage: SandboxPurgeStorage = {
    list: async () => new Map(keys),
    sql: {
      exec: (query: string) => {
        if (query.startsWith("SELECT name")) {
          if (!query.includes("NOT GLOB '_cf_*'")) {
            throw new Error("Framework tables must be selected with a literal prefix filter.");
          }

          return [...tables]
            .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"))
            .map((name) => ({ name }));
        }

        const match = /^DROP TABLE IF EXISTS "([^"]+)"$/u.exec(query);
        if (match?.[1]) tables.delete(match[1]);
        return [];
      },
    },
    transaction: async (callback) => {
      const transactionKeys = new Map(keys);
      let transactionAlarm = alarm;
      const result = await callback({
        delete: async (deletedKeys) => {
          for (const key of deletedKeys) transactionKeys.delete(key);
          return deletedKeys.length;
        },
        deleteAlarm: async () => {
          transactionAlarm = undefined;
        },
        put: async (key, value) => {
          transactionKeys.set(key, value);
        },
        setAlarm: async (time) => {
          transactionAlarm = time;
        },
      });

      if (interruptNextTransaction) {
        interruptNextTransaction = false;
        throw new Error("transaction interrupted before commit");
      }

      keys.clear();
      for (const [key, value] of transactionKeys) keys.set(key, value);
      alarm = transactionAlarm;
      return result;
    },
  };

  return {
    alarm: () => alarm,
    keys,
    storage,
    tables,
    interruptNextTransaction: () => {
      interruptNextTransaction = true;
    },
  };
}

describe("Sandbox durable cleanup", () => {
  it("cannot split the recovery marker from its alarm when arming is interrupted", async () => {
    const fixture = sandboxStorage();
    const destroy = vi.fn<() => Promise<void>>(async () => undefined);
    fixture.interruptNextTransaction();

    await expect(
      destroyAndPurgeSandbox({
        destroy,
        now: () => 500,
        storage: fixture.storage,
      }),
    ).rejects.toThrow("transaction interrupted before commit");

    expect(destroy).not.toHaveBeenCalled();
    expect([...fixture.keys.keys()]).not.toContain("crewhelm:purge-pending");
    expect(fixture.alarm()).toBeUndefined();
  });

  it("stops the container and clears per-call tables including host-prefix lookalikes", async () => {
    const fixture = sandboxStorage();
    const destroy = vi.fn<() => Promise<void>>(async () => undefined);

    await destroyAndPurgeSandbox({
      destroy,
      now: () => 1_000,
      storage: fixture.storage,
    });

    expect(destroy).toHaveBeenCalledOnce();
    expect(fixture.keys.size).toBe(0);
    expect([...fixture.tables]).toEqual(["_cf_internal"]);
    expect(fixture.alarm()).toBeUndefined();
  });

  it("leaves an alarm and marker that make an interrupted destroy recoverable", async () => {
    const fixture = sandboxStorage();
    const interruptedDestroy = vi.fn<() => Promise<void>>(async () => {
      throw new Error("container control plane unavailable");
    });

    await expect(
      destroyAndPurgeSandbox({
        destroy: interruptedDestroy,
        now: () => 2_000,
        storage: fixture.storage,
      }),
    ).rejects.toThrow("container control plane unavailable");

    expect(fixture.alarm()).toBe(32_000);
    expect([...fixture.keys.keys()]).toContain("crewhelm:purge-pending");

    await destroyAndPurgeSandbox({
      destroy: async () => undefined,
      now: () => 32_000,
      storage: fixture.storage,
    });

    expect(fixture.keys.size).toBe(0);
    expect([...fixture.tables]).toEqual(["_cf_internal"]);
    expect(fixture.alarm()).toBeUndefined();
  });
});
