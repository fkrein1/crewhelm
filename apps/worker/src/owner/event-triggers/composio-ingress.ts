import type {
  ComposioWebhookSubscriptions,
  VerifiedComposioTriggerEvent,
} from "@crewhelm/composio";
import { verifyComposioTriggerEvent } from "@crewhelm/composio";
import { eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { composioEventTriggerWebhook, type ControlPlaneDatabaseSchema } from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type StoredWebhookSecret = {
  secretCiphertext: string;
  secretNonce: string;
  subscriptionId: string;
  updatedAt: number;
};

export const COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME = "system:composio-webhook-ingress";

const COMPOSIO_WEBHOOK_SECRET_MAXIMUM_AGE_MS = 5 * 60 * 1_000;
const COMPOSIO_WEBHOOK_REFRESH_COOLDOWN_MS = 60_000;
const COMPOSIO_WEBHOOK_REFRESH_NOT_BEFORE_KEY = "composio-webhook-refresh-not-before";

export type ComposioWebhookIngressResult =
  | { ok: true }
  | { error: "invalid_webhook" | "webhook_unavailable"; ok: false };

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);

    return Uint8Array.from(decoded, (character) => character.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const keyDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));

  return crypto.subtle.importKey("raw", keyDigest, "AES-GCM", false, ["decrypt", "encrypt"]);
}

async function encryptSecret(
  encryptionSecret: string,
  subscriptionId: string,
  secret: string,
): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      additionalData: new TextEncoder().encode(`crewhelm:composio-webhook:${subscriptionId}`),
      iv: nonce,
      name: "AES-GCM",
    },
    await encryptionKey(encryptionSecret),
    new TextEncoder().encode(secret),
  );

  return {
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    nonce: encodeBase64Url(nonce),
  };
}

async function decryptSecret(
  encryptionSecret: string,
  subscriptionId: string,
  ciphertext: string,
  nonce: string,
): Promise<string | null> {
  const ciphertextBytes = decodeBase64Url(ciphertext);
  const nonceBytes = decodeBase64Url(nonce);

  if (ciphertextBytes === null || nonceBytes?.byteLength !== 12) {
    return null;
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        additionalData: new TextEncoder().encode(`crewhelm:composio-webhook:${subscriptionId}`),
        iv: nonceBytes,
        name: "AES-GCM",
      },
      await encryptionKey(encryptionSecret),
      ciphertextBytes,
    );

    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
  } catch {
    return null;
  }
}

export class ComposioWebhookIngress {
  readonly #database: Database;
  readonly #deliver: (event: VerifiedComposioTriggerEvent) => Promise<void>;
  readonly #encryptionSecret: string | undefined;
  readonly #objectName: string | undefined;
  readonly #projectApiKey: string | undefined;
  readonly #storage: DurableObjectStorage;
  readonly #subscriptions: ComposioWebhookSubscriptions;

  constructor(
    database: Database,
    storage: DurableObjectStorage,
    objectName: string | undefined,
    options: {
      deliver: (event: VerifiedComposioTriggerEvent) => Promise<void>;
      encryptionSecret: string | undefined;
      projectApiKey: string | undefined;
      subscriptions: ComposioWebhookSubscriptions;
    },
  ) {
    this.#database = database;
    this.#deliver = options.deliver;
    this.#encryptionSecret = options.encryptionSecret;
    this.#objectName = objectName;
    this.#projectApiKey = options.projectApiKey;
    this.#storage = storage;
    this.#subscriptions = options.subscriptions;
  }

  async ensure(): Promise<boolean> {
    if (
      this.#objectName !== COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME ||
      this.#encryptionSecret === undefined ||
      this.#projectApiKey === undefined
    ) {
      return false;
    }

    const currentTime = Date.now();
    const stored = this.#stored();

    if (
      stored !== undefined &&
      currentTime - stored.updatedAt <= COMPOSIO_WEBHOOK_SECRET_MAXIMUM_AGE_MS
    ) {
      return true;
    }

    return this.#refresh(currentTime);
  }

  async receive(input: {
    body: Uint8Array;
    headers: { id: string; signature: string; timestamp: string };
  }): Promise<ComposioWebhookIngressResult> {
    if (
      this.#objectName !== COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME ||
      this.#encryptionSecret === undefined ||
      this.#projectApiKey === undefined
    ) {
      return { error: "webhook_unavailable", ok: false };
    }

    const currentTime = Date.now();
    let stored = this.#stored();

    if (
      stored === undefined ||
      currentTime - stored.updatedAt > COMPOSIO_WEBHOOK_SECRET_MAXIMUM_AGE_MS
    ) {
      if (!(await this.#refresh(currentTime))) {
        return { error: "webhook_unavailable", ok: false };
      }
      stored = this.#stored();
    }

    if (stored === undefined) {
      return { error: "webhook_unavailable", ok: false };
    }

    let verified = await this.#verify(input, stored);

    if (!verified.ok && currentTime - stored.updatedAt > COMPOSIO_WEBHOOK_REFRESH_COOLDOWN_MS) {
      if (await this.#refresh(currentTime)) {
        const refreshed = this.#stored();

        if (refreshed !== undefined) {
          verified = await this.#verify(input, refreshed);
        }
      }
    }

    if (!verified.ok) {
      return { error: "invalid_webhook", ok: false };
    }

    if (verified.kind === "trigger") {
      await this.#deliver(verified.event);
    }
    return { ok: true };
  }

  async #refresh(currentTime: number): Promise<boolean> {
    const refreshNotBefore =
      (await this.#storage.get<number>(COMPOSIO_WEBHOOK_REFRESH_NOT_BEFORE_KEY)) ?? 0;

    if (currentTime < refreshNotBefore) {
      return false;
    }

    await this.#storage.put(
      COMPOSIO_WEBHOOK_REFRESH_NOT_BEFORE_KEY,
      currentTime + COMPOSIO_WEBHOOK_REFRESH_COOLDOWN_MS,
    );
    const subscription = await this.#subscriptions.ensure();

    if (!subscription.ok || this.#encryptionSecret === undefined) {
      return false;
    }

    const encrypted = await encryptSecret(
      this.#encryptionSecret,
      subscription.subscription.id,
      subscription.subscription.secret,
    );
    this.#database
      .insert(composioEventTriggerWebhook)
      .values({
        secretCiphertext: encrypted.ciphertext,
        secretNonce: encrypted.nonce,
        singleton: 1,
        subscriptionId: subscription.subscription.id,
        updatedAt: currentTime,
        url: subscription.subscription.url,
      })
      .onConflictDoUpdate({
        set: {
          secretCiphertext: encrypted.ciphertext,
          secretNonce: encrypted.nonce,
          subscriptionId: subscription.subscription.id,
          updatedAt: currentTime,
          url: subscription.subscription.url,
        },
        target: composioEventTriggerWebhook.singleton,
      })
      .run();

    return true;
  }

  #stored() {
    return this.#database
      .select({
        secretCiphertext: composioEventTriggerWebhook.secretCiphertext,
        secretNonce: composioEventTriggerWebhook.secretNonce,
        subscriptionId: composioEventTriggerWebhook.subscriptionId,
        updatedAt: composioEventTriggerWebhook.updatedAt,
      })
      .from(composioEventTriggerWebhook)
      .where(eq(composioEventTriggerWebhook.singleton, 1))
      .get();
  }

  async #verify(
    input: {
      body: Uint8Array;
      headers: { id: string; signature: string; timestamp: string };
    },
    stored: StoredWebhookSecret,
  ) {
    const secret = await decryptSecret(
      this.#encryptionSecret ?? "",
      stored.subscriptionId,
      stored.secretCiphertext,
      stored.secretNonce,
    );

    if (secret === null || this.#projectApiKey === undefined) {
      return { error: { code: "invalid_webhook" as const }, ok: false as const };
    }

    return verifyComposioTriggerEvent({
      body: input.body,
      headers: new Headers({
        "webhook-id": input.headers.id,
        "webhook-signature": input.headers.signature,
        "webhook-timestamp": input.headers.timestamp,
      }),
      projectApiKey: this.#projectApiKey,
      secret,
    });
  }
}
