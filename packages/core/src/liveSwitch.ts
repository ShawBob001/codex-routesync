import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { getAccountIdentity, readCurrentAuth, writeCurrentAuth } from "./auth";
import {
  activateProviderConfig,
  activateProviderThroughOpenAI,
  clearActiveModelProvider,
  getActiveModelProvider,
  getOpenAIBaseUrlSnapshot,
  restoreOpenAIBaseUrl,
} from "./config";
import { getCodexAuthPath, getCodexConfigDir, getCodexConfigPath } from "./paths";
import { AuthFile, ProviderProfile, SharedHistoryRouteState, SharedHistorySwitchOptions } from "./types";

const ROUTE_STATE_FILE = "switchbridge-shared-history.json";
const LEGACY_ROUTE_STATE_FILE = "account-switch-shared-history.json";
const BACKUP_ROOT = "switchbridge-backups";
const SWITCH_LOCK_DIR = ".switchbridge-live-switch.lock";
const SWITCH_LOCK_OWNER_FILE = "owner.json";
const MAX_COMPLETED_BACKUPS = 10;
const MAX_FAILED_BACKUPS = 3;
const SWITCH_LOCK_TIMEOUT_MS = 10_000;
const SWITCH_LOCK_RETRY_MS = 25;
const SWITCH_LOCK_OWNER_GRACE_MS = 1_000;
const SWITCH_LOCK_STALE_MS = 5 * 60 * 1_000;

interface Snapshot {
  source: string;
  target: string;
  present: boolean;
  mode: number | null;
}

interface SwitchBackup {
  dir: string;
  restore(): void;
  complete(): void;
  discard(): void;
  markFailed(rollbackSucceeded: boolean): void;
}

interface SwitchLockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  source: string;
  target: string;
}

interface SwitchLock {
  release(): void;
}

interface HeldSwitchLock {
  lock: SwitchLock;
  depth: number;
}

export interface CurrentAuthWriteGuard {
  authPath: string;
  sha256: string;
  accountIdentity: string;
}

const heldSwitchLocks = new Map<string, HeldSwitchLock>();

function routeStatePath(): string {
  return path.join(getCodexConfigDir(), ROUTE_STATE_FILE);
}

function legacyRouteStatePath(): string {
  return path.join(getCodexConfigDir(), LEGACY_ROUTE_STATE_FILE);
}

function backupRootPath(): string {
  return path.join(getCodexConfigDir(), BACKUP_ROOT);
}

function switchLockPath(): string {
  return path.join(getCodexConfigDir(), SWITCH_LOCK_DIR);
}

function readStableFileSha256(filePath: string): string | null {
  try {
    const before = fs.statSync(filePath);
    const content = fs.readFileSync(filePath);
    const after = fs.statSync(filePath);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      return null;
    }
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function removeFileIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function isSwitchLockOwner(value: unknown): value is SwitchLockOwner {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    Number.isInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.hostname === "string" &&
    record.hostname.length > 0 &&
    typeof record.acquiredAt === "string" &&
    Number.isFinite(Date.parse(record.acquiredAt)) &&
    typeof record.source === "string" &&
    typeof record.target === "string"
  );
}

function readSwitchLockOwner(lockDir: string): SwitchLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(lockDir, SWITCH_LOCK_OWNER_FILE), "utf8")
    );
    return isSwitchLockOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getSwitchLockAgeMs(lockDir: string, owner: SwitchLockOwner | null): number {
  let newestTimestamp = 0;
  try {
    newestTimestamp = fs.statSync(lockDir).mtimeMs;
  } catch {
    return 0;
  }

  if (owner) {
    newestTimestamp = Math.max(newestTimestamp, Date.parse(owner.acquiredAt));
  }
  return Math.max(0, Date.now() - newestTimestamp);
}

function isLocalProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isStaleSwitchLock(lockDir: string): boolean {
  const owner = readSwitchLockOwner(lockDir);
  const ageMs = getSwitchLockAgeMs(lockDir, owner);
  if (ageMs < SWITCH_LOCK_OWNER_GRACE_MS) {
    return false;
  }
  if (ageMs >= SWITCH_LOCK_STALE_MS) {
    return true;
  }
  return owner !== null && owner.hostname === os.hostname() && !isLocalProcessRunning(owner.pid);
}

function recoverStaleSwitchLock(lockDir: string): boolean {
  if (!isStaleSwitchLock(lockDir)) {
    return false;
  }

  const quarantine = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.renameSync(lockDir, quarantine);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") {
      return false;
    }
    throw error;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function acquireSwitchLock(
  options: Pick<SharedHistorySwitchOptions, "source" | "target">
): SwitchLock {
  const lockDir = switchLockPath();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();
  fs.mkdirSync(getCodexConfigDir(), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        fs.chmodSync(lockDir, 0o700);
        const owner: SwitchLockOwner = {
          version: 1,
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString(),
          source: options.source,
          target: options.target,
        };
        writeJsonAtomic(path.join(lockDir, SWITCH_LOCK_OWNER_FILE), owner);
      } catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }

      let released = false;
      return {
        release() {
          if (released) {
            return;
          }
          released = true;
          const currentOwner = readSwitchLockOwner(lockDir);
          if (currentOwner?.token !== token) {
            return;
          }
          fs.rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      if (recoverStaleSwitchLock(lockDir)) {
        continue;
      }
      if (Date.now() - startedAt >= SWITCH_LOCK_TIMEOUT_MS) {
        const currentOwner = readSwitchLockOwner(lockDir);
        const ownerLabel = currentOwner
          ? `pid ${currentOwner.pid} on ${currentOwner.hostname} (${currentOwner.source} -> ${currentOwner.target})`
          : "an unknown process";
        throw new Error(`Timed out waiting for the live-switch lock held by ${ownerLabel}.`);
      }
      sleepSync(SWITCH_LOCK_RETRY_MS);
    }
  }
}

export function withLiveSwitchLock<T>(
  options: Pick<SharedHistorySwitchOptions, "source" | "target">,
  callback: () => T,
): T {
  const lockKey = path.resolve(switchLockPath());
  const held = heldSwitchLocks.get(lockKey);
  if (held) {
    held.depth += 1;
    try {
      return callback();
    } finally {
      held.depth -= 1;
    }
  }

  const lock = acquireSwitchLock(options);
  const acquired: HeldSwitchLock = { lock, depth: 1 };
  heldSwitchLocks.set(lockKey, acquired);
  try {
    return callback();
  } finally {
    acquired.depth -= 1;
    heldSwitchLocks.delete(lockKey);
    lock.release();
  }
}

export function captureCurrentAuthWriteGuard(expectedAuth: AuthFile): CurrentAuthWriteGuard | null {
  const accountIdentity = getAccountIdentity(expectedAuth);
  if (!accountIdentity) {
    return null;
  }

  const authPath = getCodexAuthPath();
  const beforeSha256 = readStableFileSha256(authPath);
  if (!beforeSha256) {
    return null;
  }
  const currentAuth = readCurrentAuth();
  const afterSha256 = readStableFileSha256(authPath);
  if (
    !currentAuth
    || getAccountIdentity(currentAuth) !== accountIdentity
    || afterSha256 !== beforeSha256
  ) {
    return null;
  }

  return {
    authPath,
    sha256: beforeSha256,
    accountIdentity,
  };
}

export function writeCurrentAuthIfUnchanged(
  guard: CurrentAuthWriteGuard,
  auth: AuthFile,
): boolean {
  return withLiveSwitchLock({ source: "account-refresh", target: "current-auth" }, () => {
    let sharedRouteActive = false;
    try {
      sharedRouteActive = getSharedHistoryRouteState() !== null;
    } catch {
      return false;
    }
    if (getActiveModelProvider() !== null || sharedRouteActive || getCodexAuthPath() !== guard.authPath) {
      return false;
    }

    const beforeSha256 = readStableFileSha256(guard.authPath);
    if (beforeSha256 !== guard.sha256) {
      return false;
    }
    const currentAuth = readCurrentAuth();
    const afterSha256 = readStableFileSha256(guard.authPath);
    if (
      !currentAuth
      || getAccountIdentity(currentAuth) !== guard.accountIdentity
      || afterSha256 !== beforeSha256
    ) {
      return false;
    }

    writeCurrentAuth(auth);
    return true;
  });
}

function isOptionalTopLevelString(value: unknown): value is SharedHistoryRouteState["originalOpenAIBaseUrl"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.present === true) {
    return typeof record.value === "string";
  }
  if (record.present === false) {
    return record.value === null;
  }
  return false;
}

function readSharedHistoryRouteState(filePath: string): SharedHistoryRouteState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const invalid = new Error(`Invalid shared-history route state: ${filePath}`);
    (invalid as Error & { cause?: unknown }).cause = error;
    throw invalid;
  }

  if (
    !parsed
    || typeof parsed !== "object"
    || (parsed as Record<string, unknown>).version !== 1
    || typeof (parsed as Record<string, unknown>).activeProvider !== "string"
    || !isOptionalTopLevelString((parsed as Record<string, unknown>).originalOpenAIBaseUrl)
  ) {
    throw new Error(`Invalid shared-history route state: ${filePath}`);
  }
  return parsed as SharedHistoryRouteState;
}

export function getSharedHistoryRouteState(): SharedHistoryRouteState | null {
  const currentPath = routeStatePath();
  if (fs.existsSync(currentPath)) {
    return readSharedHistoryRouteState(currentPath);
  }

  const legacyPath = legacyRouteStatePath();
  if (!fs.existsSync(legacyPath)) {
    return null;
  }

  const legacy = readSharedHistoryRouteState(legacyPath);
  writeJsonAtomic(currentPath, legacy);
  removeFileIfExists(legacyPath);
  return legacy;
}

export function getSharedHistoryActiveProvider(): string | null {
  try {
    return getSharedHistoryRouteState()?.activeProvider ?? null;
  } catch {
    return null;
  }
}

function copySnapshot(source: string, target: string): Snapshot {
  if (!fs.existsSync(source)) {
    return { source, target, present: false, mode: null };
  }

  const mode = fs.statSync(source).mode & 0o7777;
  fs.copyFileSync(source, target);
  fs.chmodSync(target, mode);
  return { source, target, present: true, mode };
}

function restoreSnapshots(snapshots: Snapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.present) {
      fs.copyFileSync(snapshot.target, snapshot.source);
      if (snapshot.mode !== null) {
        fs.chmodSync(snapshot.source, snapshot.mode);
      }
    } else {
      removeFileIfExists(snapshot.source);
    }
  }
}

function createBackup(options: Pick<SharedHistorySwitchOptions, "source" | "target">): SwitchBackup {
  const root = backupRootPath();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  retainBackups(root);

  const dir = path.join(
    root,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(16).slice(2)}`
  );
  fs.mkdirSync(dir, { mode: 0o700 });
  let snapshots: Snapshot[];
  try {
    snapshots = [
      getCodexAuthPath(),
      getCodexConfigPath(),
      routeStatePath(),
      legacyRouteStatePath(),
    ].map((source) => copySnapshot(source, path.join(dir, path.basename(source))));

    writeJsonAtomic(path.join(dir, "manifest.json"), {
      version: 1,
      status: "prepared",
      createdAt: new Date().toISOString(),
      source: options.source,
      target: options.target,
      files: snapshots.map((snapshot) => ({
        path: snapshot.source,
        present: snapshot.present,
      })),
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    dir,
    restore() {
      restoreSnapshots(snapshots);
    },
    complete() {
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      writeJsonAtomic(manifestPath, {
        ...manifest,
        status: "complete",
        completedAt: new Date().toISOString(),
      });
      retainBackups(root);
    },
    discard() {
      fs.rmSync(dir, { recursive: true, force: true });
      retainBackups(root);
    },
    markFailed(rollbackSucceeded: boolean) {
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      writeJsonAtomic(manifestPath, {
        ...manifest,
        status: "failed",
        failedAt: new Date().toISOString(),
        rollbackSucceeded,
      });
      retainBackups(root);
    },
  };
}

function retainNewestBackupDirectories(root: string, names: string[], limit: number): void {
  const sorted = [...names].sort().reverse();
  for (const name of sorted.slice(limit)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function retainBackups(root: string): void {
  if (!fs.existsSync(root)) {
    return;
  }

  const completed: string[] = [];
  const failedOrIncomplete: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, entry.name, "manifest.json"), "utf8")
      );
      if (manifest?.status === "complete") {
        completed.push(entry.name);
      } else {
        failedOrIncomplete.push(entry.name);
      }
    } catch {
      failedOrIncomplete.push(entry.name);
    }
  }

  retainNewestBackupDirectories(root, completed, MAX_COMPLETED_BACKUPS);
  retainNewestBackupDirectories(root, failedOrIncomplete, MAX_FAILED_BACKUPS);
}

function writeSharedHistoryRouteState(state: SharedHistoryRouteState): void {
  writeJsonAtomic(routeStatePath(), state);
  removeFileIfExists(legacyRouteStatePath());
}

function clearSharedHistoryRouteState(): void {
  removeFileIfExists(routeStatePath());
  removeFileIfExists(legacyRouteStatePath());
}

function validateSharedProviderProfile(profile: ProviderProfile): void {
  if (profile.config.wire_api !== "responses") {
    throw new Error('Shared-history relay requires wire_api = "responses".');
  }
  if (typeof profile.config.base_url !== "string" || !profile.config.base_url.trim()) {
    throw new Error("Shared-history relay requires a non-empty Responses API base URL.");
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rollbackFailedSwitch(backup: SwitchBackup, switchError: unknown): never {
  try {
    backup.restore();
  } catch (rollbackError) {
    try {
      backup.markFailed(false);
    } catch {
      // Preserve the snapshots in place even when their manifest cannot be updated.
    }
    const combined = new Error(
      `Live switch failed (${describeError(switchError)}) and rollback failed (${describeError(rollbackError)}). ` +
      `Recovery snapshots were retained at ${backup.dir}.`
    );
    (combined as Error & { cause?: unknown }).cause = switchError;
    throw combined;
  }

  try {
    backup.discard();
  } catch {
    try {
      backup.markFailed(true);
    } catch {
      // The original switch error remains the actionable failure.
    }
  }
  throw switchError;
}

function runLiveSwitchTransaction(
  options: Pick<SharedHistorySwitchOptions, "source" | "target">,
  validate: (() => void) | null,
  mutate: () => void
): void {
  withLiveSwitchLock(options, () => {
    validate?.();
    const backup = createBackup(options);
    try {
      mutate();
      backup.complete();
    } catch (error) {
      rollbackFailedSwitch(backup, error);
    }
  });
}

export function activateProviderProfile(profile: ProviderProfile, options: SharedHistorySwitchOptions): void {
  runLiveSwitchTransaction(
    options,
    options.shareHistoryAcrossProviders ? () => validateSharedProviderProfile(profile) : null,
    () => {
      if (options.shareHistoryAcrossProviders) {
        const previous = getSharedHistoryRouteState();
        const originalOpenAIBaseUrl = previous?.originalOpenAIBaseUrl ?? getOpenAIBaseUrlSnapshot();
        writeCurrentAuth(profile.auth);
        activateProviderThroughOpenAI(profile.name, profile.config);
        writeSharedHistoryRouteState({
          version: 1,
          activeProvider: profile.name,
          originalOpenAIBaseUrl,
        });
      } else {
        const previous = getSharedHistoryRouteState();
        if (previous) {
          restoreOpenAIBaseUrl(previous.originalOpenAIBaseUrl);
          clearSharedHistoryRouteState();
        }
        writeCurrentAuth(profile.auth);
        activateProviderConfig(profile.name, profile.config);
      }
    }
  );
}

export function activateAccountAuth(
  auth: AuthFile,
  options: Omit<SharedHistorySwitchOptions, "shareHistoryAcrossProviders">
): void {
  runLiveSwitchTransaction(options, null, () => {
    const route = getSharedHistoryRouteState();
    writeCurrentAuth(auth);
    clearActiveModelProvider();
    if (route) {
      restoreOpenAIBaseUrl(route.originalOpenAIBaseUrl);
      clearSharedHistoryRouteState();
    }
  });
}

export function deactivateProviderRoute(
  options: Omit<SharedHistorySwitchOptions, "shareHistoryAcrossProviders">
): void {
  runLiveSwitchTransaction(options, null, () => {
    const route = getSharedHistoryRouteState();
    clearActiveModelProvider();
    if (route) {
      restoreOpenAIBaseUrl(route.originalOpenAIBaseUrl);
      clearSharedHistoryRouteState();
    }
  });
}
