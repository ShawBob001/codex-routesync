import type {
  DashboardAccount,
  DashboardModel,
  DashboardQuota,
  DashboardQuotaFreshness,
  DashboardResetCredits,
  DashboardQuotaStatus,
  DashboardQuotaWindow,
  DashboardUsageSegment,
} from "../src/dashboardModel";
import {
  dashboardLocaleTag,
  DashboardLocaleEnvelope,
  DashboardTranslationKey,
  LanguagePreference,
  SupportedLocale,
  translate,
} from "../src/dashboardI18n";
import type { DashboardAction } from "../src/dashboardProtocol";
import {
  formatResetCountdown,
  formatResetLocalTime,
  formatResetUtcIso,
  getResetCountdown,
} from "../src/dashboardResetTime";

interface VsCodeApi {
  getState(): unknown;
  setState(value: unknown): void;
  postMessage(value: unknown): void;
}

interface DashboardHostMessage {
  type: "dashboard.state";
  revision: number;
  locale: DashboardLocaleEnvelope;
  state: DashboardModel;
}

interface PersistedState { tokenDetailsExpanded: boolean }

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root is unavailable");
const app: HTMLElement = root;
const restored = parsePersistedState(vscode.getState());
let tokenDetailsExpanded = restored.tokenDetailsExpanded;
let locale: SupportedLocale = "en";
let lastRevision = -1;
let togglePending = false;
let requestSequence = 0;
let clockTimer: ReturnType<typeof setTimeout> | null = null;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isDashboardHostMessage(event.data) || event.data.revision <= lastRevision) return;
  lastRevision = event.data.revision;
  locale = event.data.locale.effective;
  togglePending = false;
  applyLocaleShell();
  render(event.data.state, event.data.locale);
});
document.addEventListener("visibilitychange", restartClock);
window.addEventListener("focus", restartClock);
postReady();
renderLoading();

function tr(key: DashboardTranslationKey, args: Record<string, string | number> = {}): string {
  return translate(locale, key, args);
}

function applyLocaleShell(): void {
  document.documentElement.lang = dashboardLocaleTag(locale);
  document.title = tr("dashboard.title");
  const skip = document.querySelector<HTMLAnchorElement>(".skip-link");
  if (skip) skip.textContent = tr("navigation.skipToDashboard");
}

function render(model: DashboardModel, localeEnvelope: DashboardLocaleEnvelope): void {
  const focusKey = captureFocusKey();
  captureTokenDetailsState();
  stopClock();
  const header = renderHeader(model, localeEnvelope);
  const grid = element("div", "dashboard-grid");
  grid.append(renderRoute(model), renderAutoSwitch(model), renderOtherAccounts(model), renderUsage(model));
  app.replaceChildren(header, grid, renderActions(model));
  if (model.reload.recommended) app.append(renderReload(model));
  restoreFocus(focusKey);
  updateResetClocks();
  scheduleClock();
}

function renderLoading(): void {
  const loading = element("div", "loading-state");
  loading.setAttribute("role", "status");
  loading.append(element("span", "loading-mark", "S"), element("span", "", tr("loading.dashboard")));
  app.replaceChildren(loading);
}

function renderHeader(model: DashboardModel, envelope: DashboardLocaleEnvelope): HTMLElement {
  const header = element("header", "dashboard-header");
  const identity = element("div", "brand-lockup");
  identity.append(element("span", "brand-mark", "S"));
  const copy = element("div", "brand-copy");
  copy.append(
    element("h1", "dashboard-title", tr("dashboard.brand")),
    element("p", "dashboard-subtitle", tr(`dashboard.subtitle.${model.route.kind}`)),
  );
  identity.append(copy);
  const controls = element("div", "header-actions");
  controls.append(commandButton(tr("actions.refresh"), "refreshDashboard", "secondary compact", {}, "header-refresh"));
  controls.append(commandButton(tr("actions.switchRoute"), "switchMode", "primary compact", {}, "header-switch-route"));
  const label = element("label", "language-control");
  const caption = element("span", "language-caption", tr("language.label"));
  const select = document.createElement("select");
  select.className = "language-select";
  select.dataset.focusKey = "language-select";
  select.setAttribute("aria-label", tr("language.label"));
  for (const [value, key] of [
    ["auto", "language.auto"],
    ["zh-cn", "language.chinese"],
    ["en", "language.english"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = tr(key);
    select.append(option);
  }
  select.value = envelope.preference;
  select.addEventListener("change", () => {
    const preference = select.value as LanguagePreference;
    postLocale(preference);
    select.value = envelope.preference;
  });
  label.append(caption, select);
  controls.append(label);
  header.append(identity, controls);
  return header;
}

function renderRoute(model: DashboardModel): HTMLElement {
  const section = cardSection(tr("route.current"), "route-section route-card");
  const route = model.route;
  const body = element("div", "route-body");
  if (route.kind === "account") {
    body.append(renderQuotaRing(route.quota));
    const identity = element("div", "route-identity");
    identity.append(
      overline(tr("route.account")),
      namedValue(route.name, localizeDisambiguator(route.disambiguator)),
      metadata([localizeSource(route.source), route.plan, localTokens(route.localTokens)]),
      renderQuotaSummary(route.quota),
    );
    appendQuotaAction(identity, route.accountId, route.quota.status, "route-account");
    body.append(identity);
  } else if (route.kind === "provider") {
    const signal = element("div", "provider-signal");
    signal.setAttribute("role", "img");
    signal.setAttribute("aria-label", tr("route.apiProviderAria"));
    signal.append(element("span", "provider-glyph", "API"), element("span", "provider-signal-label", tr("route.provider")));
    const identity = element("div", "route-identity");
    identity.append(
      overline(tr("route.apiProvider")),
      namedValue(route.name, localizeDisambiguator(route.disambiguator)),
      metadata([localizeSource(route.source), route.wireApi ? tr("metadata.wireApi", { api: route.wireApi }) : null, localTokens(route.localTokens)]),
      stateLine(providerStatusLabel(route.storageState), route.storageState === "ready" ? "ok" : "warning"),
    );
    if (route.providerId && route.storageState === "locked") {
      identity.append(commandButton(
        tr("actions.unlock"),
        "unlockStorage",
        "link compact",
        { targetId: route.providerId },
        `route-provider:${route.providerId}:unlock`,
      ));
    }
    body.append(signal, identity);
  } else {
    const signal = element("div", "unknown-signal", "?");
    signal.setAttribute("aria-hidden", "true");
    const identity = element("div", "route-identity");
    identity.append(
      overline(tr("route.runtime")),
      element("h2", "route-name", tr("route.noActiveSaved")),
      metadata([route.plan]),
      stateLine(tr("route.unmatched"), "warning"),
    );
    body.append(signal, identity);
  }
  section.append(body);
  const badges = element("div", "badge-row");
  badges.append(badge(model.sharedHistory.enabled ? tr("model.sharedHistory") : tr("model.routeSpecificHistory"), model.sharedHistory.enabled ? "linked" : "muted"));
  if (route.kind === "account" && route.quota.freshness) badges.append(badge(freshnessLabel(route.quota.freshness), route.quota.freshness));
  section.append(badges);
  return section;
}

function renderQuotaRing(quota: DashboardQuota): HTMLElement {
  const wrapper = element("div", `quota-ring quota-${quota.status}`);
  const remaining = quota.preferred?.remainingPercent ?? null;
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
  for (const className of ["quota-track", "quota-value"]) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", className);
    circle.setAttribute("cx", "54"); circle.setAttribute("cy", "54"); circle.setAttribute("r", "45");
    if (className === "quota-value") {
      circle.setAttribute("pathLength", "100");
      circle.setAttribute("stroke-dasharray", `${remaining ?? 0} 100`);
    }
    svg.append(circle);
  }
  const center = element("div", "quota-center");
  center.append(
    element("strong", "quota-number", remaining == null ? statusSymbol(quota.status) : `${remaining}%`),
    element("span", "quota-label", remaining == null
      ? shortStatus(quota.status)
      : tr("quota.windowLeft", { window: quotaWindowLabel(quota.preferred) })),
  );
  wrapper.append(svg, center);
  if (quota.refreshing) wrapper.append(element("span", "refresh-indicator", tr("quota.refreshing")));
  return wrapper;
}

function renderQuotaSummary(quota: DashboardQuota): HTMLElement {
  const summary = element("div", "quota-summary");
  summary.append(stateLine(quotaStatusLabel(quota.status), quotaTone(quota.status)));
  for (const window of quota.windows) {
    summary.append(renderResetClock(window, quota.freshness, quota.queriedAt));
  }
  if (quota.windows.length === 0) summary.append(renderResetClock(null, quota.freshness, quota.queriedAt));
  if (quota.resetCredits) summary.append(renderResetCredits(quota.resetCredits));
  const message = localizeModelMessage(quota.message);
  if (message) summary.append(element("span", "quota-message", message));
  return summary;
}

function renderResetCredits(credits: DashboardResetCredits): HTMLElement {
  const row = element("div", "reset-credits");
  row.setAttribute("role", "status");
  const applicable = credits.applicableAvailableCount;
  const label = applicable == null
    ? tr("quota.resetCredits.available", { count: formatNumber(credits.availableCount) })
    : applicable === credits.availableCount
      ? tr("quota.resetCredits.applicable", { count: formatNumber(applicable) })
      : tr("quota.resetCredits.applicableWithTotal", {
          applicable: formatNumber(applicable),
          available: formatNumber(credits.availableCount),
        });
  row.append(element("span", "reset-credits-glyph", "↻"), element("span", "reset-credits-label", label));
  return row;
}

function renderResetClock(
  window: DashboardQuotaWindow | null,
  freshness: DashboardQuotaFreshness,
  queriedAt: string | null,
): HTMLElement {
  const clock = element("div", "reset-clock");
  clock.dataset.resetAt = window?.resetsAt ?? "";
  const heading = element("div", "reset-heading");
  heading.append(
    element("strong", "reset-window", quotaWindowLabel(window)),
    window ? element("span", "reset-percent", tr("quota.remaining", { percent: window.remainingPercent })) : element("span"),
  );
  const countdown = element("span", "reset-countdown");
  countdown.setAttribute("role", "timer");
  countdown.setAttribute("aria-live", "off");
  const local = element("span", "reset-local");
  const utc = element("code", "reset-utc");
  clock.append(heading, countdown, local, utc);
  if (freshness || queriedAt) {
    const metadataLine = element("span", "reset-freshness");
    const parts: string[] = [];
    if (freshness) parts.push(freshnessLabel(freshness));
    if (queriedAt) {
      const checked = formatAbsoluteTime(queriedAt);
      if (checked) parts.push(tr("quota.queriedAt", { time: checked }));
    }
    metadataLine.textContent = parts.join(" · ");
    clock.append(metadataLine);
  }
  updateResetClock(clock);
  return clock;
}

function renderAutoSwitch(model: DashboardModel): HTMLElement {
  const section = cardSection(tr("autoSwitch.title"), "auto-section automation-card");
  const header = element("div", "setting-row");
  const copy = element("div", "setting-copy");
  copy.append(
    element("strong", "setting-title", model.autoSwitch.enabled ? tr("autoSwitch.on") : tr("autoSwitch.off")),
    element("span", "setting-detail", model.autoSwitch.appliesToCurrentRoute
      ? tr("autoSwitch.ruleAtZero")
      : model.autoSwitch.enabled ? tr("autoSwitch.enabledForAccountMode") : tr("autoSwitch.ruleAtZero")),
  );
  const label = element("label", "switch-control");
  label.title = model.autoSwitch.enabled ? tr("autoSwitch.disableTooltip") : tr("autoSwitch.enableTooltip");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox"; checkbox.checked = model.autoSwitch.enabled; checkbox.disabled = togglePending;
  checkbox.dataset.focusKey = "auto-switch-toggle";
  checkbox.setAttribute("aria-label", tr("autoSwitch.aria"));
  checkbox.addEventListener("click", (event) => {
    event.preventDefault();
    if (togglePending) return;
    togglePending = true; checkbox.disabled = true;
    postAction("setAutoSwitch", { enabled: !model.autoSwitch.enabled });
  });
  label.append(checkbox, element("span", "switch-track"));
  header.append(copy, label); section.append(header);
  const candidate = model.autoSwitch.candidate;
  if (candidate) {
    const row = element("div", "candidate-row");
    const candidateCopy = element("div", "candidate-copy");
    candidateCopy.append(overline(tr("autoSwitch.bestCandidate")), namedValue(candidate.name, localizeDisambiguator(candidate.disambiguator), "candidate-name"));
    candidateCopy.append(renderResetClock({
      label: "5h",
      scope: "base",
      name: null,
      remainingPercent: candidate.remainingPercent,
      resetsAt: candidate.resetsAt,
      windowSeconds: 18_000,
    }, candidate.freshness, null));
    row.append(candidateCopy, commandButton(tr("actions.switch"), "switchMode", "secondary compact", {}, "candidate-switch"));
    section.append(row);
  } else section.append(element("div", "candidate-empty", tr("autoSwitch.noCandidate")));
  const controls = element("div", "inline-actions");
  controls.append(
    commandButton(tr("actions.switchRoute"), "switchMode", "primary", {}, "automation-switch-route"),
    commandButton(tr("actions.settings"), "configureAutoSwitch", "secondary", {}, "automation-settings"),
  );
  section.append(controls);
  return section;
}

function renderOtherAccounts(model: DashboardModel): HTMLElement {
  const section = cardSection(tr("accounts.other"), "accounts-section accounts-card");
  const count = element("span", "section-count", String(model.otherAccounts.length));
  section.querySelector(".section-heading")?.append(count);
  if (model.otherAccounts.length === 0) {
    const empty = element("div", "empty-row");
    empty.append(
      element("span", "empty-copy", tr("accounts.none")),
      commandButton(tr("actions.add"), "addAccount", "secondary compact", {}, "accounts-empty-add"),
    );
    section.append(empty);
    return section;
  }
  const list = element("div", "account-list");
  for (const account of model.otherAccounts) list.append(renderAccountCard(account));
  section.append(list);
  return section;
}

function renderAccountCard(account: DashboardAccount): HTMLElement {
  const row = element("article", `account-row status-${account.quota.status}`);
  const top = element("div", "account-row-top");
  const identity = namedValue(account.name, localizeDisambiguator(account.disambiguator), "account-name");
  identity.title = account.name;
  top.append(identity, element("span", "account-quota-value", account.quota.preferred
    ? tr("quota.remaining", { percent: account.quota.preferred.remainingPercent })
    : shortStatus(account.quota.status)));
  row.append(top);
  const progress = element("div", `quota-bar${account.quota.preferred ? "" : " quota-bar-unknown"}`);
  if (account.quota.preferred) {
    const percent = account.quota.preferred.remainingPercent;
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", tr("quota.accountWindowAria", {
      account: account.name,
      window: quotaWindowLabel(account.quota.preferred),
    }));
    progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100"); progress.setAttribute("aria-valuenow", String(percent));
    const fill = element("span", "quota-bar-fill"); fill.style.width = `${percent}%`; progress.append(fill);
  } else {
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-label", tr("quota.accountStatusAria", { account: account.name, status: quotaStatusLabel(account.quota.status) }));
  }
  row.append(progress);
  const detail = element("div", "account-row-detail");
  detail.append(element("span", "account-state", localizeModelMessage(account.quota.message) ?? quotaStatusLabel(account.quota.status)), element("span", "account-meta", localTokens(account.localTokens) ?? tr("usage.indexing")));
  row.append(detail);
  for (const window of account.quota.windows) {
    row.append(renderResetClock(window, account.quota.freshness, account.quota.queriedAt));
  }
  if (account.quota.windows.length === 0) {
    row.append(renderResetClock(null, account.quota.freshness, account.quota.queriedAt));
  }
  if (account.quota.resetCredits) row.append(renderResetCredits(account.quota.resetCredits));
  appendQuotaAction(row, account.accountId, account.quota.status, "other-account");
  return row;
}

function renderUsage(model: DashboardModel): HTMLElement {
  const section = cardSection(tr("usage.title"), "usage-section usage-card");
  const summary = element("div", "usage-summary");
  const total = element("div", "usage-total");
  total.append(element("strong", "usage-number", model.usage.compactTotal), element("span", "usage-unit", tr("usage.recordedTokens")));
  summary.append(total, element("span", "usage-sessions", tr("usage.indexedSessions", { count: formatNumber(model.usage.sessionCount) })));
  section.append(summary);
  const bar = element("div", "usage-bar");
  bar.setAttribute("role", "img"); bar.setAttribute("aria-label", usageAriaLabel(model.usage.segments, model.usage.unattributedTokens));
  for (const [index, segment] of model.usage.segments.entries()) {
    const fill = element("span", `usage-segment segment-${index % 6}`); fill.style.width = `${segment.percent}%`;
    fill.title = tr("usage.segmentTooltip", { label: segment.label, tokens: formatNumber(segment.totalTokens) }); bar.append(fill);
  }
  if (model.usage.unattributedTokens > 0) {
    const fill = element("span", "usage-segment segment-unattributed");
    fill.style.width = `${model.usage.total.totalTokens > 0 ? (model.usage.unattributedTokens / model.usage.total.totalTokens) * 100 : 0}%`;
    fill.title = tr("usage.unattributedTooltip", { tokens: formatNumber(model.usage.unattributedTokens) }); bar.append(fill);
  }
  section.append(bar);
  const message = localizeModelMessage(model.usage.message);
  if (message) section.append(stateLine(message, model.usage.status === "indexing" ? "info" : "warning"));
  const details = document.createElement("details"); details.className = "token-details"; details.open = tokenDetailsExpanded;
  details.addEventListener("toggle", () => { tokenDetailsExpanded = details.open; vscode.setState({ tokenDetailsExpanded } satisfies PersistedState); });
  const detailsSummary = document.createElement("summary"); detailsSummary.textContent = tr("usage.details"); detailsSummary.dataset.focusKey = "usage-details";
  details.append(detailsSummary, renderTokenMetrics(model), renderUsageLegend(model.usage.segments)); section.append(details);
  return section;
}

function renderTokenMetrics(model: DashboardModel): HTMLElement {
  const metrics = element("dl", "token-metrics");
  const entries: Array<[DashboardTranslationKey, number]> = [
    ["usage.metric.input", model.usage.total.inputTokens], ["usage.metric.output", model.usage.total.outputTokens],
    ["usage.metric.cachedInput", model.usage.total.cachedInputTokens], ["usage.metric.reasoning", model.usage.total.reasoningOutputTokens],
    ["usage.metric.attributed", model.usage.attributedTokens], ["usage.metric.unattributed", model.usage.unattributedTokens],
  ];
  for (const [key, value] of entries) metrics.append(element("dt", "", tr(key)), element("dd", "", formatNumber(value)));
  return metrics;
}

function renderUsageLegend(segments: DashboardUsageSegment[]): HTMLElement {
  const list = element("ul", "usage-legend");
  for (const [index, segment] of segments.entries()) {
    const item = element("li", "legend-row");
    item.append(element("span", `legend-swatch segment-${index % 6}`), element("span", "legend-label", segment.label), element("span", "legend-value", segment.compactTokens));
    item.title = tr("usage.legendTooltip", { label: segment.label, tokens: formatNumber(segment.totalTokens), sessions: formatNumber(segment.sessionCount) }); list.append(item);
  }
  return list;
}

function renderActions(model: DashboardModel): HTMLElement {
  const section = element("section", "footer-actions"); section.setAttribute("aria-label", tr("actions.dashboardAria"));
  if (model.savedEntryCounts.accounts === 0) section.append(commandButton(tr("actions.addAccount"), "addAccount", "secondary", {}, "footer-add-account"));
  if (model.savedEntryCounts.providers === 0) section.append(commandButton(tr("actions.addProvider"), "addProvider", "secondary", {}, "footer-add-provider"));
  return section;
}

function renderReload(model: DashboardModel): HTMLElement {
  const strip = element("aside", "reload-strip"); strip.setAttribute("role", "status");
  const copy = element("div", "reload-copy"); copy.append(element("strong", "", tr("reload.recommended")));
  const message = localizeReloadMessage(model.reload.message); if (message) copy.append(element("span", "", message));
  strip.append(copy, commandButton(tr("actions.reload"), "reloadWindow", "primary compact", {}, "reload-window")); return strip;
}

function cardSection(title: string, className: string): HTMLElement {
  const section = element("section", `dashboard-card ${className}`); const id = `${className.split(" ")[0]}-heading`;
  section.setAttribute("aria-labelledby", id); const heading = element("h2", "section-heading", title); heading.id = id; section.append(heading); return section;
}

function commandButton(
  label: string,
  action: DashboardAction,
  className: string,
  payload: Record<string, unknown>,
  focusKey: string,
): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button"; button.className = `command-button ${className}`; button.textContent = label;
  button.dataset.focusKey = focusKey;
  button.addEventListener("click", () => postAction(action, payload)); return button;
}

function appendQuotaAction(
  parent: HTMLElement,
  targetId: string | null,
  status: DashboardQuotaStatus,
  focusScope: "route-account" | "other-account",
): void {
  if (!targetId) return;
  if (status === "relogin-required") {
    parent.append(commandButton(
      tr("actions.signIn"),
      "reloginAccount",
      "link compact",
      { targetId },
      `${focusScope}:${targetId}:relogin`,
    ));
  } else if (status === "storage-locked") {
    parent.append(commandButton(
      tr("actions.unlock"),
      "unlockStorage",
      "link compact",
      { targetId },
      `${focusScope}:${targetId}:unlock`,
    ));
  }
}

function postReady(): void { vscode.postMessage({ type: "dashboard.ready" }); }
function postLocale(preference: LanguagePreference): void { vscode.postMessage({ type: "dashboard.locale.set", requestId: createRequestId(), preference }); }
function postAction(action: DashboardAction, payload: Record<string, unknown> = {}): void {
  vscode.postMessage({ type: "dashboard.action", requestId: createRequestId(), action, ...payload });
}
function createRequestId(): string {
  requestSequence += 1; const cryptoApi = globalThis.crypto;
  return cryptoApi?.randomUUID ? cryptoApi.randomUUID() : `dashboard-${Date.now()}-${requestSequence}`;
}

function updateResetClocks(): void { document.querySelectorAll<HTMLElement>(".reset-clock").forEach(updateResetClock); }
function updateResetClock(clock: HTMLElement): void {
  const resetsAt = clock.dataset.resetAt || null;
  const state = getResetCountdown(resetsAt, Date.now());
  const countdown = clock.querySelector<HTMLElement>(".reset-countdown");
  const localNode = clock.querySelector<HTMLElement>(".reset-local");
  const utcNode = clock.querySelector<HTMLElement>(".reset-utc");
  if (!countdown || !localNode || !utcNode) return;
  if (state.kind === "scheduled") {
    const formatted = formatResetCountdown(state, locale);
    countdown.textContent = tr("quota.reset.countdown", { time: formatted ?? "" });
    countdown.dataset.state = "scheduled";
  } else {
    countdown.textContent = tr(state.kind === "due" ? "quota.reset.due" : "quota.reset.unavailable");
    countdown.dataset.state = state.kind;
  }
  const localTime = formatResetLocalTime(resetsAt, locale);
  const utcTime = formatResetUtcIso(resetsAt);
  localNode.textContent = localTime ? tr("quota.reset.local", { time: localTime }) : "";
  utcNode.textContent = utcTime ? tr("quota.reset.utc", { time: utcTime }) : "";
  localNode.hidden = !localTime; utcNode.hidden = !utcTime;
}
function scheduleClock(): void {
  stopClock(); if (document.hidden || document.querySelector(".reset-clock") == null) return;
  const delay = Math.max(25, 1_000 - (Date.now() % 1_000) + 5);
  clockTimer = setTimeout(() => { clockTimer = null; updateResetClocks(); scheduleClock(); }, delay);
}
function stopClock(): void { if (clockTimer != null) clearTimeout(clockTimer); clockTimer = null; }
function restartClock(): void { stopClock(); if (!document.hidden) { updateResetClocks(); scheduleClock(); } }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}
function overline(text: string): HTMLElement { return element("span", "overline", text); }
function namedValue(name: string, qualifier: string | null, className = "route-name"): HTMLElement {
  const node = element(className === "route-name" ? "h3" : "span", className); node.append(document.createTextNode(name));
  if (qualifier) node.append(element("span", "name-qualifier", qualifier)); return node;
}
function metadata(values: Array<string | null>): HTMLElement {
  const row = element("div", "metadata-row"); for (const value of values.filter((entry): entry is string => Boolean(entry))) row.append(element("span", "metadata-item", value)); return row;
}
function badge(text: string, tone: string): HTMLElement { return element("span", `status-badge badge-${tone}`, text); }
function stateLine(text: string, tone: string): HTMLElement {
  const line = element("span", `state-line tone-${tone}`); line.append(element("span", "state-dot"), document.createTextNode(text)); return line;
}
function parsePersistedState(value: unknown): PersistedState {
  if (!value || typeof value !== "object") return { tokenDetailsExpanded: false };
  return { tokenDetailsExpanded: (value as { tokenDetailsExpanded?: unknown }).tokenDetailsExpanded === true };
}
function isDashboardHostMessage(value: unknown): value is DashboardHostMessage {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["type", "revision", "locale", "state"])) return false;
  const candidate = value as Partial<DashboardHostMessage>;
  if (candidate.type !== "dashboard.state" || !Number.isSafeInteger(candidate.revision) || candidate.state?.version !== 1) return false;
  const envelope = candidate.locale;
  return isPlainRecord(envelope)
    && hasExactKeys(envelope, ["preference", "effective"])
    && (envelope?.preference === "auto" || envelope?.preference === "en" || envelope?.preference === "zh-cn")
    && (envelope?.effective === "en" || envelope?.effective === "zh-cn");
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function captureFocusKey(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !app.contains(active)) return null;
  return active.dataset.focusKey ?? null;
}

function captureTokenDetailsState(): void {
  const details = app.querySelector<HTMLDetailsElement>(".token-details");
  if (!details) return;
  tokenDetailsExpanded = details.open;
  vscode.setState({ tokenDetailsExpanded } satisfies PersistedState);
}

function restoreFocus(focusKey: string | null): void {
  if (!focusKey) return;
  const matches = Array.from(app.querySelectorAll<HTMLElement>("[data-focus-key]"))
    .filter((node) => node.dataset.focusKey === focusKey);
  if (matches.length === 1) matches[0].focus({ preventScroll: true });
}

function quotaWindowLabel(window: DashboardQuotaWindow | null): string {
  if (!window) return tr("quota.window.default");
  const duration = quotaWindowDurationLabel(window);
  if (window.scope === "additional" && window.name) {
    return tr("quota.window.additional", { name: window.name, window: duration });
  }
  if (window.scope === "code-review") {
    return tr("quota.window.codeReview", { window: duration });
  }
  return duration;
}

function quotaWindowDurationLabel(window: DashboardQuotaWindow): string {
  const seconds = window.windowSeconds;
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return window.label || tr("quota.window.default");
  if (seconds === 18_000) return tr("quota.window.fiveHour");
  if (seconds === 604_800) return tr("quota.window.sevenDay");
  if (seconds % 86_400 === 0) {
    return tr("quota.window.days", { count: formatNumber(seconds / 86_400) });
  }
  if (seconds % 3_600 === 0) {
    return tr("quota.window.hours", { count: formatNumber(seconds / 3_600) });
  }
  if (seconds % 60 === 0) {
    return tr("quota.window.minutes", { count: formatNumber(seconds / 60) });
  }
  return tr("quota.window.seconds", { count: formatNumber(seconds) });
}

const quotaStatusKeys: Record<DashboardQuotaStatus, DashboardTranslationKey> = {
  available: "quota.status.available", exhausted: "quota.status.exhausted", loading: "quota.status.loading", "no-data": "quota.status.noData",
  unavailable: "quota.status.unavailable", "relogin-required": "quota.status.reloginRequired", "storage-locked": "quota.status.storageLocked",
  "storage-pending": "quota.status.storagePending", "storage-invalid": "quota.status.storageInvalid",
};
function quotaStatusLabel(status: DashboardQuotaStatus): string { return tr(quotaStatusKeys[status]); }
function shortStatus(status: DashboardQuotaStatus): string {
  const key: Partial<Record<DashboardQuotaStatus, DashboardTranslationKey>> = {
    "relogin-required": "quota.short.signIn", "storage-locked": "quota.short.locked", "storage-pending": "quota.short.pending",
    "storage-invalid": "quota.short.invalid", "no-data": "quota.short.noData",
  };
  return key[status] ? tr(key[status]!) : quotaStatusLabel(status);
}
function statusSymbol(status: DashboardQuotaStatus): string {
  if (status === "loading") return "…"; if (status === "storage-locked") return "◈"; if (status === "storage-pending") return "~";
  if (status === "relogin-required" || status === "storage-invalid") return "!"; return "–";
}
function quotaTone(status: DashboardQuotaStatus): string { return status === "available" ? "ok" : status === "loading" || status === "no-data" ? "info" : "warning"; }
function quotaAriaLabel(quota: DashboardQuota): string {
  return quota.preferred
    ? tr("quota.remainingAria", {
        window: quotaWindowLabel(quota.preferred),
        percent: quota.preferred.remainingPercent,
      })
    : quotaStatusLabel(quota.status);
}
function providerStatusLabel(status: "ready" | "locked" | "pending" | "invalid" | "unmatched"): string {
  return tr({ ready: "provider.ready", locked: "provider.locked", pending: "provider.pending", invalid: "provider.invalid", unmatched: "provider.unmatched" }[status] as DashboardTranslationKey);
}
function freshnessLabel(value: Exclude<DashboardQuotaFreshness, null>): string {
  return tr({ fresh: "quota.freshness.fresh", cached: "quota.freshness.cached", stale: "quota.freshness.stale" }[value] as DashboardTranslationKey);
}
function formatNumber(value: number): string { return new Intl.NumberFormat(dashboardLocaleTag(locale)).format(value); }
function formatAbsoluteTime(value: string): string | null {
  const epoch = Date.parse(value); if (!Number.isFinite(epoch)) return null;
  return new Intl.DateTimeFormat(dashboardLocaleTag(locale), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset" }).format(new Date(epoch));
}
function localTokens(value: number | null): string | null { return value == null ? null : tr("metadata.localTokens", { tokens: formatNumber(value) }); }
function localizeSource(value: "local" | "cloud" | null): string | null { return value === "local" ? tr("source.local") : value === "cloud" ? tr("source.cloud") : null; }
function localizeDisambiguator(value: "Local" | "Cloud" | null): string | null { return value === "Local" ? tr("source.local") : value === "Cloud" ? tr("source.cloud") : null; }

const modelMessages: Record<string, DashboardTranslationKey> = {
  "Saved account is unavailable.": "model.savedAccountUnavailable", "Unlock storage to view quota.": "model.unlockStorageForQuota",
  "Waiting for synced storage.": "model.waitingForSyncedStorage", "Saved account data is invalid.": "model.savedAccountInvalid",
  "Sign in again to refresh quota.": "model.signInAgain", "Quota has not been loaded yet.": "model.quotaNotLoaded",
  "Refreshing quota...": "model.refreshingQuota", "Quota is unavailable.": "model.quotaUnavailable",
  "Quota refresh failed. Showing the last known value.": "model.quotaRefreshFailed", "A five-hour quota window is unavailable.": "model.fiveHourUnavailable",
  "Five-hour quota is exhausted.": "model.fiveHourExhausted", "Indexing local Codex sessions...": "model.indexingSessions",
  "A usable quota window is unavailable.": "model.windowUnavailable", "The selected quota window is exhausted.": "model.windowExhausted",
  "Waiting to index local Codex sessions.": "model.waitingToIndexSessions", "Some local sessions could not be indexed.": "model.partialIndex",
};
function localizeModelMessage(message: string | null): string | null { return message == null ? null : modelMessages[message] ? tr(modelMessages[message]) : message; }
function localizeReloadMessage(message: string | null): string | null {
  if (!message) return null;
  const switched = /^Switched to (account|mode) "([\s\S]+)"\. Reload so Codex picks up the new configuration\.$/.exec(message);
  if (switched) return tr("reload.afterSwitch", {
    kind: tr(switched[1] === "account" ? "reload.kind.account" : "reload.kind.mode"),
    label: switched[2],
  });
  const repaired = /^History repair updated (\d+) rollout record\(s\) and (\d+) thread record\(s\)\.$/.exec(message);
  if (repaired) return tr("reload.afterHistoryRepair", { rollouts: repaired[1], threads: repaired[2] });
  return message;
}
function usageAriaLabel(segments: DashboardUsageSegment[], unattributed: number): string {
  const parts = segments.map((segment) => tr("usage.contributionPart", { label: segment.label, tokens: formatNumber(segment.totalTokens) }));
  if (unattributed > 0) parts.push(tr("usage.unattributedPart", { tokens: formatNumber(unattributed) }));
  return parts.length > 0 ? tr("usage.contributionsAria", { parts: parts.join(", ") }) : tr("usage.noContributionsAria");
}
