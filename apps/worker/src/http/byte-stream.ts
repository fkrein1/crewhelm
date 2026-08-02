interface ByteStreamReader {
  read(): Promise<unknown>;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readByteStreamChunk(
  reader: ByteStreamReader,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const result: unknown = await reader.read();

  if (!isUnknownRecord(result)) {
    throw new Error("Response body stream returned an invalid chunk.");
  }

  if (result.done === true) {
    return { done: true, value: undefined };
  }

  if (result.done === false && result.value instanceof Uint8Array) {
    return { done: false, value: result.value };
  }

  throw new Error("Response body stream returned an invalid chunk.");
}
