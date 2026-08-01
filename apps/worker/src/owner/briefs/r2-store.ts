import type { OwnerContentObjectStore, StoredOwnerContent } from "./module.js";

function checksumHex(checksum: ArrayBuffer | undefined): string | undefined {
  return checksum === undefined
    ? undefined
    : [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class R2OwnerContentObjectStore implements OwnerContentObjectStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async get(key: string, maximumBytes: number): Promise<StoredOwnerContent | null> {
    const object = await this.#bucket.get(key);

    if (object === null) {
      return null;
    }

    const digest = object.customMetadata?.digest;
    const mediaType = object.customMetadata?.mediaType;

    if (
      digest === undefined ||
      !/^[0-9a-f]{64}$/.test(digest) ||
      mediaType === undefined ||
      object.size > maximumBytes ||
      checksumHex(object.checksums.sha256) !== digest
    ) {
      return { bytes: new Uint8Array(), digest: "", mediaType: "" };
    }

    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      digest,
      mediaType,
    };
  }

  async put(
    key: string,
    bytes: Uint8Array,
    digest: string,
    mediaType: string,
  ): Promise<"created" | "existing" | "conflict"> {
    const created = await this.#bucket.put(key, bytes, {
      customMetadata: { digest, mediaType },
      httpMetadata: { contentType: `${mediaType}; charset=utf-8` },
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
    });

    if (created !== null) {
      return "created";
    }

    const existing = await this.#bucket.head(key);

    return existing?.customMetadata?.digest === digest &&
      existing.customMetadata.mediaType === mediaType &&
      existing.size === bytes.byteLength &&
      checksumHex(existing.checksums.sha256) === digest
      ? "existing"
      : "conflict";
  }

  async delete(key: string, digest: string): Promise<"deleted" | "missing" | "conflict"> {
    const existing = await this.#bucket.head(key);

    if (existing === null) {
      return "missing";
    }

    if (
      existing.customMetadata?.digest !== digest ||
      checksumHex(existing.checksums.sha256) !== digest
    ) {
      return "conflict";
    }

    await this.#bucket.delete(key);

    return (await this.#bucket.head(key)) === null ? "deleted" : "conflict";
  }
}
