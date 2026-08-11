import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export const NAMED_AUTH_DIR_ENV_VAR = "CODEX_SWITCHBRIDGE_AUTH_DIR";

export type SavedEntryKind = "account" | "provider";

export type SavedEntryNameValidationResult =
  | { valid: true }
  | { valid: false; message: string };

const PATH_SEPARATOR_PATTERN = /[\\/]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_INVALID_FILENAME_CHARACTER_PATTERN = /[<>:"|?*]/;

export function getCodexConfigDir(): string {
  if (process.env.CODEX_HOME) {
    return process.env.CODEX_HOME;
  }
  return path.join(os.homedir(), ".codex");
}

function normalizeOptionalDir(dir: string | null | undefined): string | null {
  const trimmed = dir?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

export function setNamedAuthDir(dir?: string | null): void {
  const normalized = normalizeOptionalDir(dir);
  if (normalized) {
    process.env[NAMED_AUTH_DIR_ENV_VAR] = normalized;
    return;
  }
  delete process.env[NAMED_AUTH_DIR_ENV_VAR];
}

export function getNamedAuthDir(): string {
  return normalizeOptionalDir(process.env[NAMED_AUTH_DIR_ENV_VAR]) ?? getCodexConfigDir();
}

export function getCodexAuthPath(): string {
  return path.join(getCodexConfigDir(), "auth.json");
}

export function getCodexConfigPath(): string {
  return path.join(getCodexConfigDir(), "config.toml");
}

export function validateSavedEntryName(name: string): SavedEntryNameValidationResult {
  if (typeof name !== "string" || name.length === 0) {
    return { valid: false, message: "A saved entry name is required." };
  }
  if (name === "." || name === "..") {
    return { valid: false, message: "Saved entry names cannot be dot path segments." };
  }
  if (PATH_SEPARATOR_PATTERN.test(name)) {
    return { valid: false, message: "Saved entry names cannot contain path separators." };
  }
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return { valid: false, message: "Saved entry names cannot contain control characters." };
  }
  if (WINDOWS_INVALID_FILENAME_CHARACTER_PATTERN.test(name)) {
    return { valid: false, message: "Saved entry names cannot contain characters that are invalid on Windows." };
  }
  if (name.endsWith(".") || name.endsWith(" ")) {
    return { valid: false, message: "Saved entry names cannot end with a dot or space." };
  }
  return { valid: true };
}

export function assertValidSavedEntryName(name: string): void {
  const validation = validateSavedEntryName(name);
  if (!validation.valid) {
    throw new Error(validation.message);
  }
}

function isPathContainedBy(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function assertResolvedPathContainment(directory: string, candidate: string): void {
  if (!isPathContainedBy(directory, candidate)) {
    throw new Error("Saved entry path resolves outside the configured saved-entry directory.");
  }

  if (!fs.existsSync(directory) || !fs.existsSync(candidate)) {
    return;
  }

  const resolvedDirectory = fs.realpathSync(directory);
  const resolvedCandidate = fs.realpathSync(candidate);
  if (!isPathContainedBy(resolvedDirectory, resolvedCandidate)) {
    throw new Error("Saved entry path resolves outside the configured saved-entry directory.");
  }
}

export function resolveSavedEntryPath(kind: SavedEntryKind, name: string): string {
  assertValidSavedEntryName(name);
  const directory = path.resolve(getNamedAuthDir());
  const prefix = kind === "account" ? "auth_" : "provider_";
  const candidate = path.resolve(directory, `${prefix}${name}.json`);
  assertResolvedPathContainment(directory, candidate);
  return candidate;
}

export function getNamedAuthPath(name: string): string {
  return resolveSavedEntryPath("account", name);
}

export function getNamedProviderPath(name: string): string {
  return resolveSavedEntryPath("provider", name);
}

function listSavedEntryNames(kind: SavedEntryKind): string[] {
  const dir = getNamedAuthDir();
  if (!fs.existsSync(dir)) return [];

  const pattern = kind === "account" ? /^auth_(.+)\.json$/ : /^provider_(.+)\.json$/;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => pattern.exec(entry.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1])
    .filter((name) => validateSavedEntryName(name).valid)
    .filter((name) => {
      try {
        resolveSavedEntryPath(kind, name);
        return true;
      } catch {
        return false;
      }
    });
}

export function listNamedAuthFiles(): string[] {
  return listSavedEntryNames("account");
}

export function listNamedProviderFiles(): string[] {
  return listSavedEntryNames("provider");
}
