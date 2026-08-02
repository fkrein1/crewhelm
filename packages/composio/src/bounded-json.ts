export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | {
      error: {
        code:
          | "invalid_json"
          | "invalid_limit"
          | "invalid_utf8"
          | "response_too_large"
          | "response_unavailable";
      };
      ok: false;
    };

function denied(
  code: Extract<BoundedJsonResult, { ok: false }>["error"]["code"],
): BoundedJsonResult {
  return { error: { code }, ok: false };
}

export async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<BoundedJsonResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    return denied("invalid_limit");
  }

  if (!response.body) {
    return { ok: true, value: null };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;

  try {
    reader = response.body.getReader();
  } catch {
    return denied("response_unavailable");
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      byteLength += result.value.byteLength;

      if (byteLength > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded rejection remains controlling if stream cancellation also fails.
        }
        return denied("response_too_large");
      }

      chunks.push(result.value);
    }
  } catch {
    return denied("response_unavailable");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The provider response is already classified; the host owns an unreleasable stream lock.
    }
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return denied("invalid_utf8");
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return denied("invalid_json");
  }
}
