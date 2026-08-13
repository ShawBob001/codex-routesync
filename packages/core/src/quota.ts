import {
  AuthFile,
  CreditsInfo,
  IdTokenPayload,
  QuotaInfo,
  QuotaUnavailableReason,
  ResetCreditsInfo,
  WindowInfo,
} from "./types";
import { jwtDecode } from "jwt-decode";
import {
  RELOGIN_REQUIRED_MESSAGE,
  isReloginRequiredRefreshError,
} from "./refresh";
import { createDiagnosticPerformanceTimer } from "./log";
import { requestHttpsText } from "./httpTransport";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const LOG_PREFIX = "[codex-switchbridge:core:quota]";

export interface RateLimitWindow {
  used_percent?: number | string;
  usedPercent?: number | string;
  reset_at?: number | string | null;
  resetAt?: number | string | null;
  reset_after_seconds?: number | string | null;
  resetAfterSeconds?: number | string | null;
  limit_window_seconds?: number | string;
  limitWindowSeconds?: number | string;
}

interface UsageCreditsResponse {
  has_credits?: boolean;
  hasCredits?: boolean;
  balance?: string | number | null;
  approx_local_messages?: number | string | null;
  approxLocalMessages?: number | string | null;
  approx_cloud_messages?: number | string | null;
  approxCloudMessages?: number | string | null;
}

interface UsageResetCreditsResponse {
  available_count?: number | string | null;
  availableCount?: number | string | null;
  applicable_available_count?: number | string | null;
  applicableAvailableCount?: number | string | null;
}

interface UsageApiResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: RateLimitWindow;
    secondary_window?: RateLimitWindow;
  };
  additional_rate_limits?: Array<{
    limit_name: string;
    rate_limit: {
      primary_window?: RateLimitWindow;
      secondary_window?: RateLimitWindow;
    };
  }>;
  code_review_rate_limit?: {
    primary_window?: RateLimitWindow;
  };
  credits?: UsageCreditsResponse;
  rate_limit_reset_credits?: UsageResetCreditsResponse;
  rateLimitResetCredits?: UsageResetCreditsResponse;
}

interface HttpErrorLike {
  statusCode?: number;
  body?: string;
  message?: string;
}

function quotaRequestDiagnostic(error: unknown): string {
  const statusCode = (error as HttpErrorLike | null)?.statusCode;
  if (typeof statusCode === "number") {
    return `HTTP ${statusCode}`;
  }
  return error instanceof Error ? error.constructor.name : typeof error;
}

export interface QuotaPerformanceOptions {
  performanceMode?: "summary" | "adaptive";
  slowThresholdMs?: number;
  /** Undefined uses proxy environment variables; null forces a direct request. */
  proxyUrl?: string | null;
}

type AuthUpdateHook = (auth: AuthFile) => void | Promise<void>;

function quotaTokenRejectedReason(statusCode: number | null, upstreamCode?: string): QuotaUnavailableReason {
  return {
    code: "quota_token_rejected",
    message: upstreamCode
      ? `Quota API rejected current token (${upstreamCode})`
      : "Quota API rejected current token",
    statusCode,
  };
}

async function fetchUsageApi(
  auth: AuthFile,
  options: QuotaPerformanceOptions = {},
): Promise<UsageApiResponse> {
  const perf = createDiagnosticPerformanceTimer(
    LOG_PREFIX,
    "fetchUsageApi",
    {
      hasAccessToken: Boolean(auth.tokens?.access_token),
      hasAccountId: Boolean(auth.tokens?.account_id),
    },
    {
      mode: options.performanceMode === "adaptive" ? "adaptive" : "normal",
      slowThresholdMs: options.slowThresholdMs ?? 0,
    },
  );
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id ?? "";

  if (!accessToken) {
    const error = new Error("No access_token in auth file");
    perf.fail(error);
    throw error;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "User-Agent": "codex-switchbridge/1.0",
    Accept: "application/json",
  };

  try {
    const response = await requestHttpsText({
      url: USAGE_URL,
      method: "GET",
      headers,
      timeoutMs: 15_000,
      proxyUrl: options.proxyUrl,
    });
    if (
      response.statusCode === null
      || response.statusCode < 200
      || response.statusCode >= 300
    ) {
      throw {
        statusCode: response.statusCode ?? undefined,
        body: response.body,
      };
    }
    const raw = response.body;
    perf.mark("usage-request");
    const parsed = JSON.parse(raw) as UsageApiResponse;
    perf.mark("parse-usage-response");
    perf.finish({
      authError: false,
    });
    return parsed;
  } catch (err: unknown) {
    const httpErr = err as { statusCode?: number };
    if (httpErr.statusCode === 401 || httpErr.statusCode === 403) {
      perf.mark("usage-request-auth-error", {
        statusCode: httpErr.statusCode,
      });
      perf.fail(quotaRequestDiagnostic(err), {
        authError: true,
      });
      throw err;
    }
    perf.fail(quotaRequestDiagnostic(err));
    throw err;
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER
    ? Math.trunc(parsed)
    : null;
}

function parseWindow(w?: RateLimitWindow): WindowInfo | null {
  if (!w) return null;
  const usedPercent = finiteNumber(w.used_percent ?? w.usedPercent);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;

  const resetAfterSeconds = finiteNumber(w.reset_after_seconds ?? w.resetAfterSeconds);
  const rawResetAt = finiteNumber(w.reset_at ?? w.resetAt);
  let resetsAt: Date | null = null;
  if (rawResetAt !== null && rawResetAt > 0) {
    const epochMilliseconds = rawResetAt >= 1e12 ? rawResetAt : rawResetAt * 1000;
    const candidate = new Date(epochMilliseconds);
    resetsAt = Number.isNaN(candidate.getTime()) ? null : candidate;
  } else if (resetAfterSeconds !== null && resetAfterSeconds >= 0) {
    resetsAt = new Date(Date.now() + resetAfterSeconds * 1000);
  }

  const windowSeconds = finiteNumber(w.limit_window_seconds ?? w.limitWindowSeconds);
  return {
    usedPercent,
    resetsAt,
    windowSeconds: windowSeconds !== null && windowSeconds > 0 ? windowSeconds : null,
    resetAfterSeconds: resetAfterSeconds !== null && resetAfterSeconds >= 0
      ? resetAfterSeconds
      : null,
  };
}

function parseCredits(credits?: UsageCreditsResponse): CreditsInfo | null {
  if (!credits) return null;
  const balance = typeof credits.balance === "string" || typeof credits.balance === "number"
    ? String(credits.balance)
    : null;
  return {
    hasCredits: credits.has_credits ?? credits.hasCredits ?? false,
    balance,
    approxLocalMessages: nonNegativeInteger(
      credits.approx_local_messages ?? credits.approxLocalMessages,
    ),
    approxCloudMessages: nonNegativeInteger(
      credits.approx_cloud_messages ?? credits.approxCloudMessages,
    ),
  };
}

function parseResetCredits(apiData: UsageApiResponse): ResetCreditsInfo | null {
  const resetCredits = apiData.rate_limit_reset_credits ?? apiData.rateLimitResetCredits;
  if (!resetCredits) return null;
  const availableCount = nonNegativeInteger(
    resetCredits.available_count ?? resetCredits.availableCount,
  );
  if (availableCount === null) return null;
  return {
    availableCount,
    applicableAvailableCount: nonNegativeInteger(
      resetCredits.applicable_available_count ?? resetCredits.applicableAvailableCount,
    ),
  };
}

function parseUnavailableReason(auth: AuthFile, err: unknown): QuotaUnavailableReason {
  if (!auth.tokens?.access_token) {
    return {
      code: "missing_auth_tokens",
      message: "Missing auth tokens",
      statusCode: null,
    };
  }

  const httpErr = err as HttpErrorLike;
  const statusCode = typeof httpErr.statusCode === "number" ? httpErr.statusCode : null;

  if (typeof httpErr.body === "string" && httpErr.body) {
    try {
      const parsed = JSON.parse(httpErr.body) as {
        detail?: string | { code?: string };
        error?: { code?: string };
      };
      if (parsed.detail && typeof parsed.detail === "object" && parsed.detail.code === "deactivated_workspace") {
        return {
          code: "workspace_deactivated",
          message: "Workspace deactivated",
          statusCode,
        };
      }

      if (typeof parsed.detail === "string" && /authentication token/i.test(parsed.detail)) {
        return quotaTokenRejectedReason(statusCode);
      }

      if (
        typeof parsed.detail === "object"
        && parsed.detail?.code === "refresh_token_reused"
      ) {
        return {
          code: "relogin_required",
          message: RELOGIN_REQUIRED_MESSAGE,
          statusCode,
        };
      }

      if (
        (typeof parsed.detail === "object" && parsed.detail?.code === "token_invalidated")
        || parsed.error?.code === "token_invalidated"
      ) {
        return quotaTokenRejectedReason(statusCode, "token_invalidated");
      }
    } catch {
      // Ignore body parse failures and fall through to the generic mapping.
    }
  }

  if (isReloginRequiredRefreshError(err)) {
    return {
      code: "relogin_required",
      message: RELOGIN_REQUIRED_MESSAGE,
      statusCode,
    };
  }

  if (httpErr.message === "No access_token in auth file") {
    return {
      code: "missing_auth_tokens",
      message: "Missing auth tokens",
      statusCode,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return quotaTokenRejectedReason(statusCode);
  }

  return {
    code: "request_failed",
    message: "Quota unavailable",
    statusCode,
  };
}

export async function getQuotaInfo(
  auth: AuthFile,
  onAuthUpdatedOrOptions?: AuthUpdateHook | QuotaPerformanceOptions,
  maybeOptions: QuotaPerformanceOptions = {},
): Promise<QuotaInfo> {
  const options: QuotaPerformanceOptions =
    typeof onAuthUpdatedOrOptions === "function"
      ? maybeOptions
      : ((onAuthUpdatedOrOptions as QuotaPerformanceOptions | undefined) ?? {});
  const perf = createDiagnosticPerformanceTimer(
    LOG_PREFIX,
    "getQuotaInfo",
    {
      hasIdToken: Boolean(auth.tokens?.id_token),
      hasAccessToken: Boolean(auth.tokens?.access_token),
    },
    {
      mode: options.performanceMode === "adaptive" ? "adaptive" : "normal",
      slowThresholdMs: options.slowThresholdMs ?? 0,
    },
  );
  let email = "unknown";
  let tokenExpired = false;

  const idToken = auth.tokens?.id_token;
  if (typeof idToken === "string" && idToken) {
    try {
      const decoded = jwtDecode<IdTokenPayload>(idToken);
      email = decoded.email ?? "unknown";
    } catch {
      // ignore
    }
  }
  perf.mark("decode-id-token", { hasEmail: email !== "unknown" });

  const accessToken = auth.tokens?.access_token;
  if (typeof accessToken === "string" && accessToken) {
    try {
      const decoded = jwtDecode<{ exp?: number }>(accessToken);
      if (decoded.exp) {
        tokenExpired = decoded.exp * 1000 < Date.now();
      }
    } catch {
      // ignore
    }
  }
  perf.mark("decode-access-token", { tokenExpired });

  let apiData: UsageApiResponse;
  try {
    apiData = await fetchUsageApi(auth, options);
    perf.mark("fetch-usage-api");
  } catch (err: unknown) {
    const unavailable = {
      plan: getPlanFromToken(auth),
      primaryWindow: null,
      secondaryWindow: null,
      additional: [],
      codeReview: null,
      credits: null,
      resetCredits: null,
      email,
      tokenExpired,
      unavailableReason: parseUnavailableReason(auth, err),
    };
    perf.finish({
      unavailableReason: unavailable.unavailableReason?.code ?? null,
    });
    return unavailable;
  }

  const rl = apiData.rate_limit ?? {};
  const additional = (apiData.additional_rate_limits ?? []).map((item) => ({
    name: item.limit_name,
    primary: parseWindow(item.rate_limit?.primary_window),
    secondary: parseWindow(item.rate_limit?.secondary_window),
  }));

  const info = {
    plan: apiData.plan_type ?? getPlanFromToken(auth),
    primaryWindow: parseWindow(rl.primary_window),
    secondaryWindow: parseWindow(rl.secondary_window),
    additional,
    codeReview: parseWindow(apiData.code_review_rate_limit?.primary_window),
    credits: parseCredits(apiData.credits),
    resetCredits: parseResetCredits(apiData),
    email,
    tokenExpired,
    unavailableReason: null,
  };
  perf.mark("build-quota-info", {
    hasPrimaryWindow: Boolean(info.primaryWindow),
    hasSecondaryWindow: Boolean(info.secondaryWindow),
    additionalCount: info.additional.length,
  });
  perf.finish({
    unavailableReason: null,
    hasPrimaryWindow: Boolean(info.primaryWindow),
    hasSecondaryWindow: Boolean(info.secondaryWindow),
    additionalCount: info.additional.length,
  });
  return info;
}

function getPlanFromToken(auth: AuthFile): string {
  const idToken = auth.tokens?.id_token;
  if (!idToken) return "unknown";
  try {
    const decoded = jwtDecode<IdTokenPayload>(idToken);
    return decoded["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "unknown";
  } catch {
    return "unknown";
  }
}
