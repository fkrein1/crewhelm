import { Sandbox } from "@cloudflare/sandbox";

const PURGE_PENDING_KEY = "crewhelm:purge-pending";
const PURGE_RETRY_DELAY_MS = 30_000;

interface SandboxPurgeTransaction {
  delete(keys: string[]): Promise<number>;
  deleteAlarm(): Promise<void>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
}

export interface SandboxPurgeStorage {
  list(): Promise<Map<string, unknown>>;
  sql: {
    exec(query: string): Iterable<{ name: string }>;
  };
  transaction<T>(callback: (transaction: SandboxPurgeTransaction) => Promise<T>): Promise<T>;
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function purgeSandboxStorage(storage: SandboxPurgeStorage): Promise<void> {
  const tables = [
    ...storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ),
  ];

  for (const { name } of tables) {
    storage.sql.exec(`DROP TABLE IF EXISTS ${quotedIdentifier(name)}`);
  }

  const keys = [...(await storage.list()).keys()];
  await storage.transaction(async (transaction) => {
    if (keys.length > 0) await transaction.delete(keys);
    await transaction.deleteAlarm();
  });
}

export async function destroyAndPurgeSandbox(input: {
  destroy(): Promise<void>;
  now?: () => number;
  storage: SandboxPurgeStorage;
}): Promise<void> {
  const now = input.now ?? Date.now;

  await input.storage.transaction(async (transaction) => {
    await transaction.put(PURGE_PENDING_KEY, true);
    await transaction.setAlarm(now() + PURGE_RETRY_DELAY_MS);
  });
  await input.destroy();
  await purgeSandboxStorage(input.storage);
}

export class CrewhelmSandbox extends Sandbox<Cloudflare.Env> {
  override enableInternet = false;

  async destroyAndPurge(): Promise<void> {
    return destroyAndPurgeSandbox({
      destroy: () => super.destroy(),
      storage: this.ctx.storage,
    });
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if ((await this.ctx.storage.get(PURGE_PENDING_KEY)) === true) {
      await this.destroyAndPurge();
      return;
    }

    await super.alarm(alarmInfo);
  }
}
