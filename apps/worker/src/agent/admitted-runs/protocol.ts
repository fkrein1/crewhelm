export async function digestRunPrompt(prompt: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt)),
  );

  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
