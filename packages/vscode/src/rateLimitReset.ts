import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  ChildProcessWithoutNullStreams,
  spawn,
  SpawnOptionsWithoutStdio,
} from "node:child_process";

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const OUTCOMES = new Set<RateLimitResetOutcome>([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);

export type RateLimitResetOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface RateLimitResetResult {
  outcome: RateLimitResetOutcome;
}

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface RunRateLimitResetOptions {
  executable: string;
  clientVersion: string;
  idempotencyKey?: string;
  creditId?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  validateBeforeConsume(): boolean | Promise<boolean>;
  spawnProcess?: SpawnProcess;
}

export type RateLimitResetErrorCode =
  | "unsupported"
  | "timeout"
  | "protocol_error"
  | "account_changed"
  | "refresh_unconfirmed"
  | "process_failed";

export class RateLimitResetError extends Error {
  constructor(public readonly code: RateLimitResetErrorCode) {
    super(code);
    this.name = "RateLimitResetError";
  }
}

export class AppServerUnsupportedError extends RateLimitResetError {
  constructor() {
    super("unsupported");
    this.name = "AppServerUnsupportedError";
  }
}

export class RateLimitResetRefreshError extends RateLimitResetError {
  constructor(public readonly outcome: RateLimitResetOutcome) {
    super("refresh_unconfirmed");
    this.name = "RateLimitResetRefreshError";
  }
}

export type RateLimitResetAction = "consume" | "manage" | "none";

export function getRateLimitResetAction(credits: {
  availableCount: number;
  applicableAvailableCount: number | null;
} | null): RateLimitResetAction {
  if (!credits || credits.availableCount <= 0 || credits.applicableAvailableCount === 0) {
    return "none";
  }
  return credits.applicableAvailableCount == null ? "manage" : "consume";
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

export async function runRateLimitReset(
  options: RunRateLimitResetOptions,
): Promise<RateLimitResetResult> {
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  if (!isUuid(idempotencyKey)) throw new RateLimitResetError("protocol_error");
  if (!isBoundedString(options.clientVersion, 1, 64)) {
    throw new RateLimitResetError("protocol_error");
  }
  if (options.creditId != null && !isBoundedString(options.creditId, 1, 512)) {
    throw new RateLimitResetError("protocol_error");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new RateLimitResetError("protocol_error");
  }

  const spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) => spawn(
    executable,
    args,
    spawnOptions,
  ));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(options.executable, ["app-server", "--stdio"], {
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    if (isMissingExecutableError(error)) throw new AppServerUnsupportedError();
    throw new RateLimitResetError("process_failed");
  }

  let nextId = 1;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutBuffer = "";
  let settled = false;
  let initializationCompleted = false;
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: RateLimitResetError): void;
  }>();
  let rejectOperation: ((error: RateLimitResetError) => void) | null = null;

  const operationFailure = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject;
  });
  const fail = (error: RateLimitResetError): void => {
    if (settled) return;
    settled = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    rejectOperation?.(error);
  };
  const timer = setTimeout(() => fail(new RateLimitResetError("timeout")), timeoutMs);

  const parseLine = (line: string): void => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(new RateLimitResetError("protocol_error"));
      return;
    }
    if (!isRecord(value)) {
      fail(new RateLimitResetError("protocol_error"));
      return;
    }
    if (typeof value.method === "string" && !("id" in value)) return;
    if (!Number.isSafeInteger(value.id)) {
      fail(new RateLimitResetError("protocol_error"));
      return;
    }
    const response = value as unknown as RpcResponse;
    const request = pending.get(response.id);
    if (!request || (("result" in response) === ("error" in response))) {
      fail(new RateLimitResetError("protocol_error"));
      return;
    }
    pending.delete(response.id);
    if ("error" in response) {
      request.reject(isUnsupportedMethodError(response.error)
        ? new AppServerUnsupportedError()
        : new RateLimitResetError("process_failed"));
    }
    else request.resolve(response.result);
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.byteLength(chunk);
    stdoutBytes += bytes;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      fail(new RateLimitResetError("protocol_error"));
      return;
    }
    stdoutBuffer += chunk.toString();
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0 && !settled) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      parseLine(line);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_STDERR_BYTES) fail(new RateLimitResetError("process_failed"));
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    fail(isMissingExecutableError(error)
      ? new AppServerUnsupportedError()
      : new RateLimitResetError("process_failed"));
  });
  child.on("close", () => {
    if (!settled) fail(initializationCompleted
      ? new RateLimitResetError("process_failed")
      : new AppServerUnsupportedError());
  });

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (settled) return Promise.reject(new RateLimitResetError("process_failed"));
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    try {
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (error) fail(new RateLimitResetError("process_failed"));
      });
    } catch {
      fail(new RateLimitResetError("process_failed"));
    }
    return Promise.race([response, operationFailure]);
  };
  const notify = (method: string): void => {
    try {
      child.stdin.write(`${JSON.stringify({ method })}\n`, (error) => {
        if (error) fail(new RateLimitResetError("process_failed"));
      });
    } catch {
      fail(new RateLimitResetError("process_failed"));
    }
  };

  try {
    const initialized = await request("initialize", {
      clientInfo: {
        name: "codex-switchbridge",
        title: "Codex SwitchBridge",
        version: options.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    if (!isRecord(initialized)) throw new RateLimitResetError("protocol_error");
    initializationCompleted = true;
    notify("initialized");
    if (!await options.validateBeforeConsume()) {
      throw new RateLimitResetError("account_changed");
    }
    const consume = await request("account/rateLimitResetCredit/consume", {
      idempotencyKey,
      ...(options.creditId != null ? { creditId: options.creditId } : {}),
    });
    if (!isRecord(consume) || !OUTCOMES.has(consume.outcome as RateLimitResetOutcome)) {
      throw new RateLimitResetError("protocol_error");
    }
    const outcome = consume.outcome as RateLimitResetOutcome;
    try {
      const latest = await request("account/rateLimits/read", undefined);
      if (!isRecord(latest) || !isRecord(latest.rateLimits)) {
        throw new RateLimitResetError("protocol_error");
      }
    } catch {
      throw new RateLimitResetRefreshError(outcome);
    }
    settled = true;
    return { outcome };
  } finally {
    settled = true;
    clearTimeout(timer);
    pending.clear();
    try { child.stdin.end(); } catch { /* best-effort cleanup */ }
    try { child.kill(); } catch { /* best-effort cleanup */ }
  }
}

export function createAppServerEnvironment(
  base: NodeJS.ProcessEnv,
  proxyUrl: string | null | undefined,
): NodeJS.ProcessEnv {
  const result = { ...base };
  if (proxyUrl === undefined) return result;
  for (const key of [
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
  ]) {
    delete result[key];
  }
  if (proxyUrl === null) return result;
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) throw new AppServerUnsupportedError();
  result.HTTPS_PROXY = normalized;
  result.HTTP_PROXY = normalized;
  result.ALL_PROXY = normalized;
  return result;
}

export interface BundledCodexResolutionOptions {
  extensionPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (candidate: string) => boolean;
}

export function resolveBundledCodexExecutable(
  options: BundledCodexResolutionOptions,
): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const architecture = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  const executable = platform === "win32" ? "codex.exe" : "codex";
  const candidates = [
    path.join(options.extensionPath, "bin", `${platform}-${architecture}`, executable),
    path.join(options.extensionPath, "bin", `${platform}-${arch}`, executable),
  ];
  const exists = options.exists ?? existsSync;
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

function normalizeProxyUrl(value: string): string | null {
  try {
    const normalized = value.includes("://") ? value : `http://${value}`;
    const parsed = new URL(normalized);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function isMissingExecutableError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isUnsupportedMethodError(error: unknown): boolean {
  return isRecord(error) && error.code === -32601;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
