import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCALE, getLocale, onLocaleChange, setLocale, t } from "./i18n.js";
import { detailKey, LOCALES, MESSAGES, type MessageKey } from "./messages.js";

// The locale is module state, so every test has to leave it where it found it.
afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe("the dictionary", () => {
  it("covers every locale", () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...LOCALES].sort());
  });

  it("has exactly the same keys in both languages", () => {
    expect(Object.keys(MESSAGES.zh).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it("has no empty entries", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
  });

  it("leaves no Chinese text in the English dictionary", () => {
    // Catches the likeliest slip: pasting the `zh` value into `en` and never
    // looking at the English page.
    const han = /\p{Script=Han}/u;
    for (const [key, value] of Object.entries(MESSAGES.en)) {
      expect(han.test(value), `en.${key} contains Han characters`).toBe(false);
    }
  });
});

describe("t", () => {
  it("defaults to Chinese", () => {
    expect(getLocale()).toBe("zh");
    expect(t("app.signOut")).toBe("退出登录");
  });

  it("switches languages, and back", () => {
    setLocale("en");
    expect(t("app.signOut")).toBe("Sign out");

    setLocale("zh");
    expect(t("app.signOut")).toBe("退出登录");
  });

  it("returns the key for a key that does not exist", () => {
    // Unreachable through the type, but a stale `data-i18n` attribute in the
    // markup arrives here as an arbitrary string.
    expect(t("auth.nope" as MessageKey)).toBe("auth.nope");
  });
});

describe("onLocaleChange", () => {
  it("notifies subscribers on a change", () => {
    const listener = vi.fn();
    onLocaleChange(listener);

    setLocale("en");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the locale is set to what it already is", () => {
    const listener = vi.fn();
    onLocaleChange(listener);

    setLocale("zh"); // already zh

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribing", () => {
    const listener = vi.fn();
    const unsubscribe = onLocaleChange(listener);

    unsubscribe();
    setLocale("en");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("detailKey", () => {
  it("maps a known server detail to a key that resolves", () => {
    const key = detailKey("PASSWORD_TOO_SHORT");
    expect(key).toBe("auth.err.PASSWORD_TOO_SHORT");
    expect(t(key as MessageKey)).not.toBe(key);
  });

  it("returns null for an absent or unrecognised detail", () => {
    // A detail the client has never heard of must fall back to generic copy
    // rather than showing the user a raw token like `SOMETHING_NEW`.
    expect(detailKey(undefined)).toBeNull();
    expect(detailKey("SOMETHING_NEW")).toBeNull();
  });
});
