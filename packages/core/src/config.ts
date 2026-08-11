import * as fs from "fs";
import * as path from "path";
import { getCodexConfigDir, getCodexConfigPath } from "./paths";
import { ProviderConfig } from "./types";

export interface OptionalTopLevelString {
  present: boolean;
  value: string | null;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function trimLeadingBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start += 1;
  }
  return lines.slice(start);
}

function ensureConfigDir(): void {
  fs.mkdirSync(getCodexConfigDir(), { recursive: true });
}

function readConfigText(): string {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) {
    return "";
  }
  return fs.readFileSync(configPath, "utf-8");
}

function resolveConfigWriteTarget(target: string): string {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      return fs.realpathSync(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return target;
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some platforms/filesystems do not allow directory fsync.
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
  }
}

function writeConfigText(text: string): void {
  ensureConfigDir();
  const configuredTarget = getCodexConfigPath();
  const target = resolveConfigWriteTarget(configuredTarget);
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o7777 : 0o600;
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor: number | null = null;

  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, text, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, target);
    fsyncDirectoryBestEffort(path.dirname(target));
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function isTableHeader(line: string): boolean {
  return getTableHeader(line) !== null;
}

function getTableHeader(line: string): string | null {
  const trimmed = line.trim();
  const isArrayTable = trimmed.startsWith("[[");
  if (!isArrayTable && !trimmed.startsWith("[")) {
    return null;
  }

  const openingLength = isArrayTable ? 2 : 1;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = openingLength; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" || character === "[") {
      return null;
    }
    if (character !== "]") {
      continue;
    }

    const closingLength = isArrayTable ? 2 : 1;
    if (isArrayTable && trimmed[index + 1] !== "]") {
      return null;
    }
    const end = index + closingLength;
    const remainder = trimmed.slice(end).trimStart();
    if (remainder.length === 0 || remainder.startsWith("#")) {
      return trimmed.slice(0, end);
    }
    return null;
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function topLevelKeyPattern(key: string): RegExp {
  return new RegExp(`^${escapeRegExp(key)}\\s*=`);
}

function renderTablePathSegment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function getProviderTableHeaders(providerName: string): string[] {
  const safeHeader = `[model_providers.${renderTablePathSegment(providerName)}]`;
  const legacyHeader = `[model_providers.${providerName}]`;
  return safeHeader === legacyHeader ? [safeHeader] : [safeHeader, legacyHeader];
}

function findTableBlock(lines: string[], headers: string[]): { start: number; end: number } | null {
  const normalizedHeaders = new Set(headers);
  const start = lines.findIndex((line) => {
    const header = getTableHeader(line);
    return header !== null && normalizedHeaders.has(header);
  });
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isTableHeader(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function removeTopLevelKey(lines: string[], key: string): string[] {
  const nextLines: string[] = [];
  const pattern = topLevelKeyPattern(key);
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (isTableHeader(trimmed)) {
      inTable = true;
      nextLines.push(line);
      continue;
    }

    if (!inTable && pattern.test(trimmed)) {
      continue;
    }

    nextLines.push(line);
  }

  return nextLines;
}

function upsertTopLevelString(lines: string[], key: string, value: string): string[] {
  const assignment = `${key} = ${JSON.stringify(value)}`;
  const pattern = topLevelKeyPattern(key);
  const nextLines: string[] = [];
  let inTable = false;
  let replaced = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (isTableHeader(trimmed)) {
      inTable = true;
    }

    if (!inTable && pattern.test(trimmed)) {
      if (!replaced) {
        nextLines.push(assignment);
        replaced = true;
      }
      continue;
    }

    nextLines.push(line);
  }

  if (replaced) {
    return nextLines;
  }

  if (nextLines.length === 0) {
    return [assignment, ""];
  }

  let insertAt = 0;
  while (insertAt < nextLines.length) {
    const trimmed = nextLines[insertAt].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      insertAt += 1;
      continue;
    }
    break;
  }

  nextLines.splice(insertAt, 0, assignment);
  return nextLines;
}

function removeTopLevelModelProvider(lines: string[]): string[] {
  return removeTopLevelKey(lines, "model_provider");
}

function upsertTopLevelModelProvider(lines: string[], providerName: string): string[] {
  const nextLines = upsertTopLevelString(lines, "model_provider", providerName);
  const assignmentIndex = nextLines.findIndex((line) => topLevelKeyPattern("model_provider").test(line.trim()));
  if (assignmentIndex + 1 < nextLines.length && nextLines[assignmentIndex + 1].trim() !== "") {
    nextLines.splice(assignmentIndex + 1, 0, "");
  }
  return nextLines;
}

function upsertKey(lines: string[], key: string, value: string): string[] {
  const rendered = `${key} = ${JSON.stringify(value)}`;
  let replaced = false;
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (match?.[1] === key) {
      replaced = true;
      return rendered;
    }
    return line;
  });

  if (!replaced) {
    nextLines.push(rendered);
  }
  return nextLines;
}

function upsertProviderTable(lines: string[], providerName: string, config: ProviderConfig): string[] {
  const [normalizedHeader] = getProviderTableHeaders(providerName);
  const block = findTableBlock(lines, getProviderTableHeaders(providerName));
  const payload = [
    `name = ${JSON.stringify(config.name)}`,
    `base_url = ${JSON.stringify(config.base_url)}`,
    `wire_api = ${JSON.stringify(config.wire_api)}`,
  ];

  if (!block) {
    const nextLines = [...lines];
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== "") {
      nextLines.push("");
    }
    nextLines.push(normalizedHeader);
    nextLines.push(...payload);
    return nextLines;
  }

  let sectionLines = lines.slice(block.start + 1, block.end);
  sectionLines = upsertKey(sectionLines, "name", config.name);
  sectionLines = upsertKey(sectionLines, "base_url", config.base_url);
  sectionLines = upsertKey(sectionLines, "wire_api", config.wire_api);

  return [
    ...lines.slice(0, block.start),
    normalizedHeader,
    ...sectionLines,
    ...lines.slice(block.end),
  ];
}

function removeProviderTable(lines: string[], providerName: string): string[] {
  const block = findTableBlock(lines, getProviderTableHeaders(providerName));
  if (!block) {
    return lines;
  }

  return [
    ...lines.slice(0, block.start),
    ...lines.slice(block.end),
  ];
}

export function getActiveModelProvider(): string | null {
  const text = readConfigText();
  if (!text) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let currentTable: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const tableHeader = getTableHeader(trimmed);
    if (tableHeader !== null) {
      currentTable = tableHeader;
      continue;
    }

    if (currentTable != null) {
      continue;
    }

    const match = trimmed.match(/^model_provider\s*=\s*(["'])(.+)\1\s*(#.*)?$/);
    if (match) {
      return match[2];
    }
  }

  return null;
}

export function getOpenAIBaseUrlSnapshot(): OptionalTopLevelString {
  const text = readConfigText();
  let inTable = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (isTableHeader(trimmed)) {
      inTable = true;
    }
    if (inTable) {
      continue;
    }

    const match = trimmed.match(/^openai_base_url\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/);
    if (match) {
      return { present: true, value: match[2] };
    }
  }

  return { present: false, value: null };
}

export function setOpenAIBaseUrl(value: string): void {
  const currentText = readConfigText();
  const eol = detectEol(currentText);
  const lines = currentText ? currentText.split(/\r?\n/) : [];
  const nextLines = trimLeadingBlankLines(upsertTopLevelString(lines, "openai_base_url", value));
  writeConfigText(nextLines.join(eol).replace(/(?:\r?\n)+$/, "") + eol);
}

export function restoreOpenAIBaseUrl(snapshot: OptionalTopLevelString): void {
  if (snapshot.present && snapshot.value !== null) {
    setOpenAIBaseUrl(snapshot.value);
    return;
  }

  const currentText = readConfigText();
  const eol = detectEol(currentText);
  const lines = currentText ? currentText.split(/\r?\n/) : [];
  const nextLines = trimLeadingBlankLines(removeTopLevelKey(lines, "openai_base_url"));
  writeConfigText(nextLines.join(eol).replace(/(?:\r?\n)+$/, nextLines.length > 0 ? eol : ""));
}

export function activateProviderThroughOpenAI(providerName: string, config: ProviderConfig): void {
  if (config.wire_api !== "responses") {
    throw new Error('Shared history requires wire_api = "responses".');
  }

  if (typeof config.base_url !== "string" || !config.base_url.trim()) {
    throw new Error("Shared history requires a provider base URL.");
  }

  const currentText = readConfigText();
  const eol = detectEol(currentText);
  let lines = currentText ? currentText.split(/\r?\n/) : [];
  lines = removeTopLevelModelProvider(lines);
  lines = upsertTopLevelString(lines, "openai_base_url", config.base_url.trim());
  lines = upsertProviderTable(lines, providerName, config);
  lines = trimLeadingBlankLines(lines);
  writeConfigText(lines.join(eol).replace(/(?:\r?\n)+$/, "") + eol);
}

export function activateProviderConfig(providerName: string, config: ProviderConfig): void {
  const currentText = readConfigText();
  const eol = detectEol(currentText);
  let lines = currentText ? currentText.split(/\r?\n/) : [];
  lines = upsertTopLevelModelProvider(lines, providerName);
  lines = upsertProviderTable(lines, providerName, config);
  lines = trimLeadingBlankLines(lines);
  writeConfigText(lines.join(eol).replace(/(?:\r?\n)+$/, "") + eol);
}

export function clearActiveModelProvider(): void {
  const currentText = readConfigText();
  const eol = detectEol(currentText);
  const lines = currentText ? currentText.split(/\r?\n/) : [];
  const nextLines = trimLeadingBlankLines(removeTopLevelModelProvider(lines));
  writeConfigText(nextLines.join(eol).replace(/(?:\r?\n)+$/, nextLines.length > 0 ? eol : ""));
}

export function removeProviderConfig(providerName: string): void {
  const currentText = readConfigText();
  const eol = detectEol(currentText);
  let lines = currentText ? currentText.split(/\r?\n/) : [];

  if (getActiveModelProvider() === providerName) {
    lines = removeTopLevelModelProvider(lines);
  }

  lines = removeProviderTable(lines, providerName);
  lines = trimLeadingBlankLines(lines);
  writeConfigText(lines.join(eol).replace(/(?:\r?\n)+$/, lines.length > 0 ? eol : ""));
}
