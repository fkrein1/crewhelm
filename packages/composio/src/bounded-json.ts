export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    byteLength += result.value.byteLength;

    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new Error("Composio response exceeded the bounded reader.");
    }

    chunks.push(result.value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
}
