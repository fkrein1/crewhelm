import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

export async function openInDefaultBrowser(url: URL): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { args: [url.href], executable: "open" }
      : process.platform === "win32"
        ? {
            args: ["url.dll,FileProtocolHandler", url.href],
            executable: "rundll32",
          }
        : { args: [url.href], executable: "xdg-open" };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function promptText(message: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive input requires a terminal.");
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await prompt.question(message)).trim();
  } finally {
    prompt.close();
  }
}

export async function promptSecret(message: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode || !process.stdout.isTTY) {
    throw new Error("Secret input requires an interactive terminal.");
  }

  process.stdout.write(message);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Secret input cancelled."));
          return;
        }

        if (byte === 10 || byte === 13) {
          cleanup();
          resolve(value);
          return;
        }

        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }

        if (byte >= 32 && byte <= 126 && value.length < 4_096) {
          value += String.fromCharCode(byte);
        }
      }
    };

    process.stdin.on("data", onData);
  });
}
