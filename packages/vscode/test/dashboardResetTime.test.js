const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatResetCountdown,
  formatResetLocalTime,
  formatResetUtcIso,
  getResetCountdown,
  parseResetEpochMs,
} = require("../dist/dashboardResetTime.js");

const NOW_MS = Date.parse("2026-08-13T12:00:00.000Z");

function resetAfter(milliseconds) {
  return new Date(NOW_MS + milliseconds).toISOString();
}

test("missing and invalid reset times are unavailable", () => {
  for (const resetsAt of [
    undefined,
    null,
    "",
    "not-a-date",
    "08/13/2026",
    "2026-08-13",
    "2026-02-30T00:00:00.000Z",
    "2026-08-13T12:00:00+08:00",
  ]) {
    assert.deepEqual(getResetCountdown(resetsAt, NOW_MS), { kind: "unavailable" });
    assert.equal(parseResetEpochMs(resetsAt), null);
  }
});

test("countdown requires a finite injected current time", () => {
  const resetsAt = resetAfter(1_000);

  for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(getResetCountdown(resetsAt, nowMs), { kind: "unavailable" });
  }
});

test("future countdowns round up partial seconds", () => {
  assert.deepEqual(getResetCountdown(resetAfter(1), NOW_MS), {
    kind: "scheduled",
    totalSeconds: 1,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 1,
  });
  assert.equal(getResetCountdown(resetAfter(1_001), NOW_MS).totalSeconds, 2);
  assert.equal(
    getResetCountdown("1970-01-01T00:00:00.000Z", -Number.MIN_VALUE).totalSeconds,
    1,
  );
});

test("a reset at or before now is due", () => {
  assert.deepEqual(getResetCountdown(resetAfter(0), NOW_MS), { kind: "due" });
  assert.deepEqual(getResetCountdown(resetAfter(-1), NOW_MS), { kind: "due" });
});

test("scheduled countdowns split exact day, hour, minute, and second fields", () => {
  const durationSeconds = (2 * 24 * 60 * 60) + (3 * 60 * 60) + (4 * 60) + 5;
  assert.deepEqual(getResetCountdown(resetAfter(durationSeconds * 1_000), NOW_MS), {
    kind: "scheduled",
    totalSeconds: durationSeconds,
    days: 2,
    hours: 3,
    minutes: 4,
    seconds: 5,
  });
});

test("countdown formatting is compact, padded, and localized", () => {
  const withDays = {
    kind: "scheduled",
    totalSeconds: 183_845,
    days: 2,
    hours: 3,
    minutes: 4,
    seconds: 5,
  };
  const withoutDays = { ...withDays, totalSeconds: 11_045, days: 0 };

  assert.equal(formatResetCountdown(withDays, "en"), "2d 03h 04m 05s");
  assert.equal(formatResetCountdown(withDays, "zh-cn"), "2天 03小时 04分 05秒");
  assert.equal(formatResetCountdown(withoutDays, "en"), "03h 04m 05s");
  assert.equal(formatResetCountdown(withoutDays, "zh-cn"), "03小时 04分 05秒");
  assert.equal(formatResetCountdown({ kind: "due" }, "en"), null);
  assert.equal(formatResetCountdown({ kind: "unavailable" }, "zh-cn"), null);
});

test("local reset time includes the local date, seconds, and a time-zone label", () => {
  const resetsAt = "2026-08-13T14:05:12.345Z";
  const localDate = new Date(resetsAt);

  for (const locale of ["en", "zh-cn"]) {
    const formatted = formatResetLocalTime(resetsAt, locale);
    assert.equal(typeof formatted, "string");
    assert.match(formatted, new RegExp(String(localDate.getFullYear())));
    assert.ok(formatted.includes(String(localDate.getMonth() + 1).padStart(2, "0")));
    assert.ok(formatted.includes(String(localDate.getDate()).padStart(2, "0")));
    assert.ok(formatted.includes(String(localDate.getSeconds()).padStart(2, "0")));
    assert.match(formatted, /(?:GMT|UTC)/i);
  }

  assert.equal(formatResetLocalTime("invalid", "en"), null);
});

test("UTC reset formatting preserves milliseconds and normalizes whole seconds", () => {
  assert.equal(
    formatResetUtcIso("2026-08-13T14:05:12.345Z"),
    "2026-08-13T14:05:12.345Z",
  );
  assert.equal(
    formatResetUtcIso("2026-08-13T14:05:12Z"),
    "2026-08-13T14:05:12.000Z",
  );
  assert.equal(formatResetUtcIso("invalid"), null);
});

test("very distant valid reset dates still produce finite non-negative fields", () => {
  const resetsAt = "+275760-09-12T23:59:59.999Z";
  const parsed = parseResetEpochMs(resetsAt);

  assert.equal(Number.isFinite(parsed), true);
  for (const nowMs of [0, -Number.MAX_VALUE]) {
    const countdown = getResetCountdown(resetsAt, nowMs);
    assert.equal(countdown.kind, "scheduled");
    for (const field of ["totalSeconds", "days", "hours", "minutes", "seconds"]) {
      assert.equal(Number.isFinite(countdown[field]), true, `${field} must be finite`);
      assert.ok(countdown[field] >= 0, `${field} must be non-negative`);
    }
  }
});
