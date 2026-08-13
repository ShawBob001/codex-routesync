import * as fs from "fs";
import * as querystring from "querystring";
import { AuthFile } from "./types";
import { readSavedAuthFileResult, writeAuthFile, writeSavedAuthFile } from "./auth";
import { createDiagnosticPerformanceTimer } from "./log";
import { requestHttpsText } from "./httpTransport";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOG_PREFIX = "[codex-switchbridge:core:refresh]";
export const RELOGIN_REQUIRED_MESSAGE = "Relogin required";

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

export interface RefreshRequestOptions {
  proxyUrl?: string | null;
}

export interface RefreshAndSaveOptions extends RefreshRequestOptions {
  saved?: boolean;
}

export function isReloginRequiredRefreshError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("refresh_token_reused")
    || normalized.includes("refresh_token_invalidated")
    || normalized.includes("has been invalidated")
    || normalized.includes("signing in again")
    || normalized.includes("sign in again")
  );
}

export function applyRefreshResponse(auth: AuthFile, result: RefreshResponse, now = Date.now()): void {
  auth.tokens ??= {};
  if (result.access_token) {
    auth.tokens.access_token = result.access_token;
  }
  if (result.refresh_token) {
    auth.tokens.refresh_token = result.refresh_token;
  }
  if (result.id_token) {
    auth.tokens.id_token = result.id_token;
  }

  auth.last_refresh = new Date(now).toISOString();
}

async function postForm(
  url: string,
  data: string,
  options: RefreshRequestOptions,
): Promise<string> {
  const perf = createDiagnosticPerformanceTimer(LOG_PREFIX, "postForm", {
    url,
    contentLength: Buffer.byteLength(data),
  });
  let response;
  try {
    response = await requestHttpsText({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(data)),
      },
      body: data,
      timeoutMs: 15_000,
      proxyUrl: options.proxyUrl,
    });
  } catch (error) {
    perf.fail(error);
    throw error;
  }

  if (
    response.statusCode !== null
    && response.statusCode >= 200
    && response.statusCode < 300
  ) {
    perf.finish({
      statusCode: response.statusCode,
      responseBytes: response.body.length,
    });
    return response.body;
  }

  const error = new Error(`HTTP ${response.statusCode ?? undefined}: ${response.body}`);
  perf.fail(error, {
    statusCode: response.statusCode,
    responseBytes: response.body.length,
  });
  throw error;
}

export async function refreshAccessToken(
  auth: AuthFile,
  options: RefreshRequestOptions = {},
): Promise<RefreshResponse> {
  const perf = createDiagnosticPerformanceTimer(LOG_PREFIX, "refreshAccessToken", {
    hasRefreshToken: Boolean(auth.tokens?.refresh_token),
  });
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) {
    const error = new Error("No refresh_token in auth file");
    perf.fail(error);
    throw error;
  }

  try {
    const body = querystring.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
    perf.mark("serialize-request");

    const raw = await postForm(TOKEN_URL, body, options);
    perf.mark("post-form");

    const parsed = JSON.parse(raw) as RefreshResponse;
    perf.mark("parse-response", {
      hasAccessToken: Boolean(parsed.access_token),
      hasRefreshToken: Boolean(parsed.refresh_token),
      hasIdToken: Boolean(parsed.id_token),
    });
    perf.finish({
      hasAccessToken: Boolean(parsed.access_token),
      hasRefreshToken: Boolean(parsed.refresh_token),
      hasIdToken: Boolean(parsed.id_token),
    });
    return parsed;
  } catch (error) {
    perf.fail(error);
    throw error;
  }
}

export async function refreshAndSave(
  authPath: string,
  options: RefreshAndSaveOptions = {},
): Promise<AuthFile> {
  const auth = options?.saved
    ? (() => {
        const result = readSavedAuthFileResult(authPath);
        if (result.status !== "ok") {
          throw new Error("message" in result ? result.message : "Saved auth file was not found.");
        }
        return result.value;
      })()
    : (JSON.parse(fs.readFileSync(authPath, "utf-8")) as AuthFile);
  const result = await refreshAccessToken(auth, { proxyUrl: options.proxyUrl });
  applyRefreshResponse(auth, result);

  if (options?.saved) {
    writeSavedAuthFile(authPath, auth);
  } else {
    writeAuthFile(authPath, auth);
  }
  return auth;
}
