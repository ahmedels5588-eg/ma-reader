const API_KEY_STORAGE_KEY = "ma-reader-web.gemini-api-key";

export function loadApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
}

export function saveApiKey(apiKey: string): void {
  localStorage.setItem(API_KEY_STORAGE_KEY, apiKey.trim());
}

export function deleteApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}
