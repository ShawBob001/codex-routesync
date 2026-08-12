import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";

const STATE_KEY = "codexSwitchBridge.localTokenUsage.v2";
const STATE_VERSION = 2;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 4 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_INACTIVE_GAP_MS = 3 * DEFAULT_HEARTBEAT_MS;
const TOKEN_COUNT_MARKER = Buffer.from('"token_count"');
const SESSION_META_MARKER = Buffer.from('"session_meta"');
const LOCK_STALE_MS = 30_000;
const LOCK_RENEW_MS = 2_000;
const MAX_PERSISTED_FILES_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_FILES_BYTES = 32 * 1024 * 1024;

export type UsageSubjectKind = "account" | "provider";

export interface UsageSubject {
  id: string;
  kind: UsageSubjectKind;
  label: string;
  legacyProviderIds?: readonly string[];
}

export interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface SubjectTokenUsage extends UsageSubject {
  sessionCount: number;
  tokens: TokenTotals;
}

export interface DailySubjectTokenUsage {
  id: string;
  tokens: TokenTotals;
  estimated: TokenTotals;
}

export interface DailyTokenUsage {
  date: string;
  total: TokenTotals;
  unattributed: TokenTotals;
  estimated: TokenTotals;
  estimatedUnattributed: TokenTotals;
  subjects: DailySubjectTokenUsage[];
}

export interface UsageHistory {
  days: DailyTokenUsage[];
  undated: TokenTotals;
}

export interface UsageSnapshot {
  updatedAt: number;
  trackingStartedAt: number | null;
  status: "uninitialized" | "indexing" | "ready";
  coverage: "complete" | "partial";
  lastError: string | null;
  sessionCount: number;
  total: TokenTotals;
  unattributed: TokenTotals;
  subjects: SubjectTokenUsage[];
  history: UsageHistory;
  scan: {
    discoveredFiles: number;
    rescannedFiles: number;
    reusedFiles: number;
    errors: number;
    bytesRead: number;
    chunksRead: number;
  };
}

/** Pass a device-local memento. Do not register this service's key with Settings Sync. */
export interface LocalUsageMemento {
  get<T>(key: string): T | undefined | PromiseLike<T | undefined>;
  update(key: string, value: unknown): void | PromiseLike<void>;
}

export interface UsageServiceOptions {
  codexHome: string;
  memento: LocalUsageMemento;
  knownSubjects?: readonly UsageSubject[];
  now?: () => number;
  heartbeatIntervalMs?: number;
  inactiveGapMs?: number;
}

export interface RecordSelectionOptions {
  at?: number;
}

export interface Disposable {
  dispose(): void;
}

interface Fingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface SessionUsageRecord {
  fingerprint: Fingerprint;
  threadKey: string;
  startedAt: number;
  observedAt: number;
  legacyProviderKey: string | null;
  openAiProvider: boolean;
  historicalSubjectId: string | null;
  historicalAttributionLocked: boolean;
  inheritedBaseline: TokenTotals;
  lastCumulative: TokenTotals;
  historicalTokens: TokenTotals;
  increments: UsageIncrement[];
  appendOffset: number;
  appendGuard: string;
  timelineTracked: boolean;
  tokens: TokenTotals;
}

interface UsageIncrement {
  at: number | null;
  tokens: TokenTotals;
}

interface SelectionInterval {
  at: number;
  activeUntil: number;
  subjectId: string | null;
}

interface PersistedSubject {
  id: string;
  kind: UsageSubjectKind;
  retired: boolean;
}

interface SubjectRetirement {
  from: string;
  to: string;
  at: number;
  legacyProviderKeys: string[];
  unattributedProviderKeys: string[];
}

interface SubjectRemapDecision {
  to: string | null;
  at: number;
  nonce: string;
}

interface PersistedState {
  version: 2;
  homeKey: string;
  initializedAt: number;
  files: Record<string, SessionUsageRecord>;
  timeline: SelectionInterval[];
  subjects: PersistedSubject[];
  remaps: Record<string, SubjectRemapDecision>;
  retirements: SubjectRetirement[];
}

interface SessionMeta {
  threadKey: string;
  startedAt: number;
  legacyProviderKey: string | null;
  openAiProvider: boolean;
}

interface ParsedTokenCount {
  observedAt: number | null;
  tokens: TokenTotals;
}

interface JsonRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface ReadMetrics {
  bytesRead: number;
  chunksRead: number;
}

interface ProcessLock {
  isOwned(): Promise<boolean>;
  release(): Promise<void>;
}

const EMPTY_TOKENS: Readonly<TokenTotals> = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

/**
 * Creates an opaque, deterministic ID from a stable account ID or provider key.
 * The source identity is not recoverable from the returned value.
 */
export function stableSubjectId(kind: UsageSubjectKind, identity: string): string {
  const normalized = identity.trim();
  if (!normalized) throw new Error("A non-empty subject identity is required");
  return `${kind}:${digest(`${kind}\0${normalized}`)}`;
}

/** Formats token counts for compact tree labels without changing the raw snapshot values. */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  const rounded = Math.floor(value);
  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (rounded >= unit.threshold) {
      const scaled = rounded / unit.threshold;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      const displayed = Number(scaled.toFixed(digits));
      if (displayed >= 1_000 && index > 0) {
        const larger = units[index - 1];
        return `${Number((rounded / larger.threshold).toFixed(2))}${larger.suffix}`;
      }
      return `${displayed}${unit.suffix}`;
    }
  }
  return String(rounded);
}

export class UsageService {
  private readonly codexHome: string;
  private readonly memento: LocalUsageMemento;
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly inactiveGapMs: number;
  private readonly homeKey: string;
  private readonly stateKey: string;
  private readonly lockDirectory: string;
  private readonly knownSubjects = new Map<string, UsageSubject>();
  private readonly listeners = new Set<(snapshot: UsageSnapshot) => void>();

  private initializedAt = 0;
  private files: Record<string, SessionUsageRecord> = {};
  private timeline: SelectionInterval[] = [];
  private persistedSubjects = new Map<string, UsageSubjectKind>();
  private retiredSubjects = new Set<string>();
  private remaps: Record<string, string> = {};
  private remapDecisions: Record<string, SubjectRemapDecision> = {};
  private lastRemapDecisionAt = 0;
  private retirements: SubjectRetirement[] = [];
  private currentSelection: UsageSubject | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private loaded = false;
  private disposed = false;
  private initializePromise: Promise<UsageSnapshot> | undefined;
  private loadPromise: Promise<void> | undefined;
  private refreshTail: Promise<void> = Promise.resolve();
  private snapshot: UsageSnapshot = emptySnapshot();

  constructor(options: UsageServiceOptions) {
    this.codexHome = path.resolve(options.codexHome);
    this.memento = options.memento;
    this.now = options.now ?? Date.now;
    this.heartbeatIntervalMs = normalizeDuration(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_MS,
      true,
    );
    this.inactiveGapMs = normalizeDuration(
      options.inactiveGapMs,
      Math.max(DEFAULT_INACTIVE_GAP_MS, this.heartbeatIntervalMs * 3),
      false,
    );
    this.homeKey = digest(this.codexHome);
    this.stateKey = `${STATE_KEY}.${this.homeKey}`;
    this.lockDirectory = path.join(
      tmpdir(),
      `codex-switchbridge-token-usage-${this.homeKey}.lock`,
    );
    for (const subject of options.knownSubjects ?? []) this.rememberSubject(subject);
  }

  initialize(): Promise<UsageSnapshot> {
    this.assertActive();
    if (!this.initializePromise) {
      this.initializePromise = this.load().then(() => this.queueRefresh());
    }
    return this.initializePromise;
  }

  async refresh(): Promise<UsageSnapshot> {
    this.assertActive();
    if (!this.loaded) return this.initialize();
    return this.queueRefresh();
  }

  async recordSelection(
    selection: UsageSubject | null,
    options: RecordSelectionOptions = {},
  ): Promise<void> {
    this.assertActive();
    await this.ensureLoaded();
    const requestedAt = validTimestamp(options.at) ?? this.now();
    const subject = selection ? sanitizeSubject(selection) : null;
    if (subject) this.rememberSubject(subject);
    const subjectId = subject ? this.resolveSubjectId(subject.id) : null;
    const last = this.timeline[this.timeline.length - 1];
    const at = Math.max(requestedAt, last?.at ?? requestedAt);

    if (last && last.subjectId === null && subjectId === null) {
      last.activeUntil = Math.max(last.activeUntil, at);
    } else if (last && last.subjectId === subjectId && at <= last.activeUntil) {
      last.activeUntil = Math.max(last.activeUntil, at + this.inactiveGapMs);
    } else {
      this.timeline.push({
        at,
        activeUntil: subjectId ? at + this.inactiveGapMs : at,
        subjectId,
      });
    }
    this.currentSelection = subject;
    this.configureHeartbeat();
    this.rebuildSnapshot(this.snapshot.scan);
    await this.persist();
  }

  async remapSubject(fromSubjectId: string, toSubject: UsageSubject): Promise<void> {
    this.assertActive();
    await this.ensureLoaded();
    const cleanFrom = fromSubjectId.trim();
    if (!isSubjectId(cleanFrom)) {
      throw new Error("Usage subject IDs must be created with stableSubjectId");
    }
    const from = this.resolveSubjectId(cleanFrom);
    const source = this.knownSubjects.get(from);
    const legacyMap = this.createLegacySubjectMap();
    const target = sanitizeSubject(toSubject);
    if (this.remaps[target.id]) {
      this.materializeActiveRemaps();
      this.setRemapDecision(target.id, null);
    }
    this.rememberSubject(target);
    const to = this.resolveSubjectId(target.id);
    if (!from || from === to) return;

    const currentWasFrom = Boolean(
      this.currentSelection && this.resolveSubjectId(this.currentSelection.id) === from,
    );
    for (const interval of this.timeline) {
      if (this.resolveSubjectId(interval.subjectId) === from) interval.subjectId = to;
    }
    for (const record of Object.values(this.files)) {
      const legacySubject = record.legacyProviderKey
        ? legacyMap.get(record.legacyProviderKey)
        : undefined;
      if (
        (record.historicalSubjectId && this.resolveSubjectId(record.historicalSubjectId) === from)
        || (legacySubject && this.resolveSubjectId(legacySubject) === from)
      ) {
        record.historicalSubjectId = to;
        record.historicalAttributionLocked = true;
      }
    }
    this.setRemapDecision(from, to);
    const targetKnown = this.knownSubjects.get(to) ?? { ...target, id: to };
    const legacyProviderIds = mergeLegacyProviderIds(source, targetKnown);
    this.knownSubjects.delete(from);
    this.knownSubjects.set(to, {
      ...targetKnown,
      id: to,
      ...(legacyProviderIds.length > 0 ? { legacyProviderIds } : {}),
    });
    const oldKind = this.persistedSubjects.get(from);
    if (oldKind) this.persistedSubjects.delete(from);
    this.persistedSubjects.set(to, target.kind);
    if (currentWasFrom) this.currentSelection = target;
    this.rebuildSnapshot(this.snapshot.scan);
    await this.persist();
  }

  async retireSubject(subjectId: string): Promise<string> {
    this.assertActive();
    await this.ensureLoaded();
    const cleanId = subjectId.trim();
    if (!isSubjectId(cleanId)) {
      throw new Error("Usage subject IDs must be created with stableSubjectId");
    }
    const from = this.resolveSubjectId(cleanId);
    const currentWasFrom = Boolean(
      this.currentSelection && this.resolveSubjectId(this.currentSelection.id) === from,
    );
    const existing = this.knownSubjects.get(from);
    const kind = existing?.kind ?? this.persistedSubjects.get(from) ?? kindFromId(from);
    let retiredId: string;
    do {
      retiredId = stableSubjectId(kind, `retired:${randomBytes(16).toString("hex")}`);
    } while (this.persistedSubjects.has(retiredId));

    const retiredAt = Math.max(this.now(), this.timeline[this.timeline.length - 1]?.at ?? 0);
    for (const interval of this.timeline) {
      if (interval.at <= retiredAt && this.resolveSubjectId(interval.subjectId) === from) {
        interval.subjectId = retiredId;
      }
    }
    const legacyCandidates = new Set(
      (existing?.legacyProviderIds ?? []).map(providerKey).filter((key): key is string => Boolean(key)),
    );
    const legacyMap = this.createLegacySubjectMap();
    const legacyKeys = new Set<string>();
    const unattributedKeys = new Set<string>();
    for (const key of legacyCandidates) {
      const mapped = legacyMap.get(key);
      if (mapped && this.resolveSubjectId(mapped) === from) {
        legacyKeys.add(key);
      } else {
        unattributedKeys.add(key);
      }
    }
    this.retirements.push({
      from,
      to: retiredId,
      at: retiredAt,
      legacyProviderKeys: [...legacyKeys],
      unattributedProviderKeys: [...unattributedKeys],
    });
    for (const record of Object.values(this.files)) {
      if (record.historicalSubjectId === from || Boolean(
        record.legacyProviderKey && legacyKeys.has(record.legacyProviderKey),
      )) {
        record.historicalSubjectId = retiredId;
        record.historicalAttributionLocked = true;
      } else if (
        !record.historicalSubjectId
        && record.legacyProviderKey
        && unattributedKeys.has(record.legacyProviderKey)
      ) {
        record.historicalAttributionLocked = true;
      }
    }
    for (const alias of Object.keys(this.remaps)) {
      if (resolveMappedId(alias, this.remaps) === from) {
        this.setRemapDecision(alias, null, retiredAt);
      }
    }

    this.knownSubjects.delete(from);
    this.knownSubjects.set(retiredId, {
      id: retiredId,
      kind,
      label: kind === "account" ? "Retired account" : "Retired API provider",
      ...(existing?.legacyProviderIds
        ? { legacyProviderIds: [...existing.legacyProviderIds] }
        : {}),
    });
    this.persistedSubjects.delete(from);
    this.persistedSubjects.set(retiredId, kind);
    this.retiredSubjects.add(retiredId);
    if (currentWasFrom) {
      this.currentSelection = null;
      this.configureHeartbeat();
    }
    this.rebuildSnapshot(this.snapshot.scan);
    await this.persist();
    return retiredId;
  }

  getSnapshot(): UsageSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  onDidChange(listener: (snapshot: UsageSnapshot) => void): Disposable {
    this.assertActive();
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.listeners.clear();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loadPromise) this.loadPromise = this.readPersistedState();
    return this.loadPromise;
  }

  private async readPersistedState(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.memento.get<unknown>(this.stateKey);
      if (raw === undefined) raw = await this.memento.get<unknown>(STATE_KEY);
    } catch {
      raw = undefined;
    }
    const state = parsePersistedState(raw, this.homeKey);
    if (state) {
      this.initializedAt = state.initializedAt;
      this.files = state.files;
      this.timeline = state.timeline;
      this.remapDecisions = state.remaps;
      this.rebuildActiveRemaps();
      this.retirements = state.retirements;
      for (const subject of state.subjects) {
        this.persistedSubjects.set(subject.id, subject.kind);
        if (subject.retired) this.retiredSubjects.add(subject.id);
      }
      this.releaseLoadedAliasesForKnownSubjects();
    } else {
      this.initializedAt = this.now();
    }
    this.loaded = true;
  }

  private queueRefresh(): Promise<UsageSnapshot> {
    const operation = this.refreshTail.then(() => {
      this.markIndexing();
      return this.scanAndAggregate();
    });
    this.refreshTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async scanAndAggregate(): Promise<UsageSnapshot> {
    this.assertActive();
    const discovery = await discoverSessionFiles(this.codexHome);
    const discovered = discovery.files;
    const nextFiles: Record<string, SessionUsageRecord> = {};
    let rescannedFiles = 0;
    let reusedFiles = 0;
    let errors = discovery.errors;
    const readMetrics: ReadMetrics = { bytesRead: 0, chunksRead: 0 };

    for (let index = 0; index < discovered.length; index += 1) {
      const file = discovered[index];
      const key = digest(file.relativePath);
      const cached = this.files[key];
      if (cached && sameFingerprint(cached.fingerprint, file.fingerprint)) {
        nextFiles[key] = cached;
        reusedFiles += 1;
      } else {
        rescannedFiles += 1;
        try {
          const scanned = await scanSessionFile(
            file.absolutePath,
            file.fingerprint,
            cached,
            this.initializedAt,
            readMetrics,
          );
          if (scanned) nextFiles[key] = scanned;
        } catch {
          errors += 1;
          if (cached) nextFiles[key] = cached;
        }
      }
      if (index > 0 && index % 50 === 0) await yieldToEventLoop();
    }

    if (discovery.errors > 0) {
      for (const [key, cached] of Object.entries(this.files)) {
        if (!nextFiles[key]) nextFiles[key] = cached;
      }
    }

    const previousProviderByThread = new Map<string, SessionUsageRecord>();
    for (const previous of Object.values(this.files)) {
      if (!previous.openAiProvider && previous.legacyProviderKey) {
        previousProviderByThread.set(previous.threadKey, previous);
      }
    }
    for (const record of Object.values(nextFiles)) {
      const previous = previousProviderByThread.get(record.threadKey);
      if (record.startedAt < this.initializedAt && record.openAiProvider && previous) {
        record.legacyProviderKey = previous.legacyProviderKey;
        record.openAiProvider = false;
        record.historicalSubjectId = previous.historicalSubjectId;
        record.historicalAttributionLocked = previous.historicalAttributionLocked;
      }
    }

    this.files = nextFiles;
    this.rebuildSnapshot(
      {
        discoveredFiles: discovered.length,
        rescannedFiles,
        reusedFiles,
        errors,
        bytesRead: readMetrics.bytesRead,
        chunksRead: readMetrics.chunksRead,
      },
      {
        status: "ready",
        coverage: errors === 0 ? "complete" : "partial",
        lastError: errors === 0 ? null : "Some Codex session files could not be indexed.",
      },
    );
    await this.persist();
    return this.getSnapshot();
  }

  private rebuildSnapshot(
    scan: UsageSnapshot["scan"],
    state: Pick<UsageSnapshot, "status" | "coverage" | "lastError"> = this.snapshot,
  ): void {
    const before = snapshotUsageSignature(this.snapshot);
    const legacySubjects = this.createLegacySubjectMap();
    const byThread = new Map<string, SessionUsageRecord>();
    for (const record of Object.values(this.files)) {
      const previous = byThread.get(record.threadKey);
      if (!previous || preferRecord(record, previous)) byThread.set(record.threadKey, record);
    }

    const total = zeroTokens();
    const unattributed = zeroTokens();
    const subjectUsage = new Map<string, { threads: Set<string>; tokens: TokenTotals }>();
    const historyDays = new Map<string, MutableDailyTokenUsage>();
    const undated = zeroTokens();
    for (const record of byThread.values()) {
      addTokens(total, record.tokens);
      const allocated = zeroTokens();
      const attribute = (
        tokens: TokenTotals,
        subjectId: string | null,
        timestamp: number | null,
        estimated: boolean,
      ): void => {
        if (!hasTokens(tokens)) return;
        addTokens(allocated, tokens);
        const resolved = subjectId ? this.resolveSubjectId(subjectId) : null;
        if (!resolved) {
          addTokens(unattributed, tokens);
        } else {
          const usage = subjectUsage.get(resolved) ?? { threads: new Set(), tokens: zeroTokens() };
          usage.threads.add(record.threadKey);
          addTokens(usage.tokens, tokens);
          subjectUsage.set(resolved, usage);
        }
        addHistoryTokens(historyDays, undated, tokens, resolved, timestamp, estimated);
      };
      attribute(
        record.historicalTokens,
        this.historicalSubject(record, legacySubjects),
        record.observedAt,
        true,
      );
      for (const increment of record.increments) {
        attribute(
          increment.tokens,
          this.subjectAt(increment.at, record, legacySubjects),
          increment.at ?? record.observedAt,
          increment.at === null,
        );
      }
      const remainder = subtractFloor(record.tokens, allocated);
      if (hasTokens(remainder)) attribute(remainder, null, record.observedAt, true);
    }

    const allSubjectIds = new Set<string>();
    for (const id of this.knownSubjects.keys()) allSubjectIds.add(this.resolveSubjectId(id));
    for (const id of this.persistedSubjects.keys()) allSubjectIds.add(this.resolveSubjectId(id));
    for (const id of subjectUsage.keys()) allSubjectIds.add(id);
    const subjects = [...allSubjectIds].map((id): SubjectTokenUsage => {
      const known = this.knownSubjects.get(id);
      const kind = known?.kind ?? this.persistedSubjects.get(id) ?? kindFromId(id);
      const usage = subjectUsage.get(id);
      return {
        id,
        kind,
        label: known?.label ?? (this.retiredSubjects.has(id)
          ? kind === "account" ? "Retired account" : "Retired API provider"
          : kind === "account" ? "Codex account" : "API provider"),
        ...(known?.legacyProviderIds ? { legacyProviderIds: [...known.legacyProviderIds] } : {}),
        sessionCount: usage?.threads.size ?? 0,
        tokens: cloneTokens(usage?.tokens ?? EMPTY_TOKENS),
      };
    });
    subjects.sort((left, right) =>
      right.tokens.totalTokens - left.tokens.totalTokens || left.label.localeCompare(right.label),
    );

    this.snapshot = {
      updatedAt: this.now(),
      trackingStartedAt: this.loaded ? this.initializedAt : null,
      status: state.status,
      coverage: state.coverage,
      lastError: state.lastError,
      sessionCount: byThread.size,
      total,
      unattributed,
      subjects,
      history: {
        days: [...historyDays.values()]
          .sort((left, right) => left.date.localeCompare(right.date))
          .map(projectDailyTokenUsage),
        undated,
      },
      scan: { ...scan },
    };
    if (before !== snapshotUsageSignature(this.snapshot)) this.emit();
  }

  private historicalSubject(
    record: SessionUsageRecord,
    legacySubjects: Map<string, string | null>,
  ): string | null {
    return historicalSubjectWithRemaps(record, legacySubjects, this.remaps);
  }

  private subjectAt(
    timestamp: number | null,
    record: SessionUsageRecord,
    legacySubjects: Map<string, string | null>,
  ): string | null {
    if (timestamp === null) return null;
    if (timestamp < this.initializedAt) return this.historicalSubject(record, legacySubjects);
    const interval = findSelectionInterval(this.timeline, timestamp);
    return interval?.subjectId ? this.resolveSubjectId(interval.subjectId) : null;
  }

  private createLegacySubjectMap(remaps = this.remaps): Map<string, string | null> {
    const result = new Map<string, string | null>();
    for (const subject of this.knownSubjects.values()) {
      const subjectId = resolveMappedId(subject.id, remaps);
      for (const providerId of subject.legacyProviderIds ?? []) {
        const key = providerKey(providerId);
        if (!key) continue;
        if (!result.has(key)) {
          result.set(key, subjectId);
        } else if (result.get(key) !== subjectId) {
          result.set(key, null);
        }
      }
    }
    return result;
  }

  private rememberSubject(subject: UsageSubject): void {
    const clean = sanitizeSubject(subject);
    const knownDirectly = this.knownSubjects.has(clean.id);
    if (!knownDirectly && this.remaps[clean.id]) {
      this.materializeActiveRemaps();
      this.setRemapDecision(clean.id, null);
    }
    const resolvedId = this.resolveSubjectId(clean.id);
    const existing = this.knownSubjects.get(resolvedId);
    const legacyProviderIds = mergeLegacyProviderIds(existing, clean);
    this.knownSubjects.set(resolvedId, {
      ...clean,
      id: resolvedId,
      ...(legacyProviderIds.length > 0 ? { legacyProviderIds } : {}),
    });
    this.persistedSubjects.set(resolvedId, clean.kind);
  }

  private setRemapDecision(from: string, to: string | null, requestedAt = this.now()): void {
    const previousAt = this.remapDecisions[from]?.at ?? 0;
    const at = Math.max(requestedAt, previousAt + 1, this.lastRemapDecisionAt + 1);
    const decision = {
      to,
      at,
      nonce: randomBytes(8).toString("hex"),
    };
    this.remapDecisions[from] = decision;
    this.lastRemapDecisionAt = at;
    if (to) this.remaps[from] = to;
    else delete this.remaps[from];
  }

  private rebuildActiveRemaps(): void {
    this.remaps = activeRemaps(this.remapDecisions);
    this.lastRemapDecisionAt = Math.max(
      0,
      ...Object.values(this.remapDecisions).map((decision) => decision.at),
    );
  }

  private releaseLoadedAliasesForKnownSubjects(): void {
    if ([...this.knownSubjects.keys()].some((id) => Boolean(this.remaps[id]))) {
      this.materializeActiveRemaps();
    }
    for (const id of this.knownSubjects.keys()) {
      if (this.remaps[id]) this.setRemapDecision(id, null);
    }
  }

  private materializeActiveRemaps(): void {
    for (const interval of this.timeline) {
      if (!interval.subjectId) continue;
      const resolved = this.resolveSubjectId(interval.subjectId);
      if (resolved) interval.subjectId = resolved;
    }
    for (const record of Object.values(this.files)) {
      if (!record.historicalSubjectId) continue;
      const resolved = this.resolveSubjectId(record.historicalSubjectId);
      if (resolved) record.historicalSubjectId = resolved;
    }
  }

  private resolveSubjectId(subjectId: string | null): string {
    if (!subjectId) return "";
    let current = subjectId;
    const visited = new Set<string>();
    while (this.remaps[current] && !visited.has(current)) {
      visited.add(current);
      current = this.remaps[current];
    }
    return current;
  }

  private configureHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (!this.currentSelection || this.heartbeatIntervalMs === 0) return;
    this.heartbeat = setInterval(() => {
      const selection = this.currentSelection;
      if (selection && !this.disposed) void this.recordSelection(selection);
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  private markIndexing(): void {
    const before = snapshotUsageSignature(this.snapshot);
    this.snapshot = {
      ...this.snapshot,
      updatedAt: this.now(),
      trackingStartedAt: this.loaded ? this.initializedAt : null,
      status: "indexing",
    };
    if (before !== snapshotUsageSignature(this.snapshot)) this.emit();
  }

  private async persist(): Promise<void> {
    const localState: PersistedState = {
      version: STATE_VERSION,
      homeKey: this.homeKey,
      initializedAt: this.initializedAt,
      files: this.files,
      timeline: this.timeline,
      subjects: [...this.persistedSubjects].map(([id, kind]) => ({
        id,
        kind,
        retired: this.retiredSubjects.has(id),
      })),
      remaps: this.remapDecisions,
      retirements: this.retirements,
    };
    try {
      const lock = await acquireProcessLock(this.lockDirectory);
      let merged = localState;
      try {
        const remote = parsePersistedState(
          await this.memento.get<unknown>(this.stateKey),
          this.homeKey,
        );
        if (remote) merged = mergePersistedStates(remote, localState);
        if (!await lock.isOwned()) throw new Error("The usage cache lock lease was lost");
        await this.memento.update(this.stateKey, serializePersistedState(merged));
      } finally {
        await lock.release();
      }
      this.initializedAt = merged.initializedAt;
      this.files = merged.files;
      this.timeline = merged.timeline;
      this.remapDecisions = merged.remaps;
      this.rebuildActiveRemaps();
      this.retirements = merged.retirements;
      this.persistedSubjects = new Map(merged.subjects.map(({ id, kind }) => [id, kind]));
      this.retiredSubjects = new Set(
        merged.subjects.filter((subject) => subject.retired).map((subject) => subject.id),
      );
      this.rebuildSnapshot(this.snapshot.scan);
    } catch {
      const before = snapshotUsageSignature(this.snapshot);
      this.snapshot = {
        ...this.snapshot,
        coverage: "partial",
        lastError: "The local usage cache could not be updated.",
      };
      if (before !== snapshotUsageSignature(this.snapshot)) this.emit();
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A view listener must not interrupt usage collection.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("UsageService is disposed");
  }
}

function mergePersistedStates(
  remote: PersistedState,
  local: PersistedState,
): PersistedState {
  const files: Record<string, SessionUsageRecord> = { ...remote.files };
  for (const [key, candidate] of Object.entries(local.files)) {
    const previous = files[key];
    if (!previous || preferPersistedRecord(candidate, previous)) files[key] = candidate;
  }

  const remapDecisions: Record<string, SubjectRemapDecision> = { ...remote.remaps };
  for (const [from, candidate] of Object.entries(local.remaps)) {
    const previous = remapDecisions[from];
    if (!previous || preferRemapDecision(candidate, previous)) {
      remapDecisions[from] = candidate;
    }
  }
  let remaps = activeRemaps(remapDecisions);
  for (const record of Object.values(files)) {
    if (!record.historicalSubjectId) continue;
    const resolved = resolveMappedId(record.historicalSubjectId, remaps);
    if (resolved) record.historicalSubjectId = resolved;
  }
  const retirementMap = new Map<string, SubjectRetirement>();
  for (const retirement of [...remote.retirements, ...local.retirements]) {
    retirementMap.set(`${retirement.from}:${retirement.to}:${retirement.at}`, retirement);
  }
  const retirements = [...retirementMap.values()].sort((left, right) => left.at - right.at);

  const timelineByTimestamp = new Map<number, SelectionInterval>();
  for (const interval of remote.timeline) {
    timelineByTimestamp.set(interval.at, {
      ...interval,
      subjectId: interval.subjectId ? resolveMappedId(interval.subjectId, remaps) : null,
    });
  }
  for (const interval of local.timeline) {
    timelineByTimestamp.set(interval.at, {
      ...interval,
      subjectId: interval.subjectId ? resolveMappedId(interval.subjectId, remaps) : null,
    });
  }
  let timeline = [...timelineByTimestamp.values()].sort((left, right) => left.at - right.at);
  for (const retirement of retirements) {
    for (const interval of timeline) {
      if (
        interval.at <= retirement.at
        && resolveMappedId(interval.subjectId, remaps) === retirement.from
      ) interval.subjectId = retirement.to;
    }
    for (const record of Object.values(files)) {
      if (
        record.historicalSubjectId === retirement.from
        || Boolean(
          record.legacyProviderKey
          && retirement.legacyProviderKeys.includes(record.legacyProviderKey),
        )
      ) {
        record.historicalSubjectId = retirement.to;
        record.historicalAttributionLocked = true;
      } else if (
        !record.historicalSubjectId
        && record.legacyProviderKey
        && retirement.unattributedProviderKeys.includes(record.legacyProviderKey)
      ) {
        record.historicalAttributionLocked = true;
      }
    }
    for (const alias of Object.keys(remaps)) {
      const decision = remapDecisions[alias];
      if (
        resolveMappedId(alias, remaps) === retirement.from
        && decision
        && decision.at <= retirement.at
      ) {
        remapDecisions[alias] = {
          to: null,
          at: retirement.at,
          nonce: digest(`retirement\0${retirement.from}\0${retirement.to}\0${alias}`),
        };
      }
    }
    remaps = activeRemaps(remapDecisions);
  }
  timeline = compactUnknownIntervals(timeline);

  const subjects = new Map<string, PersistedSubject>();
  for (const subject of [...remote.subjects, ...local.subjects]) {
    const previous = subjects.get(subject.id);
    subjects.set(subject.id, {
      ...subject,
      retired: subject.retired || previous?.retired || false,
    });
  }
  for (const retirement of retirements) {
    subjects.set(retirement.to, {
      id: retirement.to,
      kind: kindFromId(retirement.to),
      retired: true,
    });
    const recreated = timeline.some((interval) => (
      interval.at > retirement.at && interval.subjectId === retirement.from
    ));
    if (!recreated) subjects.delete(retirement.from);
  }

  return {
    version: STATE_VERSION,
    homeKey: local.homeKey,
    initializedAt: Math.min(remote.initializedAt, local.initializedAt),
    files,
    timeline,
    subjects: [...subjects.values()],
    remaps: remapDecisions,
    retirements,
  };
}

function preferRemapDecision(
  candidate: SubjectRemapDecision,
  previous: SubjectRemapDecision,
): boolean {
  if (candidate.at !== previous.at) return candidate.at > previous.at;
  return candidate.nonce > previous.nonce;
}

function activeRemaps(
  decisions: Readonly<Record<string, SubjectRemapDecision>>,
): Record<string, string> {
  const remaps: Record<string, string> = {};
  for (const [from, decision] of Object.entries(decisions)) {
    if (decision.to && from !== decision.to) remaps[from] = decision.to;
  }
  return remaps;
}

function historicalSubjectWithRemaps(
  record: SessionUsageRecord,
  legacySubjects: ReadonlyMap<string, string | null>,
  remaps: Record<string, string>,
): string | null {
  if (record.historicalAttributionLocked) {
    return record.historicalSubjectId
      ? resolveMappedId(record.historicalSubjectId, remaps)
      : null;
  }
  if (record.historicalSubjectId) return resolveMappedId(record.historicalSubjectId, remaps);
  if (record.openAiProvider || !record.legacyProviderKey) return null;
  const legacy = legacySubjects.get(record.legacyProviderKey);
  return legacy ? resolveMappedId(legacy, remaps) : null;
}

function compactUnknownIntervals(timeline: SelectionInterval[]): SelectionInterval[] {
  const compacted: SelectionInterval[] = [];
  for (const interval of timeline) {
    const previous = compacted[compacted.length - 1];
    if (previous?.subjectId === null && interval.subjectId === null) {
      previous.activeUntil = Math.max(previous.activeUntil, interval.activeUntil);
    } else {
      compacted.push({ ...interval });
    }
  }
  return compacted;
}

function preferPersistedRecord(
  candidate: SessionUsageRecord,
  previous: SessionUsageRecord,
): boolean {
  if (candidate.fingerprint.ctimeMs !== previous.fingerprint.ctimeMs) {
    return candidate.fingerprint.ctimeMs > previous.fingerprint.ctimeMs;
  }
  if (candidate.fingerprint.mtimeMs !== previous.fingerprint.mtimeMs) {
    return candidate.fingerprint.mtimeMs > previous.fingerprint.mtimeMs;
  }
  if (candidate.observedAt !== previous.observedAt) {
    return candidate.observedAt > previous.observedAt;
  }
  if (candidate.fingerprint.size !== previous.fingerprint.size) {
    return candidate.fingerprint.size > previous.fingerprint.size;
  }
  if (candidate.historicalAttributionLocked !== previous.historicalAttributionLocked) {
    return candidate.historicalAttributionLocked;
  }
  if (Boolean(candidate.historicalSubjectId) !== Boolean(previous.historicalSubjectId)) {
    return Boolean(candidate.historicalSubjectId);
  }
  return false;
}

function resolveMappedId(subjectId: string | null, remaps: Record<string, string>): string {
  if (!subjectId) return "";
  let current = subjectId;
  const visited = new Set<string>();
  while (remaps[current] && !visited.has(current)) {
    visited.add(current);
    current = remaps[current];
  }
  return current;
}

async function acquireProcessLock(lockDirectory: string): Promise<ProcessLock> {
  const ownerToken = randomBytes(16).toString("hex");
  const ownerFile = path.join(lockDirectory, `owner-${ownerToken}`);
  const deadline = Date.now() + 6_000;
  while (true) {
    try {
      await fs.mkdir(lockDirectory);
      try {
        await fs.writeFile(ownerFile, ownerToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        try {
          await fs.rmdir(lockDirectory);
        } catch {
          // The original error is more useful.
        }
        throw error;
      }
      let released = false;
      let renewing = false;
      const lease = setInterval(() => {
        if (released || renewing) return;
        renewing = true;
        void renewLockLease(lockDirectory, ownerToken).finally(() => {
          renewing = false;
        });
      }, LOCK_RENEW_MS);
      lease.unref?.();
      return {
        isOwned: async () => (
          !released && await readLockOwner(lockDirectory) === ownerToken
        ),
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(lease);
          try {
            if (await readLockOwner(lockDirectory) !== ownerToken) return;
            await fs.unlink(ownerFile);
            await fs.rmdir(lockDirectory);
          } catch {
            // Ownership may have changed after a stale-lock takeover.
          }
        },
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      try {
        const stat = await fs.stat(lockDirectory);
        const observedOwner = await readLockOwner(lockDirectory);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await delay(20);
          const confirmedStat = await fs.stat(lockDirectory);
          const confirmedOwner = await readLockOwner(lockDirectory);
          if (
            observedOwner === confirmedOwner
            && Date.now() - confirmedStat.mtimeMs > LOCK_STALE_MS
          ) {
            await quarantineStaleLock(lockDirectory, confirmedOwner);
          }
          continue;
        }
      } catch (statError) {
        if (isMissing(statError)) continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the usage cache lock");
      await delay(20);
    }
  }
}

async function renewLockLease(lockDirectory: string, ownerToken: string): Promise<void> {
  if (await readLockOwner(lockDirectory) !== ownerToken) return;
  const now = new Date();
  try {
    await fs.utimes(lockDirectory, now, now);
  } catch {
    // The owner will notice replacement during release.
  }
}

async function readLockOwner(lockDirectory: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(lockDirectory);
    const tokenFiles = entries.filter((entry) => /^owner-[a-f0-9]{32}$/.test(entry));
    const ownerFile = tokenFiles.length === 1
      ? tokenFiles[0]
      : entries.includes("owner") && tokenFiles.length === 0
        ? "owner"
        : null;
    if (!ownerFile) return null;
    const value = (await fs.readFile(path.join(lockDirectory, ownerFile), "utf8")).trim();
    if (!/^[a-f0-9]{32}$/.test(value)) return null;
    if (ownerFile !== "owner" && ownerFile !== `owner-${value}`) return null;
    return value;
  } catch {
    return null;
  }
}

async function quarantineStaleLock(
  lockDirectory: string,
  expectedOwner: string | null,
): Promise<void> {
  const quarantine = `${lockDirectory}.stale-${randomBytes(8).toString("hex")}`;
  try {
    await fs.rename(lockDirectory, quarantine);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const movedOwner = await readLockOwner(quarantine);
  let stillStale = false;
  try {
    const movedStat = await fs.stat(quarantine);
    stillStale = Date.now() - movedStat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return;
  }
  if (movedOwner === expectedOwner && stillStale) {
    await fs.rm(quarantine, { recursive: true, force: true });
    return;
  }
  try {
    await fs.rename(quarantine, lockDirectory);
  } catch {
    // A new owner already holds the canonical path; never delete the mismatched lock.
  }
}

async function discoverSessionFiles(codexHome: string): Promise<{
  files: Array<{
    absolutePath: string;
    relativePath: string;
    fingerprint: Fingerprint;
  }>;
  errors: number;
}> {
  const discovered: Array<{
    absolutePath: string;
    relativePath: string;
    fingerprint: Fingerprint;
  }> = [];
  let errors = 0;
  for (const rootName of ["sessions", "archived_sessions"]) {
    const root = path.join(codexHome, rootName);
    await visit(root, rootName);
  }
  discovered.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { files: discovered, errors };

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      errors += 1;
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fs.stat(absolutePath);
          discovered.push({
            absolutePath,
            relativePath,
            fingerprint: fingerprintOf(stat),
          });
        } catch {
          // A concurrently moved session will be picked up on the next refresh.
          errors += 1;
        }
      }
    }
  }
}

async function scanSessionFile(
  filePath: string,
  discoveredFingerprint: Fingerprint,
  cached: SessionUsageRecord | undefined,
  initializedAt: number,
  metrics: ReadMetrics,
): Promise<SessionUsageRecord | null> {
  let fingerprint = discoveredFingerprint;
  let checkpoint = cached;
  let result: SessionUsageRecord | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await scanSessionVersion(
      filePath,
      fingerprint,
      checkpoint,
      initializedAt,
      metrics,
    );
    let after: Fingerprint;
    try {
      after = fingerprintOf(await fs.stat(filePath));
    } catch {
      return result;
    }
    if (sameFingerprint(after, fingerprint)) return result;
    fingerprint = after;
    checkpoint = result ?? checkpoint;
  }
  // The retained fingerprint guarantees another refresh if the file keeps changing.
  return result;
}

async function scanSessionVersion(
  filePath: string,
  fingerprint: Fingerprint,
  cached: SessionUsageRecord | undefined,
  initializedAt: number,
  metrics: ReadMetrics,
): Promise<SessionUsageRecord | null> {
  if (
    cached
    && fingerprint.size > cached.fingerprint.size
    && cached.appendOffset <= cached.fingerprint.size
    && await appendGuardMatches(filePath, cached, metrics)
  ) {
    return appendSessionUsage(filePath, fingerprint, cached, initializedAt, metrics);
  }
  return bootstrapSessionUsage(filePath, fingerprint, cached, initializedAt, metrics);
}

async function bootstrapSessionUsage(
  filePath: string,
  fingerprint: Fingerprint,
  cached: SessionUsageRecord | undefined,
  initializedAt: number,
  metrics: ReadMetrics,
): Promise<SessionUsageRecord | null> {
  const headMeta = await readHeadSessionMeta(filePath, fingerprint, metrics);
  if (headMeta && (headMeta.startedAt >= initializedAt || cached?.timelineTracked)) {
    return preserveLegacyProviderAttribution(
      await forwardScanSession(filePath, fingerprint, initializedAt, metrics),
      cached,
      initializedAt,
    );
  }

  const filenameThreadId = rolloutThreadId(filePath);
  const normalRollout = Boolean(
    headMeta && filenameThreadId && headMeta.threadKey === digest(filenameThreadId),
  );
  const historical = await reverseScanHistoricalSession(
    filePath,
    fingerprint,
    metrics,
    normalRollout ? headMeta : null,
  );
  if (historical && historical.observedAt >= initializedAt) {
    return preserveLegacyProviderAttribution(
      await forwardScanSession(filePath, fingerprint, initializedAt, metrics),
      cached,
      initializedAt,
    );
  }
  return preserveLegacyProviderAttribution(historical, cached, initializedAt);
}

function preserveLegacyProviderAttribution(
  scanned: SessionUsageRecord | null,
  cached: SessionUsageRecord | undefined,
  initializedAt: number,
): SessionUsageRecord | null {
  if (
    scanned
    && cached
    && scanned.threadKey === cached.threadKey
    && scanned.startedAt < initializedAt
    && scanned.openAiProvider
    && !cached.openAiProvider
    && cached.legacyProviderKey
  ) {
    scanned.legacyProviderKey = cached.legacyProviderKey;
    scanned.openAiProvider = false;
    scanned.historicalSubjectId = cached.historicalSubjectId;
    scanned.historicalAttributionLocked = cached.historicalAttributionLocked;
  }
  return scanned;
}

async function reverseScanHistoricalSession(
  filePath: string,
  fingerprint: Fingerprint,
  metrics: ReadMetrics,
  normalMeta: SessionMeta | null,
): Promise<SessionUsageRecord | null> {
  const handle = await fs.open(filePath, "r");
  let position = fingerprint.size;
  let suffix = Buffer.alloc(0);
  let skippingOversizedLine = false;
  let latestToken: ParsedTokenCount | null = null;
  let meta: SessionMeta | null = normalMeta;
  let baseline: TokenTotals | null = null;
  let appendOffset: number | null = null;
  let appendGuard = digestBuffer(Buffer.alloc(0));
  let appendGuardComplete = false;
  const requiresBaseline = normalMeta === null;
  try {
    while (position > 0 && !scanComplete()) {
      const start = Math.max(0, position - READ_CHUNK_BYTES);
      const requested = position - start;
      const chunk = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, start);
      metrics.bytesRead += bytesRead;
      metrics.chunksRead += 1;
      const bytes = chunk.subarray(0, bytesRead);
      let segmentEnd = bytes.length;
      let foundNewline = false;
      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        if (bytes[index] !== 0x0a) continue;
        if (appendOffset === null) {
          appendOffset = start + index + 1;
          if (index + 1 >= 64) {
            appendGuard = digestBuffer(bytes.subarray(index + 1 - 64, index + 1));
            appendGuardComplete = true;
          }
        }
        const segment = bytes.subarray(index + 1, segmentEnd);
        if (!foundNewline) {
          if (!skippingOversizedLine) processJoinedLine(segment, suffix);
          suffix = Buffer.alloc(0);
          skippingOversizedLine = false;
        } else if (segment.length <= MAX_JSONL_LINE_BYTES) {
          processLine(segment);
        }
        foundNewline = true;
        segmentEnd = index;
        if (scanComplete()) break;
      }
      if (!scanComplete()) {
        const prefix = bytes.subarray(0, segmentEnd);
        if (foundNewline) {
          if (prefix.length > MAX_JSONL_LINE_BYTES) {
            skippingOversizedLine = true;
            suffix = Buffer.alloc(0);
          } else {
            suffix = Buffer.from(prefix);
          }
        } else if (!skippingOversizedLine) {
          if (prefix.length + suffix.length > MAX_JSONL_LINE_BYTES) {
            skippingOversizedLine = true;
            suffix = Buffer.alloc(0);
          } else {
            suffix = Buffer.concat([prefix, suffix]);
          }
        }
      }
      position = start;
    }
    if (position === 0 && suffix.length && !skippingOversizedLine && !scanComplete()) {
      processLine(suffix);
    }
  } finally {
    await handle.close();
  }

  const finalToken = latestToken as ParsedTokenCount | null;
  const finalMeta = meta as SessionMeta | null;
  if (!finalToken || !finalMeta) return null;
  if (appendOffset && !appendGuardComplete) {
    appendGuard = await readAppendGuard(filePath, appendOffset, metrics);
  }
  const inheritedBaseline = cloneTokens(baseline ?? EMPTY_TOKENS);
  const tokens = subtractInherited(finalToken.tokens, inheritedBaseline);
  return {
    fingerprint,
    ...finalMeta,
    observedAt: finalToken.observedAt ?? finalMeta.startedAt,
    historicalSubjectId: null,
    historicalAttributionLocked: false,
    inheritedBaseline,
    lastCumulative: cloneTokens(finalToken.tokens),
    historicalTokens: cloneTokens(tokens),
    increments: [],
    appendOffset: appendOffset ?? 0,
    appendGuard,
    timelineTracked: false,
    tokens,
  };

  function processLine(bytes: Buffer): void {
    const record = parseRelevantLine(bytes);
    if (!record) return;
    const token = parseTokenCount(record);
    if (token) {
      if (!latestToken) latestToken = token;
      if (requiresBaseline && meta && !baseline) baseline = token.tokens;
      return;
    }
    if (requiresBaseline && !meta) meta = parseSessionMeta(record);
  }

  function processJoinedLine(prefix: Buffer, tail: Buffer): void {
    if (prefix.length + tail.length > MAX_JSONL_LINE_BYTES) return;
    if (tail.length === 0) {
      processLine(prefix);
    } else if (prefix.length === 0) {
      processLine(tail);
    } else {
      processLine(Buffer.concat([prefix, tail]));
    }
  }

  function scanComplete(): boolean {
    return Boolean(latestToken && meta && (!requiresBaseline || baseline));
  }
}

async function forwardScanSession(
  filePath: string,
  fingerprint: Fingerprint,
  initializedAt: number,
  metrics: ReadMetrics,
): Promise<SessionUsageRecord | null> {
  let meta: SessionMeta | null = null;
  let lastCumulative = zeroTokens();
  let inheritedBaseline = zeroTokens();
  let historicalTokens = zeroTokens();
  let increments: UsageIncrement[] = [];
  let tokens = zeroTokens();
  let observedAt = 0;
  let sawToken = false;
  let timelineTracked = false;

  const appendOffset = await readJsonLines(
    filePath,
    0,
    fingerprint.size,
    metrics,
    (record) => {
      const nextMeta = parseSessionMeta(record);
      if (nextMeta) {
        meta = nextMeta;
        inheritedBaseline = cloneTokens(lastCumulative);
        historicalTokens = zeroTokens();
        increments = [];
        tokens = zeroTokens();
        observedAt = nextMeta.startedAt;
        sawToken = false;
        timelineTracked = nextMeta.startedAt >= initializedAt;
        return;
      }
      const token = parseTokenCount(record);
      if (!token) return;
      if (!meta) {
        lastCumulative = cloneTokens(token.tokens);
        return;
      }
      if (token.tokens.totalTokens < lastCumulative.totalTokens) {
        inheritedBaseline = zeroTokens();
        historicalTokens = zeroTokens();
        increments = [];
      }
      const delta = token.tokens.totalTokens < lastCumulative.totalTokens
        ? cloneTokens(token.tokens)
        : subtractInherited(token.tokens, lastCumulative);
      lastCumulative = cloneTokens(token.tokens);
      tokens = subtractInherited(lastCumulative, inheritedBaseline);
      observedAt = token.observedAt ?? observedAt;
      sawToken = true;
      if (hasTokens(delta)) {
        if (token.observedAt !== null && token.observedAt < initializedAt) {
          addTokens(historicalTokens, delta);
        } else if (token.observedAt === null && meta.startedAt < initializedAt) {
          addTokens(historicalTokens, delta);
        } else {
          increments.push({ at: token.observedAt, tokens: delta });
          timelineTracked = true;
        }
      }
    },
  );

  const finalMeta = meta as SessionMeta | null;
  if (!finalMeta || (!sawToken && !hasTokens(lastCumulative))) return null;
  return {
    fingerprint,
    ...finalMeta,
    observedAt: observedAt || finalMeta.startedAt,
    historicalSubjectId: null,
    historicalAttributionLocked: false,
    inheritedBaseline,
    lastCumulative,
    historicalTokens,
    increments,
    appendOffset,
    appendGuard: await readAppendGuard(filePath, appendOffset, metrics),
    timelineTracked,
    tokens,
  };
}

async function appendSessionUsage(
  filePath: string,
  fingerprint: Fingerprint,
  cached: SessionUsageRecord,
  initializedAt: number,
  metrics: ReadMetrics,
): Promise<SessionUsageRecord> {
  const next = cloneSessionRecord(cached);
  const appendOffset = await readJsonLines(
    filePath,
    cached.appendOffset,
    fingerprint.size,
    metrics,
    (record) => {
      const meta = parseSessionMeta(record);
      if (meta) {
        next.threadKey = meta.threadKey;
        next.startedAt = meta.startedAt;
        next.legacyProviderKey = meta.legacyProviderKey;
        next.openAiProvider = meta.openAiProvider;
        next.historicalSubjectId = null;
        next.historicalAttributionLocked = false;
        next.inheritedBaseline = cloneTokens(next.lastCumulative);
        next.historicalTokens = zeroTokens();
        next.increments = [];
        next.tokens = zeroTokens();
        next.observedAt = meta.startedAt;
        next.timelineTracked = meta.startedAt >= initializedAt;
        return;
      }
      const token = parseTokenCount(record);
      if (!token) return;
      if (token.tokens.totalTokens < next.lastCumulative.totalTokens) {
        next.historicalSubjectId = null;
        next.historicalAttributionLocked = false;
        next.inheritedBaseline = zeroTokens();
        next.historicalTokens = zeroTokens();
        next.increments = [];
      }
      const delta = token.tokens.totalTokens < next.lastCumulative.totalTokens
        ? cloneTokens(token.tokens)
        : subtractInherited(token.tokens, next.lastCumulative);
      next.lastCumulative = cloneTokens(token.tokens);
      next.tokens = subtractInherited(next.lastCumulative, next.inheritedBaseline);
      next.observedAt = token.observedAt ?? next.observedAt;
      if (!hasTokens(delta)) return;
      if (token.observedAt !== null && token.observedAt < initializedAt) {
        addTokens(next.historicalTokens, delta);
      } else if (token.observedAt === null && next.startedAt < initializedAt) {
        addTokens(next.historicalTokens, delta);
      } else {
        next.increments.push({ at: token.observedAt, tokens: delta });
        next.timelineTracked = true;
      }
    },
  );
  next.fingerprint = fingerprint;
  next.appendOffset = appendOffset;
  next.appendGuard = await readAppendGuard(filePath, appendOffset, metrics);
  return next;
}

async function readJsonLines(
  filePath: string,
  start: number,
  end: number,
  metrics: ReadMetrics,
  visit: (record: JsonRecord) => void,
): Promise<number> {
  const handle = await fs.open(filePath, "r");
  let position = start;
  let carry = Buffer.alloc(0);
  let skippingOversizedLine = false;
  let lastCompleteOffset = start;
  try {
    while (position < end) {
      const requested = Math.min(READ_CHUNK_BYTES, end - position);
      const chunk = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead === 0) break;
      metrics.bytesRead += bytesRead;
      metrics.chunksRead += 1;
      const chunkStart = position;
      position += bytesRead;
      const bytes = chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        const segment = bytes.subarray(lineStart, index);
        if (!skippingOversizedLine) {
          const length = carry.length + segment.length;
          if (length <= MAX_JSONL_LINE_BYTES) {
            const line = carry.length === 0
              ? segment
              : segment.length === 0
                ? carry
                : Buffer.concat([carry, segment]);
            const record = parseRelevantLine(line);
            if (record) visit(record);
          }
        }
        skippingOversizedLine = false;
        carry = Buffer.alloc(0);
        lastCompleteOffset = chunkStart + index + 1;
        lineStart = index + 1;
      }
      const trailing = bytes.subarray(lineStart);
      if (!skippingOversizedLine) {
        if (carry.length + trailing.length > MAX_JSONL_LINE_BYTES) {
          skippingOversizedLine = true;
          carry = Buffer.alloc(0);
        } else if (trailing.length > 0) {
          carry = carry.length === 0
            ? Buffer.from(trailing)
            : Buffer.concat([carry, trailing]);
        }
      }
    }
    return lastCompleteOffset;
  } finally {
    await handle.close();
  }
}

async function appendGuardMatches(
  filePath: string,
  cached: SessionUsageRecord,
  metrics: ReadMetrics,
): Promise<boolean> {
  return (await readAppendGuard(filePath, cached.appendOffset, metrics)) === cached.appendGuard;
}

async function readAppendGuard(
  filePath: string,
  offset: number,
  metrics: ReadMetrics,
): Promise<string> {
  const length = Math.min(64, offset);
  if (length === 0) return digestBuffer(Buffer.alloc(0));
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    metrics.bytesRead += bytesRead;
    metrics.chunksRead += 1;
    return digestBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function parseRelevantLine(bytes: Buffer): JsonRecord | null {
  if (
    !bytes.includes(TOKEN_COUNT_MARKER)
    && !bytes.includes(SESSION_META_MARKER)
  ) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8").replace(/\r$/, ""));
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed as JsonRecord : null;
}

function cloneSessionRecord(record: SessionUsageRecord): SessionUsageRecord {
  return {
    ...record,
    fingerprint: { ...record.fingerprint },
    inheritedBaseline: cloneTokens(record.inheritedBaseline),
    lastCumulative: cloneTokens(record.lastCumulative),
    historicalTokens: cloneTokens(record.historicalTokens),
    increments: record.increments.map((increment) => ({
      at: increment.at,
      tokens: cloneTokens(increment.tokens),
    })),
    tokens: cloneTokens(record.tokens),
  };
}

async function readHeadSessionMeta(
  filePath: string,
  fingerprint: Fingerprint,
  metrics: ReadMetrics,
): Promise<SessionMeta | null> {
  const handle = await fs.open(filePath, "r");
  let position = 0;
  let carry = Buffer.alloc(0);
  try {
    while (position < fingerprint.size && position < MAX_HEAD_BYTES) {
      const requested = Math.min(
        READ_CHUNK_BYTES,
        fingerprint.size - position,
        MAX_HEAD_BYTES - position,
      );
      const chunk = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead === 0) break;
      metrics.bytesRead += bytesRead;
      metrics.chunksRead += 1;
      position += bytesRead;
      const combined = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let lineStart = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        const meta = parseMetaBytes(combined.subarray(lineStart, index));
        if (meta) return meta;
        lineStart = index + 1;
      }
      carry = Buffer.from(combined.subarray(lineStart));
    }
    return parseMetaBytes(carry);
  } finally {
    await handle.close();
  }
}

function parseMetaBytes(bytes: Buffer): SessionMeta | null {
  if (!bytes.length) return null;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8").replace(/\r$/, ""));
    return isRecord(parsed) ? parseSessionMeta(parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function rolloutThreadId(filePath: string): string | null {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

function parseTokenCount(record: JsonRecord): ParsedTokenCount | null {
  if (record.type !== "event_msg" || !isRecord(record.payload)) return null;
  if (record.payload.type !== "token_count" || !isRecord(record.payload.info)) return null;
  const usage = record.payload.info.total_token_usage;
  if (!isRecord(usage)) return null;
  const fields = [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens,
  ];
  if (!fields.every(isTokenInteger)) return null;
  return {
    observedAt: parseTimestamp(record.timestamp),
    tokens: {
      inputTokens: fields[0] as number,
      cachedInputTokens: fields[1] as number,
      outputTokens: fields[2] as number,
      reasoningOutputTokens: fields[3] as number,
      totalTokens: fields[4] as number,
    },
  };
}

function parseSessionMeta(record: JsonRecord): SessionMeta | null {
  if (record.type !== "session_meta" || !isRecord(record.payload)) return null;
  const id = typeof record.payload.id === "string" ? record.payload.id.trim() : "";
  if (!id) return null;
  const startedAt = parseTimestamp(record.payload.timestamp) ?? parseTimestamp(record.timestamp);
  if (startedAt === null) return null;
  const provider = typeof record.payload.model_provider === "string"
    ? record.payload.model_provider.trim()
    : "";
  return {
    threadKey: digest(id),
    startedAt,
    legacyProviderKey: providerKey(provider),
    openAiProvider: provider.toLowerCase() === "openai",
  };
}

function subtractInherited(current: TokenTotals, baseline: TokenTotals): TokenTotals {
  if (current.totalTokens < baseline.totalTokens) return cloneTokens(current);
  return {
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - baseline.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - baseline.reasoningOutputTokens),
    totalTokens: current.totalTokens - baseline.totalTokens,
  };
}

function findSelectionInterval(
  timeline: readonly SelectionInterval[],
  timestamp: number,
): SelectionInterval | null {
  const match = findSelectionAnchor(timeline, timestamp);
  return match && timestamp <= match.activeUntil ? match : null;
}

function findSelectionAnchor(
  timeline: readonly SelectionInterval[],
  timestamp: number,
): SelectionInterval | null {
  let low = 0;
  let high = timeline.length - 1;
  let match: SelectionInterval | null = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = timeline[middle];
    if (candidate.at <= timestamp) {
      match = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

function serializePersistedState(state: PersistedState): Record<string, unknown> {
  const { files, ...metadata } = state;
  const compressed = gzipSync(Buffer.from(JSON.stringify(files), "utf8"), {
    level: zlibConstants.Z_BEST_SPEED,
  });
  if (compressed.length > MAX_COMPRESSED_FILES_BYTES) {
    throw new Error("The compressed usage cache exceeds the supported size");
  }
  return {
    ...metadata,
    filesEncoding: "gzip-base64",
    filesCompressed: compressed.toString("base64"),
  };
}

function readPersistedFiles(value: Record<string, any>): Record<string, unknown> | null {
  if (isRecord(value.files)) return value.files;
  if (value.filesEncoding !== "gzip-base64" || typeof value.filesCompressed !== "string") {
    return null;
  }
  if (
    value.filesCompressed.length === 0
    || value.filesCompressed.length > Math.ceil(MAX_COMPRESSED_FILES_BYTES * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.filesCompressed)
  ) return null;
  try {
    const compressed = Buffer.from(value.filesCompressed, "base64");
    if (compressed.length > MAX_COMPRESSED_FILES_BYTES) return null;
    const decoded = gunzipSync(compressed, {
      maxOutputLength: MAX_PERSISTED_FILES_BYTES,
    });
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePersistedState(value: unknown, homeKey: string): PersistedState | null {
  if (!isRecord(value) || value.version !== STATE_VERSION || value.homeKey !== homeKey) return null;
  if (!isTimestamp(value.initializedAt) || !Array.isArray(value.timeline)) {
    return null;
  }
  const rawFiles = readPersistedFiles(value);
  if (!rawFiles) return null;
  const files: Record<string, SessionUsageRecord> = {};
  for (const [key, entry] of Object.entries(rawFiles)) {
    if (!/^[a-f0-9]{24}$/.test(key)) return null;
    const parsed = parseSessionUsageRecord(entry);
    if (!parsed) return null;
    files[key] = parsed;
  }
  const timeline: SelectionInterval[] = [];
  for (const entry of value.timeline) {
    if (!isRecord(entry) || !isTimestamp(entry.at) || !isTimestamp(entry.activeUntil)) return null;
    if (entry.activeUntil < entry.at) return null;
    if (entry.subjectId !== null && (
      typeof entry.subjectId !== "string" || !isSubjectId(entry.subjectId)
    )) return null;
    timeline.push({ at: entry.at, activeUntil: entry.activeUntil, subjectId: entry.subjectId });
  }
  timeline.sort((left, right) => left.at - right.at);

  const subjects: PersistedSubject[] = [];
  if (!Array.isArray(value.subjects)) return null;
  for (const subject of value.subjects) {
    if (!isRecord(subject) || typeof subject.id !== "string" || !isSubjectId(subject.id)) return null;
    if (subject.kind !== "account" && subject.kind !== "provider") return null;
    if (!isSubjectId(subject.id, subject.kind)) return null;
    if (typeof subject.retired !== "boolean") return null;
    subjects.push({ id: subject.id, kind: subject.kind, retired: subject.retired });
  }
  if (!isRecord(value.remaps)) return null;
  const remaps: Record<string, SubjectRemapDecision> = {};
  for (const [from, rawDecision] of Object.entries(value.remaps)) {
    if (!isSubjectId(from)) return null;
    if (typeof rawDecision === "string") {
      if (!isSubjectId(rawDecision)) return null;
      remaps[from] = {
        to: rawDecision,
        at: value.initializedAt,
        nonce: digest(`legacy-remap\0${from}\0${rawDecision}`),
      };
      continue;
    }
    if (!isRecord(rawDecision)) return null;
    if (rawDecision.to !== null && (
      typeof rawDecision.to !== "string" || !isSubjectId(rawDecision.to)
    )) return null;
    if (!isTimestamp(rawDecision.at)) return null;
    if (typeof rawDecision.nonce !== "string" || !/^[a-f0-9]{16,64}$/.test(rawDecision.nonce)) {
      return null;
    }
    remaps[from] = {
      to: rawDecision.to,
      at: rawDecision.at,
      nonce: rawDecision.nonce,
    };
  }
  if (!Array.isArray(value.retirements)) return null;
  const retirements: SubjectRetirement[] = [];
  for (const retirement of value.retirements) {
    if (!isRecord(retirement) || !isSubjectId(retirement.from) || !isSubjectId(retirement.to)) {
      return null;
    }
    if (
      !isTimestamp(retirement.at)
      || !Array.isArray(retirement.legacyProviderKeys)
      || !Array.isArray(retirement.unattributedProviderKeys)
    ) return null;
    if (![...retirement.legacyProviderKeys, ...retirement.unattributedProviderKeys].every((key) => (
      typeof key === "string" && /^[a-f0-9]{24}$/.test(key)
    ))) return null;
    retirements.push({
      from: retirement.from,
      to: retirement.to,
      at: retirement.at,
      legacyProviderKeys: [...retirement.legacyProviderKeys],
      unattributedProviderKeys: [...retirement.unattributedProviderKeys],
    });
  }
  return {
    version: STATE_VERSION,
    homeKey,
    initializedAt: value.initializedAt,
    files,
    timeline,
    subjects,
    remaps,
    retirements,
  };
}

function parseSessionUsageRecord(value: unknown): SessionUsageRecord | null {
  if (!isRecord(value)) return null;
  const fingerprint = parseFingerprint(value.fingerprint);
  if (!fingerprint) return null;
  if (typeof value.threadKey !== "string" || !/^[a-f0-9]{24}$/.test(value.threadKey)) return null;
  if (!isTimestamp(value.startedAt) || !isTimestamp(value.observedAt)) return null;
  if (value.legacyProviderKey !== null && (
    typeof value.legacyProviderKey !== "string" || !/^[a-f0-9]{24}$/.test(value.legacyProviderKey)
  )) return null;
  if (typeof value.openAiProvider !== "boolean") return null;
  if (value.historicalSubjectId !== null && (
    typeof value.historicalSubjectId !== "string" || !isSubjectId(value.historicalSubjectId)
  )) return null;
  if (typeof value.historicalAttributionLocked !== "boolean") return null;
  const inheritedBaseline = parseTokenTotals(value.inheritedBaseline);
  const lastCumulative = parseTokenTotals(value.lastCumulative);
  const historicalTokens = parseTokenTotals(value.historicalTokens);
  const tokens = parseTokenTotals(value.tokens);
  if (!inheritedBaseline || !lastCumulative || !historicalTokens || !tokens) return null;
  if (!Array.isArray(value.increments)) return null;
  const increments: UsageIncrement[] = [];
  for (const increment of value.increments) {
    if (!isRecord(increment)) return null;
    if (increment.at !== null && !isTimestamp(increment.at)) return null;
    const incrementTokens = parseTokenTotals(increment.tokens);
    if (!incrementTokens) return null;
    increments.push({ at: increment.at, tokens: incrementTokens });
  }
  if (!Number.isSafeInteger(value.appendOffset) || value.appendOffset < 0) return null;
  if (value.appendOffset > fingerprint.size) return null;
  if (typeof value.appendGuard !== "string" || !/^[a-f0-9]{24}$/.test(value.appendGuard)) {
    return null;
  }
  if (typeof value.timelineTracked !== "boolean") return null;
  return {
    fingerprint,
    threadKey: value.threadKey,
    startedAt: value.startedAt,
    observedAt: value.observedAt,
    legacyProviderKey: value.legacyProviderKey,
    openAiProvider: value.openAiProvider,
    historicalSubjectId: value.historicalSubjectId,
    historicalAttributionLocked: value.historicalAttributionLocked,
    inheritedBaseline,
    lastCumulative,
    historicalTokens,
    increments,
    appendOffset: value.appendOffset,
    appendGuard: value.appendGuard,
    timelineTracked: value.timelineTracked,
    tokens,
  };
}

function parseFingerprint(value: unknown): Fingerprint | null {
  if (!isRecord(value)) return null;
  if (![value.size, value.mtimeMs, value.ctimeMs].every(isNonNegativeFinite)) return null;
  return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function parseTokenTotals(value: unknown): TokenTotals | null {
  if (!isRecord(value)) return null;
  const fields = [
    value.inputTokens,
    value.cachedInputTokens,
    value.outputTokens,
    value.reasoningOutputTokens,
    value.totalTokens,
  ];
  if (!fields.every(isTokenInteger)) return null;
  return {
    inputTokens: fields[0] as number,
    cachedInputTokens: fields[1] as number,
    outputTokens: fields[2] as number,
    reasoningOutputTokens: fields[3] as number,
    totalTokens: fields[4] as number,
  };
}

function sanitizeSubject(subject: UsageSubject): UsageSubject {
  if (!subject || (subject.kind !== "account" && subject.kind !== "provider")) {
    throw new Error("A valid usage subject kind is required");
  }
  const id = subject.id.trim();
  const label = subject.label.trim();
  if (!id || !label) throw new Error("A usage subject requires an ID and label");
  if (!isSubjectId(id, subject.kind)) {
    throw new Error("Usage subject IDs must be created with stableSubjectId");
  }
  return {
    id,
    kind: subject.kind,
    label,
    ...(subject.legacyProviderIds
      ? { legacyProviderIds: subject.legacyProviderIds.map((value) => value.trim()).filter(Boolean) }
      : {}),
  };
}

function mergeLegacyProviderIds(
  first: Pick<UsageSubject, "legacyProviderIds"> | undefined,
  second: Pick<UsageSubject, "legacyProviderIds"> | undefined,
): string[] {
  return [...new Set([
    ...(first?.legacyProviderIds ?? []),
    ...(second?.legacyProviderIds ?? []),
  ].map((value) => value.trim()).filter(Boolean))];
}

function preferRecord(candidate: SessionUsageRecord, previous: SessionUsageRecord): boolean {
  if (candidate.observedAt !== previous.observedAt) return candidate.observedAt > previous.observedAt;
  if (candidate.tokens.totalTokens !== previous.tokens.totalTokens) {
    return candidate.tokens.totalTokens > previous.tokens.totalTokens;
  }
  return candidate.fingerprint.mtimeMs > previous.fingerprint.mtimeMs;
}

function fingerprintOf(stat: { size: number; mtimeMs: number; ctimeMs: number }): Fingerprint {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function providerKey(providerId: string): string | null {
  const normalized = providerId.trim().toLowerCase();
  return normalized ? digest(`provider\0${normalized}`) : null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function digestBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return isTimestamp(value) ? value : null;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return isTimestamp(timestamp) ? timestamp : null;
}

function validTimestamp(value: unknown): number | null {
  return isTimestamp(value) ? value : null;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTokenInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeDuration(value: number | undefined, fallback: number, allowZero: boolean): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error("Usage timing values must be finite positive milliseconds");
  }
  return Math.floor(value);
}

function zeroTokens(): TokenTotals {
  return cloneTokens(EMPTY_TOKENS);
}

function cloneTokens(tokens: Readonly<TokenTotals>): TokenTotals {
  return { ...tokens };
}

function addTokens(target: TokenTotals, source: Readonly<TokenTotals>): void {
  target.inputTokens = safeSum(target.inputTokens, source.inputTokens);
  target.cachedInputTokens = safeSum(target.cachedInputTokens, source.cachedInputTokens);
  target.outputTokens = safeSum(target.outputTokens, source.outputTokens);
  target.reasoningOutputTokens = safeSum(target.reasoningOutputTokens, source.reasoningOutputTokens);
  target.totalTokens = safeSum(target.totalTokens, source.totalTokens);
}

function subtractFloor(current: TokenTotals, baseline: TokenTotals): TokenTotals {
  return {
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - baseline.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - baseline.reasoningOutputTokens),
    totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
  };
}

function hasTokens(tokens: Readonly<TokenTotals>): boolean {
  return tokens.totalTokens > 0
    || tokens.inputTokens > 0
    || tokens.cachedInputTokens > 0
    || tokens.outputTokens > 0
    || tokens.reasoningOutputTokens > 0;
}

function safeSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

interface MutableDailyTokenUsage {
  date: string;
  total: TokenTotals;
  unattributed: TokenTotals;
  estimated: TokenTotals;
  estimatedUnattributed: TokenTotals;
  subjects: Map<string, { tokens: TokenTotals; estimated: TokenTotals }>;
}

function addHistoryTokens(
  days: Map<string, MutableDailyTokenUsage>,
  undated: TokenTotals,
  tokens: Readonly<TokenTotals>,
  subjectId: string | null,
  timestamp: number | null,
  estimated: boolean,
): void {
  const date = utcDate(timestamp);
  if (!date) {
    addTokens(undated, tokens);
    return;
  }
  let day = days.get(date);
  if (!day) {
    day = {
      date,
      total: zeroTokens(),
      unattributed: zeroTokens(),
      estimated: zeroTokens(),
      estimatedUnattributed: zeroTokens(),
      subjects: new Map(),
    };
    days.set(date, day);
  }
  addTokens(day.total, tokens);
  if (estimated) addTokens(day.estimated, tokens);
  if (!subjectId) {
    addTokens(day.unattributed, tokens);
    if (estimated) addTokens(day.estimatedUnattributed, tokens);
    return;
  }
  const subject = day.subjects.get(subjectId) ?? {
    tokens: zeroTokens(),
    estimated: zeroTokens(),
  };
  addTokens(subject.tokens, tokens);
  if (estimated) addTokens(subject.estimated, tokens);
  day.subjects.set(subjectId, subject);
}

function utcDate(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  try {
    return new Date(timestamp).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function projectDailyTokenUsage(day: MutableDailyTokenUsage): DailyTokenUsage {
  return {
    date: day.date,
    total: cloneTokens(day.total),
    unattributed: cloneTokens(day.unattributed),
    estimated: cloneTokens(day.estimated),
    estimatedUnattributed: cloneTokens(day.estimatedUnattributed),
    subjects: [...day.subjects]
      .map(([id, usage]) => ({
        id,
        tokens: cloneTokens(usage.tokens),
        estimated: cloneTokens(usage.estimated),
      }))
      .sort((left, right) => (
        right.tokens.totalTokens - left.tokens.totalTokens || left.id.localeCompare(right.id)
      )),
  };
}

function emptySnapshot(): UsageSnapshot {
  return {
    updatedAt: 0,
    trackingStartedAt: null,
    status: "uninitialized",
    coverage: "partial",
    lastError: null,
    sessionCount: 0,
    total: zeroTokens(),
    unattributed: zeroTokens(),
    subjects: [],
    history: { days: [], undated: zeroTokens() },
    scan: {
      discoveredFiles: 0,
      rescannedFiles: 0,
      reusedFiles: 0,
      errors: 0,
      bytesRead: 0,
      chunksRead: 0,
    },
  };
}

function cloneSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  return {
    ...snapshot,
    total: cloneTokens(snapshot.total),
    unattributed: cloneTokens(snapshot.unattributed),
    subjects: snapshot.subjects.map((subject) => ({
      ...subject,
      ...(subject.legacyProviderIds ? { legacyProviderIds: [...subject.legacyProviderIds] } : {}),
      tokens: cloneTokens(subject.tokens),
    })),
    history: {
      days: snapshot.history.days.map((day) => ({
        ...day,
        total: cloneTokens(day.total),
        unattributed: cloneTokens(day.unattributed),
        estimated: cloneTokens(day.estimated),
        estimatedUnattributed: cloneTokens(day.estimatedUnattributed),
        subjects: day.subjects.map((subject) => ({
          ...subject,
          tokens: cloneTokens(subject.tokens),
          estimated: cloneTokens(subject.estimated),
        })),
      })),
      undated: cloneTokens(snapshot.history.undated),
    },
    scan: { ...snapshot.scan },
  };
}

function snapshotUsageSignature(snapshot: UsageSnapshot): string {
  return JSON.stringify({
    trackingStartedAt: snapshot.trackingStartedAt,
    status: snapshot.status,
    coverage: snapshot.coverage,
    lastError: snapshot.lastError,
    sessionCount: snapshot.sessionCount,
    total: snapshot.total,
    unattributed: snapshot.unattributed,
    subjects: snapshot.subjects.map(({ id, kind, label, sessionCount, tokens }) => ({
      id,
      kind,
      label,
      sessionCount,
      tokens,
    })),
    history: snapshot.history,
  });
}

function kindFromId(id: string): UsageSubjectKind {
  return id.startsWith("account:") ? "account" : "provider";
}

function isSubjectId(value: string, kind?: UsageSubjectKind): boolean {
  const match = value.match(/^(account|provider):[a-f0-9]{24}$/);
  return Boolean(match && (!kind || match[1] === kind));
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
