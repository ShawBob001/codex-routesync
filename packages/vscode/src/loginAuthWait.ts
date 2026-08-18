import { AuthFile, readAuthFile } from "@codex-switchbridge/core";

type WaitForAuthFileOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  readAuth?: (authPath: string) => AuthFile | null;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function waitForAuthFile(
  authPath: string,
  options: WaitForAuthFileOptions = {},
): Promise<AuthFile | null> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readAuth = options.readAuth ?? readAuthFile;
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  while (true) {
    const auth = readAuth(authPath);
    if (auth) {
      return auth;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return null;
    }

    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}
