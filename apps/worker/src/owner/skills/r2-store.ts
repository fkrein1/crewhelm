import { MAXIMUM_SKILL_PACKAGE_BYTES } from "@crewhelm/contracts";

import type { SkillPackageObjectStore, StoredSkillPackage } from "./module.js";

function checksumHex(checksum: ArrayBuffer | undefined): string | undefined {
  return checksum === undefined
    ? undefined
    : [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class R2SkillPackageObjectStore implements SkillPackageObjectStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async get(key: string): Promise<StoredSkillPackage | null> {
    const object = await this.#bucket.get(key);

    if (object === null) {
      return null;
    }

    const digest = object.customMetadata?.digest;

    if (
      digest === undefined ||
      !/^[0-9a-f]{64}$/.test(digest) ||
      object.size > MAXIMUM_SKILL_PACKAGE_BYTES
    ) {
      return { bytes: new Uint8Array(), digest: "" };
    }

    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      digest,
    };
  }

  async put(
    key: string,
    bytes: Uint8Array,
    digest: string,
  ): Promise<"created" | "existing" | "conflict"> {
    const created = await this.#bucket.put(key, bytes, {
      customMetadata: { digest },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
    });

    if (created !== null) {
      return "created";
    }

    const existing = await this.#bucket.head(key);

    return existing?.customMetadata?.digest === digest &&
      existing.size === bytes.byteLength &&
      checksumHex(existing.checksums.sha256) === digest
      ? "existing"
      : "conflict";
  }
}
