export async function readBoundedPostRequest(
  request: Request,
  maximumBytes: number,
): Promise<Request | null> {
  if (request.method !== "POST") {
    return null;
  }

  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      return null;
    }
  }

  if (request.body === null) {
    return request;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    totalLength += value.byteLength;

    if (totalLength > maximumBytes) {
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const headers = new Headers(request.headers);
  headers.set("content-length", String(totalLength));

  return new Request(request, { body, headers, method: "POST" });
}
