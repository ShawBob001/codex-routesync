import * as vscode from "vscode";
import { logInfo, logWarn } from "./log";
import type {
  SavedAccountQuotaQueryContext,
  SavedEntriesSnapshot,
} from "./savedEntries";

const LOG_PREFIX = "[codex-switchbridge:vscode:quotaProxy]";

export type QuotaProxySource =
  | "extension-setting"
  | "vscode-setting"
  | "environment"
  | "direct";

export interface ResolvedQuotaProxy {
  proxyUrl?: string | null;
  source: QuotaProxySource;
  configured: boolean;
  valid: boolean;
}

function environmentValue(name: string): string {
  return process.env[name.toLowerCase()]?.trim()
    || process.env[name.toUpperCase()]?.trim()
    || "";
}

function validateProxyUrl(rawValue: string): boolean {
  try {
    const normalized = rawValue.includes("://") ? rawValue : `http://${rawValue}`;
    const parsed = new URL(normalized);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function configuredProxy(): { proxyUrl: string; source: Exclude<QuotaProxySource, "direct"> } | null {
  const extensionSetting = vscode.workspace
    .getConfiguration("codex-switchbridge")
    .get<string>("proxy", "")
    .trim();
  if (extensionSetting) {
    return { proxyUrl: extensionSetting, source: "extension-setting" };
  }

  const vscodeSetting = vscode.workspace
    .getConfiguration("http")
    .get<string>("proxy", "")
    .trim();
  if (vscodeSetting) {
    return { proxyUrl: vscodeSetting, source: "vscode-setting" };
  }

  const environmentProxy = environmentValue("HTTPS_PROXY")
    || environmentValue("HTTP_PROXY")
    || environmentValue("ALL_PROXY");
  return environmentProxy
    ? { proxyUrl: environmentProxy, source: "environment" }
    : null;
}

export function resolveQuotaProxy(): ResolvedQuotaProxy {
  const configured = configuredProxy();
  if (!configured) {
    const resolved: ResolvedQuotaProxy = {
      proxyUrl: null,
      source: "direct",
      configured: false,
      valid: true,
    };
    logInfo(LOG_PREFIX, "resolved", {
      source: resolved.source,
      configured: resolved.configured,
      valid: resolved.valid,
    });
    return resolved;
  }

  const valid = validateProxyUrl(configured.proxyUrl);
  const resolved: ResolvedQuotaProxy = {
    // Keep the explicit value in the query context even when validation fails.
    // Core then returns a sanitized request_failed result instead of silently
    // bypassing the user's proxy setting with a direct request.
    // Environment proxy selection stays inside core so NO_PROXY is evaluated
    // against the actual quota-service URL.
    proxyUrl: configured.source === "environment" ? undefined : configured.proxyUrl,
    source: configured.source,
    configured: true,
    valid,
  };
  const details = {
    source: resolved.source,
    configured: resolved.configured,
    valid: resolved.valid,
  };
  if (resolved.valid) {
    logInfo(LOG_PREFIX, "resolved", details);
  } else {
    logWarn(LOG_PREFIX, "invalid", details);
  }
  return resolved;
}

export function createQuotaQueryContext(
  snapshot?: SavedEntriesSnapshot,
  resolvedProxy: ResolvedQuotaProxy = resolveQuotaProxy(),
): SavedAccountQuotaQueryContext {
  return {
    ...(snapshot ? { snapshot } : {}),
    sharedQueries: new Map(),
    proxyUrl: resolvedProxy.proxyUrl,
  };
}
