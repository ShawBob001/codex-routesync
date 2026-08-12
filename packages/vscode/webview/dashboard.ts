import type {
  DashboardAccount,
  DashboardModel,
  DashboardQuota,
  DashboardQuotaStatus,
  DashboardUsageSegment,
} from "../src/dashboardModel";
import type { DashboardAction } from "../src/dashboardProtocol";

interface VsCodeApi {
  getState(): unknown;
  setState(value: unknown): void;
  postMessage(value: unknown): void;
}

interface DashboardHostMessage {
  type: "dashboard.state";
  revision: number;
  state: DashboardModel;
}

interface PersistedState {
  tokenDetailsExpanded: boolean;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root is unavailable");
const app: HTMLElement = root;

let lastRevision = -1;
let currentModel: DashboardModel | null = null;
let togglePending = false;
let requestSequence = 0;
const restored = parsePersistedState(vscode.getState());
let tokenDetailsExpanded = restored.tokenDetailsExpanded;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isDashboardHostMessage(event.data) || event.data.revision <= lastRevision) return;
  lastRevision = event.data.revision;
  currentModel = event.data.state;
  togglePending = false;
  render(event.data.state);
});

postReady();
renderLoading();

function render(model: DashboardModel): void {
  app.replaceChildren();
  app.append(
    renderRoute(model),
    renderAutoSwitch(model),
    renderOtherAccounts(model),
    renderUsage(model),
    renderActions(model),
  );
  if (model.reload.recommended) app.append(renderReload(model));
}

function renderLoading(): void {
  const loading = element("div", "loading-state");
  loading.setAttribute("role", "status");
  loading.append(element("span", "loading-mark", "S"), element("span", "", "Loading dashboard..."));
  app.replaceChildren(loading);
}

function renderRoute(model: DashboardModel): HTMLElement {
  const section = pathSection("Current route", "route-section");
  const route = model.route;
  const body = element("div", "route-body");

  if (route.kind === "account") {
    body.append(renderQuotaRing(route.quota));
    const identity = element("div", "route-identity");
    identity.append(
      overline("Account"),
      namedValue(route.name, route.disambiguator),
      metadata([
        route.plan,
        route.localTokens == null ? null : `${formatNumber(route.localTokens)} local tokens`,
      ]),
      renderQuotaSummary(route.quota),
    );
    if (route.accountId && route.quota.status === "relogin-required") {
      identity.append(commandButton("Sign in", "reloginAccount", "link compact", { targetId: route.accountId }));
    } else if (route.accountId && route.quota.status === "storage-locked") {
      identity.append(commandButton("Unlock", "unlockStorage", "link compact", { targetId: route.accountId }));
    }
    body.append(identity);
  } else if (route.kind === "provider") {
    const providerSignal = element("div", "provider-signal");
    providerSignal.setAttribute("aria-label", "API Provider mode, account quota unavailable");
    providerSignal.append(element("span", "provider-glyph", "API"), element("span", "provider-signal-label", "Provider"));
    body.append(providerSignal);
    const identity = element("div", "route-identity");
    identity.append(
      overline("API Provider"),
      namedValue(route.name, route.disambiguator),
      metadata([
        route.wireApi ? `${route.wireApi} API` : null,
        route.localTokens == null ? null : `${formatNumber(route.localTokens)} local tokens`,
      ]),
      stateLine(providerStatusLabel(route.storageState), route.storageState === "ready" ? "ok" : "warning"),
    );
    body.append(identity);
  } else {
    const unknown = element("div", "unknown-signal", "?");
    unknown.setAttribute("aria-hidden", "true");
    body.append(unknown);
    const identity = element("div", "route-identity");
    identity.append(
      overline("Runtime route"),
      element("h2", "route-name", route.label),
      metadata([route.plan]),
      stateLine("Not matched to a saved account or provider", "warning"),
    );
    body.append(identity);
  }

  section.append(body);
  const badges = element("div", "badge-row");
  badges.append(badge(model.sharedHistory.label, model.sharedHistory.enabled ? "linked" : "muted"));
  if (route.kind === "account" && route.quota.freshness) {
    badges.append(badge(freshnessLabel(route.quota.freshness), route.quota.freshness));
  }
  section.append(badges);
  return section;
}

function renderQuotaRing(quota: DashboardQuota): HTMLElement {
  const wrapper = element("div", `quota-ring quota-${quota.status}`);
  const remaining = quota.fiveHour?.remainingPercent ?? null;
  wrapper.setAttribute("role", remaining == null ? "status" : "progressbar");
  wrapper.setAttribute("aria-label", quotaAriaLabel(quota));
  if (remaining != null) {
    wrapper.setAttribute("aria-valuemin", "0");
    wrapper.setAttribute("aria-valuemax", "100");
    wrapper.setAttribute("aria-valuenow", String(remaining));
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 108 108");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  track.setAttribute("class", "quota-track");
  track.setAttribute("cx", "54");
  track.setAttribute("cy", "54");
  track.setAttribute("r", "45");
  const value = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  value.setAttribute("class", "quota-value");
  value.setAttribute("cx", "54");
  value.setAttribute("cy", "54");
  value.setAttribute("r", "45");
  value.setAttribute("pathLength", "100");
  value.setAttribute("stroke-dasharray", `${remaining ?? 0} 100`);
  svg.append(track, value);

  const number = element("strong", "quota-number", remaining == null ? statusSymbol(quota.status) : `${remaining}%`);
  const label = element("span", "quota-label", remaining == null ? shortStatus(quota.status) : "5h left");
  wrapper.append(svg, element("div", "quota-center"));
  const center = wrapper.lastElementChild;
  if (center) center.append(number, label);
  if (quota.refreshing) wrapper.append(element("span", "refresh-indicator", "Refreshing"));
  return wrapper;
}

function renderQuotaSummary(quota: DashboardQuota): HTMLElement {
  const summary = element("div", "quota-summary");
  const status = quotaStatusLabel(quota.status);
  summary.append(stateLine(status, quotaTone(quota.status)));
  if (quota.fiveHour?.resetsAt) {
    summary.append(element("span", "reset-line", `Resets ${formatReset(quota.fiveHour.resetsAt)}`));
  }
  if (quota.secondary) {
    summary.append(element(
      "span",
      "secondary-quota",
      `${quota.secondary.label}: ${quota.secondary.remainingPercent}% left${quota.secondary.resetsAt ? ` · ${formatReset(quota.secondary.resetsAt)}` : ""}`,
    ));
  }
  if (quota.message) summary.append(element("span", "quota-message", quota.message));
  return summary;
}

function renderAutoSwitch(model: DashboardModel): HTMLElement {
  const section = pathSection("Automatic switch", "auto-section");
  const header = element("div", "setting-row");
  const copy = element("div", "setting-copy");
  copy.append(
    element("strong", "setting-title", model.autoSwitch.enabled ? "On" : "Off"),
    element(
      "span",
      "setting-detail",
      model.autoSwitch.appliesToCurrentRoute
        ? model.autoSwitch.ruleLabel
        : model.autoSwitch.enabled ? "Enabled for account mode" : model.autoSwitch.ruleLabel,
    ),
  );
  const toggleLabel = element("label", "switch-control");
  toggleLabel.title = model.autoSwitch.enabled ? "Disable automatic switch" : "Enable automatic switch";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = model.autoSwitch.enabled;
  checkbox.disabled = togglePending;
  checkbox.setAttribute("aria-label", "Automatic account switch");
  checkbox.addEventListener("click", (event) => {
    event.preventDefault();
    if (togglePending) return;
    togglePending = true;
    checkbox.disabled = true;
    postAction("setAutoSwitch", { enabled: !model.autoSwitch.enabled });
  });
  toggleLabel.append(checkbox, element("span", "switch-track"));
  header.append(copy, toggleLabel);
  section.append(header);

  const candidate = model.autoSwitch.candidate;
  if (candidate) {
    const candidateRow = element("div", "candidate-row");
    const candidateText = element("div", "candidate-copy");
    candidateText.append(
      overline("Best cached next account"),
      namedValue(candidate.name, candidate.disambiguator, "candidate-name"),
      metadata([
        `${candidate.remainingPercent}% left`,
        candidate.resetsAt ? `Resets ${formatReset(candidate.resetsAt)}` : null,
        candidate.freshness ? freshnessLabel(candidate.freshness) : null,
      ]),
    );
    candidateRow.append(candidateText, commandButton("Switch", "switchMode", "secondary compact"));
    section.append(candidateRow);
  } else {
    section.append(element("div", "candidate-empty", "No eligible cached account"));
  }

  const controls = element("div", "inline-actions");
  controls.append(commandButton("Switch route", "switchMode", "primary"), commandButton("Settings", "configureAutoSwitch", "secondary"));
  section.append(controls);
  return section;
}

function renderOtherAccounts(model: DashboardModel): HTMLElement {
  const section = pathSection("Other accounts", "accounts-section");
  const count = element("span", "section-count", String(model.otherAccounts.length));
  const heading = section.querySelector(".section-heading");
  if (heading) heading.append(count);
  if (model.otherAccounts.length === 0) {
    const empty = element("div", "empty-row");
    empty.append(element("span", "empty-copy", "No other saved accounts"), commandButton("Add", "addAccount", "secondary compact"));
    section.append(empty);
    return section;
  }
  const list = element("div", "account-list");
  for (const account of model.otherAccounts) list.append(renderAccountRow(account));
  section.append(list);
  return section;
}

function renderAccountRow(account: DashboardAccount): HTMLElement {
  const row = element("div", `account-row status-${account.quota.status}`);
  const top = element("div", "account-row-top");
  const identity = namedValue(account.name, account.disambiguator, "account-name");
  identity.title = account.disambiguator ? `${account.name} (${account.disambiguator})` : account.name;
  const value = element(
    "span",
    "account-quota-value",
    account.quota.fiveHour ? `${account.quota.fiveHour.remainingPercent}%` : shortStatus(account.quota.status),
  );
  top.append(identity, value);
  row.append(top);

  const progress = element("div", `quota-bar${account.quota.fiveHour ? "" : " quota-bar-unknown"}`);
  if (account.quota.fiveHour) {
    const percent = account.quota.fiveHour.remainingPercent;
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `${account.name} five-hour quota`);
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", String(percent));
    const fill = element("span", "quota-bar-fill");
    fill.style.width = `${percent}%`;
    progress.append(fill);
  } else {
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-label", `${account.name} quota ${quotaStatusLabel(account.quota.status)}`);
  }
  row.append(progress);

  const detail = element("div", "account-row-detail");
  detail.append(
    element("span", "account-state", account.quota.message ?? quotaStatusLabel(account.quota.status)),
    element(
      "span",
      "account-meta",
      account.localTokens == null ? "Usage indexing" : `${formatNumber(account.localTokens)} tokens`,
    ),
  );
  row.append(detail);
  if (account.quota.status === "relogin-required") {
    row.append(commandButton("Sign in", "reloginAccount", "link compact", { targetId: account.accountId }));
  } else if (account.quota.status === "storage-locked") {
    row.append(commandButton("Unlock", "unlockStorage", "link compact", { targetId: account.accountId }));
  }
  return row;
}

function renderUsage(model: DashboardModel): HTMLElement {
  const section = pathSection("Local token usage", "usage-section");
  const summary = element("div", "usage-summary");
  const total = element("div", "usage-total");
  total.append(element("strong", "usage-number", model.usage.compactTotal), element("span", "usage-unit", "recorded tokens"));
  summary.append(total, element("span", "usage-sessions", `${model.usage.sessionCount} indexed sessions`));
  section.append(summary);

  const bar = element("div", "usage-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", usageAriaLabel(model.usage.segments, model.usage.unattributedTokens));
  for (const [index, segment] of model.usage.segments.entries()) {
    const fill = element("span", `usage-segment segment-${index % 6}`);
    fill.style.width = `${segment.percent}%`;
    fill.title = `${segment.label}: ${formatNumber(segment.totalTokens)} tokens`;
    bar.append(fill);
  }
  if (model.usage.unattributedTokens > 0) {
    const unattributed = element("span", "usage-segment segment-unattributed");
    const totalTokens = model.usage.total.totalTokens;
    unattributed.style.width = `${totalTokens > 0 ? (model.usage.unattributedTokens / totalTokens) * 100 : 0}%`;
    unattributed.title = `Unattributed: ${formatNumber(model.usage.unattributedTokens)} tokens`;
    bar.append(unattributed);
  }
  section.append(bar);
  if (model.usage.message) section.append(stateLine(model.usage.message, model.usage.status === "indexing" ? "info" : "warning"));

  const details = document.createElement("details");
  details.className = "token-details";
  details.open = tokenDetailsExpanded;
  details.addEventListener("toggle", () => {
    tokenDetailsExpanded = details.open;
    vscode.setState({ tokenDetailsExpanded } satisfies PersistedState);
  });
  const detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "Token details";
  details.append(detailsSummary, renderTokenMetrics(model), renderUsageLegend(model.usage.segments));
  section.append(details);
  return section;
}

function renderTokenMetrics(model: DashboardModel): HTMLElement {
  const metrics = element("dl", "token-metrics");
  const entries: Array<[string, number]> = [
    ["Input", model.usage.total.inputTokens],
    ["Output", model.usage.total.outputTokens],
    ["Cached input", model.usage.total.cachedInputTokens],
    ["Reasoning", model.usage.total.reasoningOutputTokens],
    ["Attributed", model.usage.attributedTokens],
    ["Unattributed", model.usage.unattributedTokens],
  ];
  for (const [label, value] of entries) {
    metrics.append(element("dt", "", label), element("dd", "", formatNumber(value)));
  }
  return metrics;
}

function renderUsageLegend(segments: DashboardUsageSegment[]): HTMLElement {
  const list = element("ul", "usage-legend");
  for (const [index, segment] of segments.entries()) {
    const item = element("li", "legend-row");
    item.append(
      element("span", `legend-swatch segment-${index % 6}`),
      element("span", "legend-label", segment.label),
      element("span", "legend-value", segment.compactTokens),
    );
    item.title = `${segment.label}: ${formatNumber(segment.totalTokens)} tokens across ${segment.sessionCount} sessions`;
    list.append(item);
  }
  return list;
}

function renderActions(model: DashboardModel): HTMLElement {
  const section = element("section", "footer-actions");
  section.setAttribute("aria-label", "Dashboard actions");
  section.append(commandButton("Refresh", "refreshDashboard", "secondary"));
  if (model.savedEntryCounts.accounts === 0) section.append(commandButton("Add account", "addAccount", "secondary"));
  if (model.savedEntryCounts.providers === 0) section.append(commandButton("Add provider", "addProvider", "secondary"));
  return section;
}

function renderReload(model: DashboardModel): HTMLElement {
  const strip = element("aside", "reload-strip");
  strip.setAttribute("role", "status");
  const copy = element("div", "reload-copy");
  copy.append(element("strong", "", "Reload recommended"));
  if (model.reload.message) copy.append(element("span", "", model.reload.message));
  strip.append(copy, commandButton("Reload", "reloadWindow", "primary compact"));
  return strip;
}

function pathSection(title: string, className: string): HTMLElement {
  const section = element("section", `path-section ${className}`);
  section.setAttribute("aria-labelledby", `${className}-heading`);
  const heading = element("h1", "section-heading", title);
  heading.id = `${className}-heading`;
  section.append(heading);
  return section;
}

function commandButton(
  label: string,
  action: DashboardAction,
  className: string,
  payload: Record<string, unknown> = {},
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `command-button ${className}`;
  button.textContent = label;
  button.addEventListener("click", () => postAction(action, payload));
  return button;
}

function postReady(): void {
  vscode.postMessage({ type: "dashboard.ready" });
}

function postAction(action: DashboardAction, payload: Record<string, unknown> = {}): void {
  vscode.postMessage({
    type: "dashboard.action",
    requestId: createRequestId(),
    action,
    ...payload,
  });
}

function createRequestId(): string {
  requestSequence += 1;
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `dashboard-${Date.now()}-${requestSequence}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function overline(text: string): HTMLElement {
  return element("span", "overline", text);
}

function namedValue(name: string, qualifier: string | null, className = "route-name"): HTMLElement {
  const container = element(className === "route-name" ? "h2" : "span", className);
  container.append(document.createTextNode(name));
  if (qualifier) container.append(element("span", "name-qualifier", qualifier));
  return container;
}

function metadata(values: Array<string | null>): HTMLElement {
  const row = element("div", "metadata-row");
  for (const value of values.filter((entry): entry is string => Boolean(entry))) row.append(element("span", "metadata-item", value));
  return row;
}

function badge(text: string, tone: string): HTMLElement {
  return element("span", `status-badge badge-${tone}`, text);
}

function stateLine(text: string, tone: string): HTMLElement {
  const line = element("span", `state-line tone-${tone}`);
  line.append(element("span", "state-dot"), document.createTextNode(text));
  return line;
}

function parsePersistedState(value: unknown): PersistedState {
  if (!value || typeof value !== "object") return { tokenDetailsExpanded: false };
  const expanded = (value as { tokenDetailsExpanded?: unknown }).tokenDetailsExpanded;
  return { tokenDetailsExpanded: expanded === true };
}

function isDashboardHostMessage(value: unknown): value is DashboardHostMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DashboardHostMessage>;
  return candidate.type === "dashboard.state"
    && typeof candidate.revision === "number"
    && Number.isFinite(candidate.revision)
    && Boolean(candidate.state)
    && candidate.state?.version === 1;
}

function quotaStatusLabel(status: DashboardQuotaStatus): string {
  switch (status) {
    case "available": return "Available";
    case "exhausted": return "Exhausted";
    case "loading": return "Loading quota";
    case "no-data": return "Not loaded";
    case "unavailable": return "Unavailable";
    case "relogin-required": return "Sign in required";
    case "storage-locked": return "Storage locked";
    case "storage-pending": return "Waiting for sync";
    case "storage-invalid": return "Invalid saved data";
  }
}

function shortStatus(status: DashboardQuotaStatus): string {
  switch (status) {
    case "relogin-required": return "Sign in";
    case "storage-locked": return "Locked";
    case "storage-pending": return "Pending";
    case "storage-invalid": return "Invalid";
    case "no-data": return "No data";
    default: return quotaStatusLabel(status);
  }
}

function statusSymbol(status: DashboardQuotaStatus): string {
  switch (status) {
    case "loading": return "...";
    case "relogin-required": return "!";
    case "storage-locked": return "L";
    case "storage-pending": return "~";
    case "storage-invalid": return "!";
    default: return "-";
  }
}

function quotaTone(status: DashboardQuotaStatus): string {
  if (status === "available") return "ok";
  if (status === "loading" || status === "no-data") return "info";
  return "warning";
}

function quotaAriaLabel(quota: DashboardQuota): string {
  if (!quota.fiveHour) return quotaStatusLabel(quota.status);
  return `${quota.fiveHour.remainingPercent} percent of five-hour quota remaining`;
}

function providerStatusLabel(status: "ready" | "locked" | "pending" | "invalid" | "unmatched"): string {
  switch (status) {
    case "ready": return "Provider ready · account quota unavailable";
    case "locked": return "Provider storage locked";
    case "pending": return "Waiting for provider sync";
    case "invalid": return "Provider data invalid";
    case "unmatched": return "Provider is not in saved entries";
  }
}

function freshnessLabel(value: "fresh" | "cached" | "stale"): string {
  if (value === "fresh") return "Live quota";
  if (value === "cached") return "Cached quota";
  return "Stale quota";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatReset(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "later";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function usageAriaLabel(segments: DashboardUsageSegment[], unattributed: number): string {
  const parts = segments.map((segment) => `${segment.label} ${formatNumber(segment.totalTokens)} tokens`);
  if (unattributed > 0) parts.push(`unattributed ${formatNumber(unattributed)} tokens`);
  return parts.length > 0 ? `Local token contributions: ${parts.join(", ")}` : "No recorded local token contributions";
}

void currentModel;
