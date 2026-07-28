import {
  RUN_RECEIVER_CAPABILITY_LIFETIME_MS,
  runAdmissionNonceSchema,
  runReceiverCapabilitySchema,
  type OwnerAuthority,
  type RedeemRunReceiverCapabilityResult,
  type RunReceiverCapability,
} from "@crewhelm/contracts";

import type { RunAdmissions } from "../runs/module.js";

const MAXIMUM_PENDING_CAPABILITIES = 128;
const INVALID_CAPABILITY = {
  error: {
    code: "invalid_admission",
    message: "Run admission denied.",
  },
  ok: false,
} as const;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function createNonce(): string {
  return runAdmissionNonceSchema.parse(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))));
}

export class RunReceiverCapabilities {
  readonly #admissions: RunAdmissions;
  readonly #objectName: string | undefined;
  readonly #pending = new Map<string, { canonical: string; expiresAt: number }>();

  constructor(objectName: string | undefined, admissions: RunAdmissions) {
    this.#admissions = admissions;
    this.#objectName = objectName;
  }

  issue(
    authority: OwnerAuthority,
    admission: NonNullable<ReturnType<RunAdmissions["read"]>>,
    action: RunReceiverCapability["action"],
    executionId?: string,
  ): RunReceiverCapability | undefined {
    const currentTime = Date.now();

    for (const [nonce, pending] of this.#pending) {
      if (pending.expiresAt <= currentTime) {
        this.#pending.delete(nonce);
      }
    }

    if (this.#objectName === undefined || this.#pending.size >= MAXIMUM_PENDING_CAPABILITIES) {
      return undefined;
    }

    const expiresAt = currentTime + RUN_RECEIVER_CAPABILITY_LIFETIME_MS;
    const capabilityName = {
      approve_tool: "run:approvals:approve",
      inspect: "run:inspect",
      list_approvals: "run:approvals:read",
      reject_tool: "run:approvals:reject",
      resume: "run:resume",
    }[action];
    const capability = runReceiverCapabilitySchema.parse({
      action,
      agentId: admission.agentId,
      agentRevision: admission.agentRevision,
      audience: "crew_agent",
      budgetReservation: admission.budgetReservation,
      capability: capabilityName,
      clientId: authority.clientId,
      connection: "none",
      effect: "none",
      expiresAt: new Date(expiresAt).toISOString(),
      idempotencyKey: admission.idempotencyKey,
      nonce: createNonce(),
      ownerKey: this.#objectName,
      promptDigest: admission.promptDigest,
      runId: admission.runId,
      target: "none",
      ...(["approve_tool", "reject_tool"].includes(action) ? { executionId } : {}),
    });

    this.#pending.set(capability.nonce, {
      canonical: JSON.stringify(capability),
      expiresAt,
    });

    return capability;
  }

  redeem(input: unknown): RedeemRunReceiverCapabilityResult {
    const capability = runReceiverCapabilitySchema.safeParse(input);

    if (!capability.success || capability.data.ownerKey !== this.#objectName) {
      return INVALID_CAPABILITY;
    }

    const pending = this.#pending.get(capability.data.nonce);
    this.#pending.delete(capability.data.nonce);

    if (
      pending === undefined ||
      pending.expiresAt <= Date.now() ||
      pending.canonical !== JSON.stringify(capability.data)
    ) {
      return INVALID_CAPABILITY;
    }

    return this.#admissions.verifyReceiverCapability(capability.data);
  }
}
