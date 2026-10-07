/**
 * Per-browser storage (replaces %AppData%\BimGo\settings.json). Storage can be missing or throw (private windows,
 * blocked site data), so every access is guarded and callers get their default back.
 */

const PREFIX = 'bimgo.';

/** Reads a JSON value, or the fallback when missing, unreadable or blocked. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Writes a JSON value; failures are ignored (the app keeps working without storage). */
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage blocked or full
  }
}
