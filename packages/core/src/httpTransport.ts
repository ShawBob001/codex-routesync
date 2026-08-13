import https = require("https");

export interface HttpsTextRequestOptions {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  proxyUrl?: string | null;
}

export interface HttpsTextResponse {
  statusCode: number | null;
  body: string;
}

interface PatchedHttps {
  __vscodeOriginal?: {
    request?: typeof https.request;
  };
}

function envValue(name: string): string {
  // Lower-case variables take precedence, matching common proxy tooling.
  return process.env[name.toLowerCase()] || process.env[name.toUpperCase()] || "";
}

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

function splitNoProxyEntry(entry: string): { hostname: string; port: number | null } {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    if (closingBracket >= 0) {
      const hostname = trimmed.slice(1, closingBracket);
      const suffix = trimmed.slice(closingBracket + 1);
      const port = suffix.startsWith(":") ? Number(suffix.slice(1)) : Number.NaN;
      return { hostname, port: Number.isInteger(port) && port > 0 ? port : null };
    }
  }

  const separator = trimmed.lastIndexOf(":");
  if (separator > 0 && trimmed.indexOf(":") === separator) {
    const port = Number(trimmed.slice(separator + 1));
    if (Number.isInteger(port) && port > 0) {
      return { hostname: trimmed.slice(0, separator), port };
    }
  }
  return { hostname: trimmed, port: null };
}

function bypassesProxy(target: URL): boolean {
  const noProxy = envValue("NO_PROXY");
  if (!noProxy) return false;

  const targetHostname = target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const targetPort = target.port ? Number(target.port) : defaultPort(target.protocol);
  return noProxy.split(/[\s,]+/).some((rawEntry) => {
    if (!rawEntry) return false;
    if (rawEntry === "*") return true;

    const entry = splitNoProxyEntry(rawEntry);
    if (entry.port !== null && entry.port !== targetPort) return false;
    const entryHostname = entry.hostname.replace(/^\*?\./, "").replace(/\.$/, "");
    if (!entryHostname) return false;
    return targetHostname === entryHostname || targetHostname.endsWith(`.${entryHostname}`);
  });
}

function proxyForUrl(target: URL): string | null {
  if (bypassesProxy(target)) return null;
  const protocolProxy = target.protocol === "https:"
    ? envValue("HTTPS_PROXY") || envValue("HTTP_PROXY")
    : envValue("HTTP_PROXY");
  return protocolProxy || envValue("ALL_PROXY") || null;
}

function createProxyAgent(rawProxyUrl: string): https.Agent {
  try {
    const normalized = rawProxyUrl.includes("://") ? rawProxyUrl : `http://${rawProxyUrl}`;
    const proxyUrl = new URL(normalized);
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new Error("unsupported proxy protocol");
    }

    const proxyHeaders: Record<string, string> = {};
    if (proxyUrl.username || proxyUrl.password) {
      const username = decodeURIComponent(proxyUrl.username);
      const password = decodeURIComponent(proxyUrl.password);
      proxyHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      // https-proxy-agent emits the proxy URL through its optional debug logger.
      // Remove credentials from that URL and pass authorization separately.
      proxyUrl.username = "";
      proxyUrl.password = "";
    }

    type ProxyAgentConstructor = new (
      proxy: URL,
      options?: { headers?: Record<string, string> },
    ) => https.Agent;
    // Load lazily so direct requests remain available even in a partially installed environment.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HttpsProxyAgent } = require("https-proxy-agent") as {
      HttpsProxyAgent: ProxyAgentConstructor;
    };
    return new HttpsProxyAgent(proxyUrl, { headers: proxyHeaders });
  } catch {
    // Never include the raw proxy URL: it may contain a username or password.
    throw new Error("Invalid or unavailable proxy configuration");
  }
}

export function requestHttpsText(
  options: HttpsTextRequestOptions,
): Promise<HttpsTextResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const proxyUrl = options.proxyUrl === undefined
      ? proxyForUrl(target)
      : options.proxyUrl;
    const agent = proxyUrl ? createProxyAgent(proxyUrl) : undefined;
    const originalRequest = (https as PatchedHttps).__vscodeOriginal?.request;
    const shouldUseOriginal = agent !== undefined || options.proxyUrl !== undefined;
    const request = shouldUseOriginal && originalRequest ? originalRequest : https.request;
    const requestOptions = {
      hostname: target.hostname,
      port: target.port ? Number(target.port) : defaultPort(target.protocol),
      path: target.pathname + target.search,
      method: options.method,
      headers: options.headers,
      agent,
    };

    const req = request(requestOptions, (res) => {
      let body = "";
      let responseEnded = false;
      res.on("data", (chunk: string) => (body += chunk));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Response aborted")));
      res.on("end", () => {
        responseEnded = true;
        resolve({ statusCode: res.statusCode ?? null, body });
      });
      res.on("close", () => {
        if (!responseEnded) {
          reject(new Error("Response closed before completion"));
        }
      });
    });

    req.on("error", reject);
    if (options.timeoutMs !== undefined) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
    }
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}
