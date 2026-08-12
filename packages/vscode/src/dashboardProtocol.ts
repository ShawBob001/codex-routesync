export type DashboardAction =
  | "refreshDashboard"
  | "switchMode"
  | "setAutoSwitch"
  | "configureAutoSwitch"
  | "addAccount"
  | "addProvider"
  | "reloginAccount"
  | "unlockStorage"
  | "reloadWindow";

export type DashboardClientMessage =
  | { type: "dashboard.ready" }
  | { type: "dashboard.action"; requestId: string; action: "refreshDashboard" }
  | { type: "dashboard.action"; requestId: string; action: "switchMode" }
  | { type: "dashboard.action"; requestId: string; action: "setAutoSwitch"; enabled: boolean }
  | { type: "dashboard.action"; requestId: string; action: "configureAutoSwitch" }
  | { type: "dashboard.action"; requestId: string; action: "addAccount" }
  | { type: "dashboard.action"; requestId: string; action: "addProvider" }
  | { type: "dashboard.action"; requestId: string; action: "reloginAccount"; targetId: string }
  | { type: "dashboard.action"; requestId: string; action: "unlockStorage"; targetId: string }
  | { type: "dashboard.action"; requestId: string; action: "reloadWindow" };

const ACTIONS = new Set<DashboardAction>([
  "refreshDashboard",
  "switchMode",
  "setAutoSwitch",
  "configureAutoSwitch",
  "addAccount",
  "addProvider",
  "reloginAccount",
  "unlockStorage",
  "reloadWindow",
]);

const TARGETED_ACTIONS = new Set<DashboardAction>([
  "reloginAccount",
  "unlockStorage",
]);

export function parseDashboardClientMessage(value: unknown): DashboardClientMessage | null {
  if (!isPlainRecord(value)) return null;
  if (value.type === "dashboard.ready") {
    return hasExactKeys(value, ["type"])
      ? { type: "dashboard.ready" }
      : null;
  }
  if (value.type !== "dashboard.action") return null;
  if (!isBoundedString(value.requestId, 1, 128)) return null;
  if (typeof value.action !== "string" || !ACTIONS.has(value.action as DashboardAction)) return null;

  const action = value.action as DashboardAction;
  if (action === "setAutoSwitch") {
    if (!hasExactKeys(value, ["type", "requestId", "action", "enabled"])) return null;
    if (typeof value.enabled !== "boolean") return null;
    return {
      type: "dashboard.action",
      requestId: value.requestId,
      action,
      enabled: value.enabled,
    };
  }

  if (TARGETED_ACTIONS.has(action)) {
    if (!hasExactKeys(value, ["type", "requestId", "action", "targetId"])) return null;
    if (!isBoundedString(value.targetId, 1, 256)) return null;
    if (action === "reloginAccount") {
      return {
        type: "dashboard.action",
        requestId: value.requestId,
        action,
        targetId: value.targetId,
      };
    }
    return {
      type: "dashboard.action",
      requestId: value.requestId,
      action: "unlockStorage",
      targetId: value.targetId,
    };
  }

  if (!hasExactKeys(value, ["type", "requestId", "action"])) return null;
  return {
    type: "dashboard.action",
    requestId: value.requestId,
    action,
  } as DashboardClientMessage;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
