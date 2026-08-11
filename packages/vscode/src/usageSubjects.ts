import type {
  SavedAccountInfo,
  SavedProviderInfo,
  SavedSelection,
  StorageSource,
} from "./savedEntries";
import { stableSubjectId, UsageSubject, UsageSubjectKind } from "./tokenUsage";

interface SavedUsageIdentity {
  id: string;
  name: string;
  source: StorageSource;
}

function sourceLabel(source: StorageSource): string {
  return source === "cloud" ? "Cloud" : "Local";
}

export function savedEntryUsageSubject(
  kind: UsageSubjectKind,
  entry: SavedUsageIdentity,
): UsageSubject {
  return {
    id: stableSubjectId(kind, entry.id),
    kind,
    label: `${entry.name} (${sourceLabel(entry.source)})`,
    ...(kind === "provider" ? { legacyProviderIds: [entry.name] } : {}),
  };
}

export function selectionUsageSubject(selection: SavedSelection): UsageSubject | null {
  if (selection.kind === "unknown") return null;
  return savedEntryUsageSubject(selection.kind, {
    id: `${selection.source}:${selection.name}`,
    name: selection.name,
    source: selection.source,
  });
}

export function knownUsageSubjects(
  accounts: readonly SavedAccountInfo[],
  providers: readonly SavedProviderInfo[],
): UsageSubject[] {
  return [
    ...accounts.map((account) => savedEntryUsageSubject("account", account)),
    ...providers.map((provider) => savedEntryUsageSubject("provider", provider)),
  ];
}
