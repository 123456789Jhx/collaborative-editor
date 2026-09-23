import { LOCALES, MESSAGES, type Locale, type MessageKey } from "./messages.js";

/**
 * The current interface language, as a module-level value with subscribers.
 *
 * Every touch of `localStorage` and `document` is behind a `typeof` guard. That
 * is not defensiveness for its own sake: the test project runs in Node with no
 * DOM at all, and keeping the locale logic loadable there is what makes the
 * "both dictionaries have the same keys" assertion possible.
 */

/** Hard default. The browser's `Accept-Language` is deliberately ignored. */
export const DEFAULT_LOCALE: Locale = "zh";

const STORAGE_KEY = "collab.locale";

/**
 * Returns null where storage is unavailable or blocked. Reading it can throw
 * rather than return null (Safari private mode, storage disabled by policy),
 * and losing a language preference is not worth breaking the page over.
 */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(MESSAGES.en, value);
}

function readStoredLocale(): Locale {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

let current: Locale = readStoredLocale();

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/**
 * The string for `key` in the current locale.
 *
 * An unknown key returns the key itself rather than throwing or rendering
 * `undefined`: a missing string should look wrong on screen, not take the page
 * down. `zh` is typed as a complete record, so this is unreachable for it.
 */
export function t(key: MessageKey): string {
  return MESSAGES[current][key] ?? key;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;

  try {
    storage()?.setItem(STORAGE_KEY, next);
  } catch {
    // Quota or a read-only store. The switch still applies to this page.
  }

  for (const listener of [...listeners]) listener();
}

/** Subscribes to locale changes. Returns the unsubscribe function. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fills every `[data-i18n]` element in `root` with the text for its key.
 *
 * Text-only by design: the one translated attribute in this app (the editor's
 * `aria-label`) is set by the component that owns that element, which is
 * already re-rendering on a language change.
 */
export function applyStaticText(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset["i18n"];
    if (key !== undefined && isMessageKey(key)) element.textContent = t(key);
  }
}

/**
 * Applies the current locale to the document as a whole: `<html lang>`, which
 * screen readers and the browser's own spellcheck/translation follow, plus the
 * static text in the markup. Call once on boot and again on every change.
 */
export function applyLocaleGlobally(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = current;
  applyStaticText(document);
}
