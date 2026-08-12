import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import {
  AuthFile,
  QuotaInfo,
  QuotaQueryResult,
  QuotaUnavailableCode,
  WindowInfo,
  getCodexConfigDir,
  getNamedAuthDir,
  isReloginRequiredRefreshError,
} from "@codex-switchbridge/core";
import { logInfo, logWarn } from "./log";

const LOG_PREFIX = "[codex-switchbridge:vscode:quotaCache]";
const CACHE_VERSION = 1;
const CACHE_DIR_ENV_VAR = "CODEX_SWITCHBRIDGE_QUOTA_CACHE_DIR";
const PRODUCTION_CACHE_DIR_NAME = "codex-switchbridge";
const TEST_CACHE_DIR_NAME = "codex-switchbridge-tests";
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function resolveCacheDir(): string {
  const configured = process.env[CACHE_DIR_ENV_VAR]?.trim();
  if (configured && path.isAbsolute(configured)) {
    return path.normalize(configured);
  }

  // Node's test runner sets NODE_TEST_CONTEXT in every test-file child. Keeping
  // those writes in a process-scoped directory prevents fixture accounts and
  // temporary CODEX_HOME values from accumulating in the user's live cache.
  if (process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(), TEST_CACHE_DIR_NAME, String(process.pid));
  }

  return path.join(os.tmpdir(), PRODUCTION_CACHE_DIR_NAME);
}

const CACHE_DIR = resolveCacheDir();
const CACHE_FILE = path.join(CACHE_DIR, "quota-cache-v1.json");
const LOCK_DIR = path.join(CACHE_DIR, "quota-cache-locks");
const CACHE_FILE_LOCK_DIR = path.join(CACHE_DIR, "quota-cache-file.lock");
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_TIMEOUT_MS = 2 * 1000;
const LOCK_WAIT_INTERVAL_MS = 100;
const CACHE_FILE_LOCK_WAIT_INTERVAL_MS = 20;
const CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_OWNER_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

interface QuotaCacheAccountLike {
  id: string;
  name: string;
  source: "local" | "cloud";
  auth: AuthFile | null;
}

interface SerializedWindowInfo {
  usedPercent: number;
  resetsAt: string | null;
  windowSeconds: number | null;
  resetAfterSeconds?: number | null;
}

interface SerializedQuotaInfo {
  plan: string;
  primaryWindow: SerializedWindowInfo | null;
  secondaryWindow: SerializedWindowInfo | null;
  additional: Array<{
    name: string;
    primary: SerializedWindowInfo | null;
    secondary: SerializedWindowInfo | null;
  }>;
  codeReview: SerializedWindowInfo | null;
  credits: {
    hasCredits: boolean;
    balance?: string | null;
    approxLocalMessages?: number | null;
    approxCloudMessages?: number | null;
  } | null;
  resetCredits?: {
    availableCount: number;
    applicableAvailableCount?: number | null;
  } | null;
  email: string;
  tokenExpired: boolean;
  unavailableReason: QuotaInfo["unavailableReason"];
}

interface QuotaCacheEntry {
  version: 1;
  accountId: string;
  accountName: string;
  source: "local" | "cloud";
  scopeHash?: string;
  queriedAt: string;
  info: SerializedQuotaInfo;
}

interface QuotaCacheFile {
  version: 1;
  entries: Record<string, QuotaCacheEntry>;
}

export interface CachedQuotaSnapshot {
  info: QuotaInfo;
  queriedAtMs: number;
}

export interface CachedQuotaFallbackMetadata {
  fallbackErrorMessage?: string;
  fallbackRefreshFailed?: boolean;
  fallbackReasonCode?: QuotaUnavailableCode;
  fallbackStatusCode?: number | null;
  fallbackReloginRequired?: boolean;
  usedCachedQuota?: boolean;
}

export type QuotaQueryResultWithFallbackMetadata = QuotaQueryResult & CachedQuotaFallbackMetadata;

interface QuotaCacheLock {
  key: string;
  path: string;
}

interface CacheFileLock {
  ownerToken: string;
  ownerFile: string;
}

function ensureCacheDirs(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CACHE_DIR, 0o700);
  fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(LOCK_DIR, 0o700);
}

function createEmptyCacheFile(): QuotaCacheFile {
  return {
    version: CACHE_VERSION,
    entries: {},
  };
}

function serializeWindowInfo(window: WindowInfo | null): SerializedWindowInfo | null {
  if (!window) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ? window.resetsAt.toISOString() : null,
    windowSeconds: window.windowSeconds,
    resetAfterSeconds: window.resetAfterSeconds,
  };
}

function deserializeWindowInfo(window: SerializedWindowInfo | null | undefined): WindowInfo | null {
  if (!window || typeof window !== "object") {
    return null;
  }
  const usedPercent = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
    && window.usedPercent >= 0 && window.usedPercent <= 100
    ? window.usedPercent
    : null;
  if (usedPercent === null) return null;
  const resetEpoch = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN;
  return {
    usedPercent,
    resetsAt: Number.isFinite(resetEpoch) ? new Date(resetEpoch) : null,
    windowSeconds: typeof window.windowSeconds === "number"
      && Number.isFinite(window.windowSeconds)
      && window.windowSeconds > 0
      ? window.windowSeconds
      : null,
    resetAfterSeconds: typeof window.resetAfterSeconds === "number"
      && Number.isFinite(window.resetAfterSeconds)
      ? window.resetAfterSeconds
      : null,
  };
}

function serializeQuotaInfo(info: QuotaInfo): SerializedQuotaInfo {
  return {
    plan: info.plan,
    primaryWindow: serializeWindowInfo(info.primaryWindow),
    secondaryWindow: serializeWindowInfo(info.secondaryWindow),
    additional: info.additional.map((item) => ({
      name: item.name,
      primary: serializeWindowInfo(item.primary),
      secondary: serializeWindowInfo(item.secondary),
    })),
    codeReview: serializeWindowInfo(info.codeReview),
    credits: info.credits ? {
      hasCredits: info.credits.hasCredits,
      balance: info.credits.balance,
      approxLocalMessages: info.credits.approxLocalMessages,
      approxCloudMessages: info.credits.approxCloudMessages,
    } : null,
    resetCredits: info.resetCredits ? {
      availableCount: info.resetCredits.availableCount,
      applicableAvailableCount: info.resetCredits.applicableAvailableCount,
    } : null,
    email: info.email,
    tokenExpired: info.tokenExpired,
    unavailableReason: info.unavailableReason,
  };
}

function deserializeQuotaInfo(info: SerializedQuotaInfo): QuotaInfo {
  const additional = Array.isArray(info.additional)
    ? info.additional.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const name = typeof item.name === "string" ? item.name : "";
        const primary = deserializeWindowInfo(item.primary);
        const secondary = deserializeWindowInfo(item.secondary);
        return primary || secondary ? [{ name, primary, secondary }] : [];
      })
    : [];
  const resetAvailableCount = info.resetCredits
    && typeof info.resetCredits.availableCount === "number"
    && Number.isSafeInteger(info.resetCredits.availableCount)
    && info.resetCredits.availableCount >= 0
    ? info.resetCredits.availableCount
    : null;
  const resetApplicableCount = info.resetCredits
    && typeof info.resetCredits.applicableAvailableCount === "number"
    && Number.isSafeInteger(info.resetCredits.applicableAvailableCount)
    && info.resetCredits.applicableAvailableCount >= 0
    ? info.resetCredits.applicableAvailableCount
    : null;
  return {
    plan: typeof info.plan === "string" ? info.plan : "unknown",
    primaryWindow: deserializeWindowInfo(info.primaryWindow),
    secondaryWindow: deserializeWindowInfo(info.secondaryWindow),
    additional,
    codeReview: deserializeWindowInfo(info.codeReview),
    credits: info.credits ? {
      hasCredits: info.credits.hasCredits === true,
      balance: typeof info.credits.balance === "string" ? info.credits.balance : null,
      approxLocalMessages: typeof info.credits.approxLocalMessages === "number"
        && Number.isFinite(info.credits.approxLocalMessages)
        ? info.credits.approxLocalMessages
        : null,
      approxCloudMessages: typeof info.credits.approxCloudMessages === "number"
        && Number.isFinite(info.credits.approxCloudMessages)
        ? info.credits.approxCloudMessages
        : null,
    } : null,
    resetCredits: resetAvailableCount == null ? null : {
      availableCount: resetAvailableCount,
      applicableAvailableCount: resetApplicableCount,
    },
    email: typeof info.email === "string" ? info.email : "unknown",
    tokenExpired: info.tokenExpired === true,
    unavailableReason: info.unavailableReason ?? null,
  };
}

function hasMeaningfulQuotaInfo(info: QuotaInfo): boolean {
  return Boolean(
    info.primaryWindow
    || info.secondaryWindow
    || info.codeReview
    || (info.additional && info.additional.some((item) => item.primary || item.secondary))
    || info.credits != null
    || info.resetCredits != null
  );
}

function getCacheKey(account: QuotaCacheAccountLike): string {
  const accountId = account.auth?.tokens?.account_id?.trim() ?? "";
  const basis = [
    getNamedAuthDir(),
    getCodexConfigDir(),
    account.source,
    account.name,
    accountId,
  ].join("|");
  return createHash("sha1").update(basis).digest("hex");
}

function getCacheScopeHash(): string {
  const basis = [getNamedAuthDir(), getCodexConfigDir()].join("\0");
  return createHash("sha256").update(basis).digest("hex");
}

function getLockPath(key: string): string {
  return path.join(LOCK_DIR, `${key}.lock`);
}

function normalizeCacheFile(raw: unknown): QuotaCacheFile {
  if (typeof raw !== "object" || raw == null) {
    return createEmptyCacheFile();
  }
  const record = raw as { version?: unknown; entries?: unknown };
  if (record.version !== CACHE_VERSION || typeof record.entries !== "object" || record.entries == null) {
    return createEmptyCacheFile();
  }
  const now = Date.now();
  const retainedEntries = Object.entries(record.entries as Record<string, QuotaCacheEntry>).filter(([key, entry]) => {
    if (!/^[a-f0-9]{40}$/i.test(key) || typeof entry !== "object" || entry == null) {
      return false;
    }
    if (
      entry.version !== CACHE_VERSION
      || (entry.source !== "local" && entry.source !== "cloud")
      || typeof entry.accountId !== "string"
      || entry.accountId.length === 0
      || typeof entry.accountName !== "string"
      || entry.accountName.length === 0
      || (entry.scopeHash !== undefined && !CACHE_SCOPE_HASH_PATTERN.test(entry.scopeHash))
      || typeof entry.info !== "object"
      || entry.info == null
    ) {
      return false;
    }
    const queriedAtMs = Date.parse(entry?.queriedAt ?? "");
    return Number.isFinite(queriedAtMs)
      && queriedAtMs <= now + MAX_FUTURE_CLOCK_SKEW_MS
      && now - queriedAtMs <= CACHE_RETENTION_MS;
  });

  const newestByIdentity = new Map<string, [string, QuotaCacheEntry]>();
  for (const candidate of retainedEntries) {
    const [key, entry] = candidate;
    // A pre-scope entry may belong to any VS Code window/CODEX_HOME. Its key is
    // deliberately part of the identity so maintenance never merges legacy
    // entries across an unknowable scope.
    const identity = entry.scopeHash
      ? ["scoped", entry.scopeHash, entry.source, entry.accountId, entry.accountName].join("\0")
      : ["legacy", key].join("\0");
    const previous = newestByIdentity.get(identity);
    if (!previous || Date.parse(entry.queriedAt) > Date.parse(previous[1].queriedAt)) {
      newestByIdentity.set(identity, candidate);
    }
  }

  const entries = Object.fromEntries(newestByIdentity.values());
  return {
    version: CACHE_VERSION,
    entries,
  };
}

function readCacheFile(): QuotaCacheFile {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return createEmptyCacheFile();
    }
    return normalizeCacheFile(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")));
  } catch (error) {
    logWarn(LOG_PREFIX, "read-cache-file-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createEmptyCacheFile();
  }
}

function writeCacheFileUnlocked(cache: QuotaCacheFile): boolean {
  let tempFile: string | null = null;
  try {
    ensureCacheDirs();
    tempFile = `${CACHE_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(tempFile, CACHE_FILE);
    tempFile = null;
    fs.chmodSync(CACHE_FILE, 0o600);
    return true;
  } catch (error) {
    if (tempFile) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // The atomic rename may already have consumed the temporary file.
      }
    }
    logWarn(LOG_PREFIX, "write-cache-file-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function sleepForLock(milliseconds: number): void {
  Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, milliseconds);
}

function readCacheFileLockOwner(lockDirectory = CACHE_FILE_LOCK_DIR): string | null {
  try {
    const entries = fs.readdirSync(lockDirectory);
    const ownerFiles = entries.filter((entry) => /^owner-[a-f0-9]{32}$/.test(entry));
    if (ownerFiles.length !== 1) return null;
    const ownerToken = fs.readFileSync(path.join(lockDirectory, ownerFiles[0]), "utf-8").trim();
    if (!LOCK_OWNER_TOKEN_PATTERN.test(ownerToken)) return null;
    return ownerFiles[0] === `owner-${ownerToken}` ? ownerToken : null;
  } catch {
    return null;
  }
}

function quarantineStaleCacheFileLock(expectedOwner: string | null): void {
  const quarantine = `${CACHE_FILE_LOCK_DIR}.stale-${randomBytes(8).toString("hex")}`;
  try {
    fs.renameSync(CACHE_FILE_LOCK_DIR, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }

  let stillStale = false;
  try {
    stillStale = Date.now() - fs.statSync(quarantine).mtimeMs >= LOCK_STALE_MS;
  } catch {
    return;
  }
  if (readCacheFileLockOwner(quarantine) === expectedOwner && stillStale) {
    fs.rmSync(quarantine, { recursive: true, force: true });
    return;
  }

  try {
    fs.renameSync(quarantine, CACHE_FILE_LOCK_DIR);
  } catch {
    // A new owner already holds the canonical path. Keep the mismatched lock
    // quarantined rather than deleting a lock we do not own.
  }
}

function maybeRecoverStaleCacheFileLock(): void {
  try {
    const observedStat = fs.statSync(CACHE_FILE_LOCK_DIR);
    const observedOwner = readCacheFileLockOwner();
    if (Date.now() - observedStat.mtimeMs < LOCK_STALE_MS) return;
    sleepForLock(CACHE_FILE_LOCK_WAIT_INTERVAL_MS);
    const confirmedStat = fs.statSync(CACHE_FILE_LOCK_DIR);
    const confirmedOwner = readCacheFileLockOwner();
    if (
      observedOwner === confirmedOwner
      && Date.now() - confirmedStat.mtimeMs >= LOCK_STALE_MS
    ) {
      quarantineStaleCacheFileLock(confirmedOwner);
      logInfo(LOG_PREFIX, "removed-stale-cache-file-lock", {});
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logWarn(LOG_PREFIX, "recover-cache-file-lock-failed", {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }
}

function acquireCacheFileLock(): CacheFileLock | null {
  const ownerToken = randomBytes(16).toString("hex");
  const ownerFile = path.join(CACHE_FILE_LOCK_DIR, `owner-${ownerToken}`);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      ensureCacheDirs();
      fs.mkdirSync(CACHE_FILE_LOCK_DIR, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerFile, ownerToken, {
          encoding: "utf-8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        try {
          fs.rmdirSync(CACHE_FILE_LOCK_DIR);
        } catch {
          // Preserve the owner-file error.
        }
        throw error;
      }
      return { ownerToken, ownerFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        logWarn(LOG_PREFIX, "acquire-cache-file-lock-failed", {
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        });
        return null;
      }
      maybeRecoverStaleCacheFileLock();
      if (Date.now() >= deadline) {
        logWarn(LOG_PREFIX, "cache-file-lock-timeout", {});
        return null;
      }
      sleepForLock(CACHE_FILE_LOCK_WAIT_INTERVAL_MS);
    }
  }
}

function releaseCacheFileLock(lock: CacheFileLock | null): void {
  if (!lock || readCacheFileLockOwner() !== lock.ownerToken) return;
  try {
    fs.unlinkSync(lock.ownerFile);
    fs.rmdirSync(CACHE_FILE_LOCK_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logWarn(LOG_PREFIX, "release-cache-file-lock-failed", {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }
}

export interface QuotaCacheMaintenanceResult {
  changed: boolean;
  beforeCount: number;
  afterCount: number;
}

export function maintainQuotaCache(): QuotaCacheMaintenanceResult {
  const lock = acquireCacheFileLock();
  if (!lock) return { changed: false, beforeCount: 0, afterCount: 0 };
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return { changed: false, beforeCount: 0, afterCount: 0 };
    }
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as unknown;
    const entries = typeof raw === "object" && raw !== null
      && typeof (raw as { entries?: unknown }).entries === "object"
      && (raw as { entries?: unknown }).entries !== null
      ? (raw as { entries: Record<string, unknown> }).entries
      : {};
    const beforeCount = Object.keys(entries).length;
    const normalized = normalizeCacheFile(raw);
    const afterCount = Object.keys(normalized.entries).length;
    const changed = JSON.stringify(raw) !== JSON.stringify(normalized);
    if (changed) {
      writeCacheFileUnlocked(normalized);
    }
    logInfo(LOG_PREFIX, "startup-maintenance", {
      changed,
      beforeCount,
      afterCount,
    });
    return { changed, beforeCount, afterCount };
  } catch (error) {
    logWarn(LOG_PREFIX, "startup-maintenance-failed", {
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    return { changed: false, beforeCount: 0, afterCount: 0 };
  } finally {
    releaseCacheFileLock(lock);
  }
}

function tryAcquireLock(key: string): QuotaCacheLock | null {
  ensureCacheDirs();
  const lockPath = getLockPath(key);
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));
    fs.closeSync(fd);
    return {
      key,
      path: lockPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      logWarn(LOG_PREFIX, "acquire-lock-failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function releaseLock(lock: QuotaCacheLock | null): void {
  if (!lock) {
    return;
  }
  try {
    if (fs.existsSync(lock.path)) {
      fs.unlinkSync(lock.path);
    }
  } catch (error) {
    logWarn(LOG_PREFIX, "release-lock-failed", {
      key: lock.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function maybeRemoveStaleLock(key: string): void {
  const lockPath = getLockPath(key);
  try {
    if (!fs.existsSync(lockPath)) {
      return;
    }
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs >= LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
      logInfo(LOG_PREFIX, "removed-stale-lock", {
        key,
      });
    }
  } catch (error) {
    logWarn(LOG_PREFIX, "remove-stale-lock-failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getCachedQuotaSnapshotByKey(key: string): CachedQuotaSnapshot | null {
  const cache = readCacheFile();
  const entry = cache.entries[key];
  if (!entry) {
    return null;
  }
  const queriedAtMs = Date.parse(entry.queriedAt);
  if (!Number.isFinite(queriedAtMs)) {
    return null;
  }
  return {
    info: deserializeQuotaInfo(entry.info),
    queriedAtMs,
  };
}

export function getCachedQuotaSnapshot(account: QuotaCacheAccountLike): CachedQuotaSnapshot | null {
  return getCachedQuotaSnapshotByKey(getCacheKey(account));
}

export function shouldUseCachedQuota(queriedAtMs: number, minIntervalMs: number): boolean {
  return Date.now() - queriedAtMs < Math.max(0, minIntervalMs);
}

export function writeCachedQuotaSnapshot(account: QuotaCacheAccountLike, info: QuotaInfo): void {
  if (!hasMeaningfulQuotaInfo(info) || info.unavailableReason) {
    return;
  }

  const key = getCacheKey(account);
  const scopeHash = getCacheScopeHash();
  const lock = acquireCacheFileLock();
  if (!lock) return;
  try {
    // The read belongs inside the process lock. Otherwise two extension hosts
    // can both read the same snapshot and the last atomic rename loses one.
    const cache = readCacheFile();
    cache.entries[key] = {
      version: CACHE_VERSION,
      accountId: account.id,
      accountName: account.name,
      source: account.source,
      scopeHash,
      queriedAt: new Date().toISOString(),
      info: serializeQuotaInfo(info),
    };
    writeCacheFileUnlocked(cache);
  } finally {
    releaseCacheFileLock(lock);
  }
}

async function waitForCacheFromOtherProcess(key: string, minQueriedAtMs: number): Promise<CachedQuotaSnapshot | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_WAIT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_INTERVAL_MS));
    const cached = getCachedQuotaSnapshotByKey(key);
    if (cached && cached.queriedAtMs >= minQueriedAtMs) {
      return cached;
    }
    if (!fs.existsSync(getLockPath(key))) {
      return getCachedQuotaSnapshotByKey(key);
    }
  }
  return getCachedQuotaSnapshotByKey(key);
}

export async function queryQuotaWithCache(
  account: QuotaCacheAccountLike,
  options: {
    minIntervalMs: number;
    forceFetch?: boolean;
    allowCachedFallback?: boolean;
    fetch: () => Promise<QuotaQueryResult>;
  },
): Promise<QuotaQueryResultWithFallbackMetadata> {
  const key = getCacheKey(account);
  const cached = getCachedQuotaSnapshotByKey(key);
  if (!options.forceFetch && cached && shouldUseCachedQuota(cached.queriedAtMs, options.minIntervalMs)) {
    logWarn(LOG_PREFIX, "use-fresh-cache", {
      account: account.name,
      source: account.source,
      ageMs: Date.now() - cached.queriedAtMs,
    });
    return {
      kind: "ok",
      displayName: account.name,
      info: cached.info,
      usedCachedQuota: true,
    };
  }

  maybeRemoveStaleLock(key);
  let lock = tryAcquireLock(key);
  if (!lock) {
    if (cached) {
      logWarn(LOG_PREFIX, "reuse-stale-cache-while-locked", {
        account: account.name,
        source: account.source,
      });
      return {
        kind: "ok",
        displayName: account.name,
        info: cached.info,
        usedCachedQuota: true,
      };
    }

    const waited = await waitForCacheFromOtherProcess(key, Date.now());
    if (waited) {
      logWarn(LOG_PREFIX, "use-cache-after-wait", {
        account: account.name,
        source: account.source,
      });
      return {
        kind: "ok",
        displayName: account.name,
        info: waited.info,
        usedCachedQuota: true,
      };
    }

    maybeRemoveStaleLock(key);
    lock = tryAcquireLock(key);
  }

  try {
    const result = await options.fetch();
    if (result.kind === "ok") {
      if (
        result.info.unavailableReason
        && result.info.unavailableReason.code !== "missing_auth_tokens"
        && cached
        && options.allowCachedFallback !== false
      ) {
        logWarn(LOG_PREFIX, "fallback-to-cache-after-unavailable-result", {
          account: account.name,
          source: account.source,
          unavailableReason: result.info.unavailableReason.code,
          statusCode: result.info.unavailableReason.statusCode,
        });
        return {
          kind: "ok",
          displayName: account.name,
          info: cached.info,
          fallbackRefreshFailed: true,
          fallbackReasonCode: result.info.unavailableReason.code,
          fallbackStatusCode: result.info.unavailableReason.statusCode,
          fallbackReloginRequired: result.info.unavailableReason.code === "relogin_required",
          usedCachedQuota: true,
        };
      }
      writeCachedQuotaSnapshot(account, result.info);
    } else if (cached && options.allowCachedFallback !== false) {
      const cachedSnapshot = getCachedQuotaSnapshotByKey(getCacheKey(account));
      logWarn(LOG_PREFIX, "fallback-to-cache-after-query-result", {
        account: account.name,
        source: account.source,
        resultKind: result.kind,
        cacheAgeMs: cachedSnapshot ? Date.now() - cachedSnapshot.queriedAtMs : null,
      });
      return {
        kind: "ok",
        displayName: account.name,
        info: cached.info,
        fallbackRefreshFailed: true,
        usedCachedQuota: true,
      };
    }
    return result;
  } catch (error) {
    if (cached && options.allowCachedFallback !== false) {
      const cachedSnapshot = getCachedQuotaSnapshotByKey(getCacheKey(account));
      logWarn(LOG_PREFIX, "fallback-to-cache-after-query-error", {
        account: account.name,
        source: account.source,
        cacheAgeMs: cachedSnapshot ? Date.now() - cachedSnapshot.queriedAtMs : null,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      return {
        kind: "ok",
        displayName: account.name,
        info: cached.info,
        fallbackRefreshFailed: true,
        fallbackReloginRequired: isReloginRequiredRefreshError(error),
        usedCachedQuota: true,
      };
    }
    throw error;
  } finally {
    releaseLock(lock);
  }
}
