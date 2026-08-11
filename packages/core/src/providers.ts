import * as fs from "fs";
import { isDeepStrictEqual } from "node:util";
import {
  hasAccountAuthTokens,
  readCurrentAuth,
  syncCurrentAuthToSavedAccount,
} from "./auth";
import { getActiveModelProvider, removeProviderConfig } from "./config";
import {
  activateProviderProfile,
  deactivateProviderRoute,
  getSharedHistoryActiveProvider,
  getSharedHistoryRouteState,
} from "./liveSwitch";
import { getNamedAuthDir, getNamedProviderPath, listNamedProviderFiles } from "./paths";
import { ProviderProfile, SharedHistorySwitchOptions } from "./types";
import { readSavedJsonFile, SavedStorageReadResult, writeSavedJsonFile } from "./savedStorage";

export interface SwitchModeResult {
  success: boolean;
  message: string;
}

export interface DeleteProviderResult {
  success: boolean;
  message: string;
  deactivated: boolean;
}

function getEffectiveActiveProvider(): string | null {
  return getActiveModelProvider() ?? getSharedHistoryActiveProvider();
}

function getEffectiveActiveProviderForMutation(): { success: true; provider: string | null } | { success: false; message: string } {
  const configuredProvider = getActiveModelProvider();
  if (configuredProvider) {
    return { success: true, provider: configuredProvider };
  }

  try {
    return { success: true, provider: getSharedHistoryRouteState()?.activeProvider ?? null };
  } catch (error) {
    return {
      success: false,
      message: `Cannot modify providers while the shared-history route state is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getModeDisplayName(name: string): string {
  return name;
}

export function getDefaultProviderProfile(name: string): ProviderProfile {
  return {
    kind: "provider",
    name,
    auth: {
      OPENAI_API_KEY: "",
    },
    config: {
      name,
      base_url: "",
      wire_api: "responses",
    },
  };
}

export function readProviderProfileResult(name: string): SavedStorageReadResult<ProviderProfile> {
  const providerPath = getNamedProviderPath(name);
  const result = readSavedJsonFile<ProviderProfile>(providerPath, "saved_provider");
  if (result.status !== "ok") {
    return result;
  }

  const parsed = result.value as unknown;
  if (!isRecord(parsed)) {
    return { status: "invalid", encrypted: result.encrypted, message: "Provider profile is not a JSON object." };
  }
  if (parsed.kind !== "provider" || parsed.name !== name) {
    return { status: "invalid", encrypted: result.encrypted, message: `Provider "${name}" is invalid.` };
  }
  if (!isRecord(parsed.auth) || !isRecord(parsed.config)) {
    return { status: "invalid", encrypted: result.encrypted, message: `Provider "${name}" is invalid.` };
  }

  const providerName = parsed.config.name;
  const baseUrl = parsed.config.base_url;
  const wireApi = parsed.config.wire_api;
  if (
    typeof providerName !== "string" ||
    typeof baseUrl !== "string" ||
    typeof wireApi !== "string"
  ) {
    return { status: "invalid", encrypted: result.encrypted, message: `Provider "${name}" is invalid.` };
  }

  return {
    status: "ok",
    encrypted: result.encrypted,
    value: {
      kind: "provider",
      name,
      auth: parsed.auth,
      config: {
        name: providerName,
        base_url: baseUrl,
        wire_api: wireApi,
      },
    },
  };
}

export function readProviderProfile(name: string): ProviderProfile | null {
  const result = readProviderProfileResult(name);
  return result.status === "ok" ? result.value : null;
}

export function writeProviderProfile(profile: ProviderProfile): void {
  fs.mkdirSync(getNamedAuthDir(), { recursive: true });
  writeSavedJsonFile(getNamedProviderPath(profile.name), "saved_provider", profile as unknown as Record<string, unknown>);
}

export type SyncCurrentProviderAuthResult =
  | { success: true; provider: string | null; changed: boolean }
  | { success: false; provider: string | null; changed: false; message: string };

export function mergeCurrentAuthIntoProviderProfile(
  profile: ProviderProfile,
  currentAuth: ProviderProfile["auth"] | null,
): ProviderProfile | null {
  if (
    !currentAuth
    || hasAccountAuthTokens(currentAuth)
    || typeof currentAuth.OPENAI_API_KEY !== "string"
    || !currentAuth.OPENAI_API_KEY.trim()
  ) {
    return null;
  }

  const nextAuth = {
    ...profile.auth,
    ...currentAuth,
  };
  if (isDeepStrictEqual(nextAuth, profile.auth)) {
    return null;
  }

  return {
    ...profile,
    auth: nextAuth,
  };
}

export function syncCurrentAuthToSavedProvider(): SyncCurrentProviderAuthResult {
  const activeProvider = getEffectiveActiveProviderForMutation();
  if (!activeProvider.success) {
    return {
      success: false,
      provider: null,
      changed: false,
      message: activeProvider.message,
    };
  }

  if (!activeProvider.provider) {
    return { success: true, provider: null, changed: false };
  }

  const profileResult = readProviderProfileResult(activeProvider.provider);
  if (profileResult.status === "missing") {
    // A VS Code cloud provider has no local provider file. Its storage adapter
    // persists the current auth before switching.
    return { success: true, provider: activeProvider.provider, changed: false };
  }
  if (profileResult.status !== "ok") {
    return {
      success: false,
      provider: activeProvider.provider,
      changed: false,
      message: profileResult.message,
    };
  }

  const nextProfile = mergeCurrentAuthIntoProviderProfile(
    profileResult.value,
    readCurrentAuth(),
  );
  if (!nextProfile) {
    return { success: true, provider: activeProvider.provider, changed: false };
  }

  writeProviderProfile(nextProfile);
  return { success: true, provider: activeProvider.provider, changed: true };
}

export function deleteProviderProfile(name: string): DeleteProviderResult {
  if (name === "account") {
    return {
      success: false,
      message: '"account" mode cannot be deleted.',
      deactivated: false,
    };
  }

  const providerPath = getNamedProviderPath(name);
  if (!fs.existsSync(providerPath)) {
    return {
      success: false,
      message: `Provider "${name}" does not exist.`,
      deactivated: false,
    };
  }

  const activeProvider = getEffectiveActiveProviderForMutation();
  if (!activeProvider.success) {
    return {
      success: false,
      message: activeProvider.message,
      deactivated: false,
    };
  }

  if (activeProvider.provider === name) {
    return {
      success: false,
      message: `Provider "${name}" is currently in use and cannot be removed.`,
      deactivated: false,
    };
  }

  fs.unlinkSync(providerPath);

  removeProviderConfig(name);

  return {
    success: true,
    message: `Removed provider "${name}"`,
    deactivated: false,
  };
}

export function listProviderModes(): string[] {
  return listNamedProviderFiles().sort();
}

export function listModes(): string[] {
  return ["account", ...listProviderModes()];
}

export function switchMode(
  name: string,
  options: SharedHistorySwitchOptions = {
    shareHistoryAcrossProviders: false,
    source: `provider:${getEffectiveActiveProvider() ?? "account"}`,
    target: `provider:${name}`,
  }
): SwitchModeResult {
  if (name === "account") {
    try {
      if (options.syncCurrentProviderAuth !== false) {
        const providerSync = syncCurrentAuthToSavedProvider();
        if (!providerSync.success) {
          return { success: false, message: providerSync.message };
        }
      }
      deactivateProviderRoute({
        source: `provider:${getEffectiveActiveProvider() ?? "unknown"}`,
        target: "account",
      });
      return { success: true, message: "Switched to account mode" };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  const profileResult = readProviderProfileResult(name);
  if (profileResult.status !== "ok") {
    const providerPath = getNamedProviderPath(name);
    return {
      success: false,
      message:
        profileResult.status === "missing"
          ? `Provider "${name}" does not exist or is invalid. Create ${providerPath} first or run the mode command to configure it.`
          : profileResult.message,
    };
  }
  try {
    fs.mkdirSync(getNamedAuthDir(), { recursive: true });
    let profileToActivate = profileResult.value;
    if (options.syncCurrentProviderAuth !== false) {
      const providerSync = syncCurrentAuthToSavedProvider();
      if (!providerSync.success) {
        return { success: false, message: providerSync.message };
      }
      if (providerSync.changed && providerSync.provider === name) {
        const synchronizedProfile = readProviderProfileResult(name);
        if (synchronizedProfile.status !== "ok") {
          return {
            success: false,
            message:
              synchronizedProfile.status === "missing"
                ? `Provider "${name}" disappeared after its current auth was synchronized.`
                : synchronizedProfile.message,
          };
        }
        profileToActivate = synchronizedProfile.value;
      }
    }
    syncCurrentAuthToSavedAccount();
    activateProviderProfile(profileToActivate, options);
    return { success: true, message: `Switched to mode "${getModeDisplayName(name)}"` };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}
