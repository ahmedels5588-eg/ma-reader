import type { AppSettings } from "./types";

const API_KEY_STORAGE_KEY = "ma-reader-web.gemini-api-key";
const API_KEYS_STORAGE_KEY = "ma-reader-web.gemini-api-keys";
const SETTINGS_STORAGE_KEY = "ma-reader-web.settings";

export function loadApiKey(): string {
  return loadApiKeys().join("\n");
}

export function saveApiKey(apiKey: string): void {
  saveApiKeys(apiKey.split(/\r?\n/));
}

export function deleteApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  localStorage.removeItem(API_KEYS_STORAGE_KEY);
}

export function loadApiKeys(): string[] {
  const rawKeys = localStorage.getItem(API_KEYS_STORAGE_KEY);
  if (rawKeys) {
    try {
      const parsed = JSON.parse(rawKeys) as unknown;
      if (Array.isArray(parsed)) {
        return normalizeApiKeys(parsed.map(String));
      }
    } catch {
      return normalizeApiKeys(rawKeys.split(/\r?\n/));
    }
  }

  const legacyKey = localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  return normalizeApiKeys(legacyKey.split(/\r?\n/));
}

export function saveApiKeys(apiKeys: string[]): void {
  const keys = normalizeApiKeys(apiKeys);
  localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys));
  localStorage.setItem(API_KEY_STORAGE_KEY, keys[0] ?? "");
}

export function normalizeApiKeys(values: string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const value of values) {
    const key = value.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }

  return keys;
}

export function loadSettings(): Partial<AppSettings> {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
