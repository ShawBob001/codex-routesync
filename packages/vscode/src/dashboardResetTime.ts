export type ResetTimeLocale = "en" | "zh-cn";

export type ResetCountdownState =
  | {
      kind: "scheduled";
      totalSeconds: number;
      days: number;
      hours: number;
      minutes: number;
      seconds: number;
    }
  | { kind: "due" }
  | { kind: "unavailable" };

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

export function parseResetEpochMs(resetsAt: string | null | undefined): number | null {
  if (typeof resetsAt !== "string" || resetsAt.trim() === "") return null;
  const match = /^([+-]?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(resetsAt);
  if (!match) return null;
  const epochMs = Date.parse(resetsAt);
  if (!Number.isFinite(epochMs)) return null;
  const normalized = new Date(epochMs).toISOString();
  const expected = match[7] == null ? resetsAt.replace(/Z$/, ".000Z") : resetsAt;
  return normalized === expected ? epochMs : null;
}

export function getResetCountdown(
  resetsAt: string | null | undefined,
  nowMs: number,
): ResetCountdownState {
  if (!Number.isFinite(nowMs)) return { kind: "unavailable" };

  const resetEpochMs = parseResetEpochMs(resetsAt);
  if (resetEpochMs === null) return { kind: "unavailable" };
  if (resetEpochMs <= nowMs) return { kind: "due" };

  const totalSeconds = Math.max(1, Math.ceil((resetEpochMs - nowMs) / 1_000));
  const secondsWithinDay = totalSeconds % SECONDS_PER_DAY;
  const secondsWithinHour = secondsWithinDay % SECONDS_PER_HOUR;

  return {
    kind: "scheduled",
    totalSeconds,
    days: Math.floor(totalSeconds / SECONDS_PER_DAY),
    hours: Math.floor(secondsWithinDay / SECONDS_PER_HOUR),
    minutes: Math.floor(secondsWithinHour / SECONDS_PER_MINUTE),
    seconds: secondsWithinHour % SECONDS_PER_MINUTE,
  };
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatResetCountdown(
  state: ResetCountdownState,
  locale: ResetTimeLocale,
): string | null {
  if (state.kind !== "scheduled") return null;

  const hours = padTwo(state.hours);
  const minutes = padTwo(state.minutes);
  const seconds = padTwo(state.seconds);
  if (locale === "zh-cn") {
    const days = state.days > 0 ? `${state.days}天 ` : "";
    return `${days}${hours}小时 ${minutes}分 ${seconds}秒`;
  }

  const days = state.days > 0 ? `${state.days}d ` : "";
  return `${days}${hours}h ${minutes}m ${seconds}s`;
}

export function formatResetLocalTime(
  resetsAt: string | null | undefined,
  locale: ResetTimeLocale,
): string | null {
  const resetEpochMs = parseResetEpochMs(resetsAt);
  if (resetEpochMs === null) return null;

  return new Intl.DateTimeFormat(locale === "zh-cn" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).format(new Date(resetEpochMs));
}

export function formatResetUtcIso(resetsAt: string | null | undefined): string | null {
  const resetEpochMs = parseResetEpochMs(resetsAt);
  return resetEpochMs === null ? null : new Date(resetEpochMs).toISOString();
}
