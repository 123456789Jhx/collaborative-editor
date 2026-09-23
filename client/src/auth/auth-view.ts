import { ApiError, login, register, type ApiUser } from "../api/client.js";
import { requireElement } from "../dom.js";
import { t } from "../i18n/i18n.js";
import { detailKey, type MessageKey } from "../i18n/messages.js";

export type AuthMode = "login" | "register";

/** Which strings each mode shows. Resolved through `t` at render time, not at
 * module load, so a mode is re-rendered in whatever language is current. */
interface ModeCopy {
  title: MessageKey;
  subtitle: MessageKey;
  submit: MessageKey;
  switchPrompt: MessageKey;
  switchAction: MessageKey;
  /** Switches the browser between offering a saved password and a new one. */
  passwordAutocomplete: HTMLInputElement["autocomplete"];
}

const COPY: Record<AuthMode, ModeCopy> = {
  login: {
    title: "auth.title.login",
    subtitle: "auth.subtitle.login",
    submit: "auth.submit.login",
    switchPrompt: "auth.switchPrompt.login",
    switchAction: "auth.switchAction.login",
    passwordAutocomplete: "current-password",
  },
  register: {
    title: "auth.title.register",
    subtitle: "auth.subtitle.register",
    submit: "auth.submit.register",
    switchPrompt: "auth.switchPrompt.register",
    switchAction: "auth.switchAction.register",
    passwordAutocomplete: "new-password",
  },
};

export interface AuthViewOptions {
  onAuthenticated(user: ApiUser): void;
}

/**
 * The project's first form. It owns only the sign-in card; deciding what to
 * show once someone is signed in belongs to the boot flow in `main.ts`.
 */
export class AuthView {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly usernameInput: HTMLInputElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly errorBox: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly switchPrompt: HTMLElement;
  private readonly switchButton: HTMLButtonElement;
  private readonly options: AuthViewOptions;

  private mode: AuthMode = "login";
  private pending = false;

  constructor(options: AuthViewOptions) {
    this.options = options;
    this.root = requireElement<HTMLElement>("#auth-view");
    this.title = requireElement<HTMLElement>("#auth-title");
    this.subtitle = requireElement<HTMLElement>("#auth-subtitle");
    this.form = requireElement<HTMLFormElement>("#auth-form");
    this.usernameInput = requireElement<HTMLInputElement>("#auth-username");
    this.passwordInput = requireElement<HTMLInputElement>("#auth-password");
    this.errorBox = requireElement<HTMLElement>("#auth-error");
    this.submitButton = requireElement<HTMLButtonElement>("#auth-submit");
    this.switchPrompt = requireElement<HTMLElement>("#auth-switch-prompt");
    this.switchButton = requireElement<HTMLButtonElement>("#auth-switch");

    // `novalidate` is set in the markup on purpose: the browser's own balloon
    // says nothing the server would not, and showing it instead of our inline
    // message would make the two disagree. Validation lives on the server.
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.switchButton.addEventListener("click", () => {
      this.setMode(this.mode === "login" ? "register" : "login");
      this.usernameInput.focus();
    });
  }

  /** Shows the card, optionally explaining why the session ended. */
  show(message?: string): void {
    this.root.hidden = false;
    this.passwordInput.value = "";
    if (message === undefined) this.hideError();
    else this.showError(message);
    this.usernameInput.focus();
  }

  hide(): void {
    this.root.hidden = true;
    this.hideError();
  }

  setMode(mode: AuthMode): void {
    this.mode = mode;
    const copy = COPY[mode];
    this.title.textContent = t(copy.title);
    this.subtitle.textContent = t(copy.subtitle);
    this.switchPrompt.textContent = t(copy.switchPrompt);
    this.switchButton.textContent = t(copy.switchAction);
    this.passwordInput.autocomplete = copy.passwordAutocomplete;
    // Read through `setPending` so the label stays consistent if a mode switch
    // lands while a request is in flight.
    this.setPending(this.pending);
    this.hideError();
  }

  /**
   * Re-renders the current mode in the current language.
   *
   * Clears any error on display, deliberately: that text was rendered in the
   * language the user just left, and keeping a stale sentence is worse than
   * making them resubmit. What they *typed* is untouched.
   */
  refresh(): void {
    this.setMode(this.mode);
  }

  private async submit(): Promise<void> {
    if (this.pending) return;

    const username = this.usernameInput.value.trim();
    const password = this.passwordInput.value;
    if (username === "" || password === "") {
      this.showError(t("auth.missingFields"));
      return;
    }

    this.setPending(true);
    try {
      const user =
        this.mode === "login"
          ? await login(username, password)
          : await register(username, password);
      this.options.onAuthenticated(user);
    } catch (error) {
      this.showError(describe(error, this.mode));
      // Keep the username: retyping it after a typo in the password is the
      // single most annoying thing a sign-in form can do.
      this.passwordInput.value = "";
      this.passwordInput.focus();
    } finally {
      this.setPending(false);
    }
  }

  private setPending(pending: boolean): void {
    this.pending = pending;
    this.submitButton.disabled = pending;
    this.usernameInput.disabled = pending;
    this.passwordInput.disabled = pending;
    this.submitButton.textContent = pending ? t("auth.wait") : t(COPY[this.mode].submit);
  }

  private showError(message: string): void {
    this.errorBox.textContent = message;
    this.errorBox.hidden = false;
  }

  private hideError(): void {
    this.errorBox.textContent = "";
    this.errorBox.hidden = true;
  }
}

function describe(error: unknown, mode: AuthMode): string {
  if (!(error instanceof ApiError)) return t("auth.err.unexpected");

  // `detail` is checked before `code` because `BAD_REQUEST` alone covers five
  // different validation failures. The server's English `message` is never
  // shown: it is prose for logs and API callers, and echoing it here would put
  // an untranslated sentence in front of the user.
  const fromDetail = detailKey(error.detail);
  if (fromDetail !== null) return t(fromDetail);

  switch (error.code) {
    case "NETWORK":
      return t("auth.err.network");
    case "USERNAME_TAKEN":
      return t("auth.err.usernameTaken");
    case "TOO_MANY_REQUESTS":
      return t("auth.err.tooManyRequests");
    case "UNAUTHORIZED":
      return t("auth.err.unauthorized");
    case "FORBIDDEN":
      // A 403 with no recognised detail. Every 403 today is ACCOUNT_REMOVED,
      // so this is the "a newer server added a case" path.
      return t("auth.err.fallback");
    case "BAD_REQUEST":
      // A shape this client should not be able to produce — a bug rather than
      // something the user can fix by retyping.
      return t("auth.err.fallback");
    default:
      return mode === "login" ? t("auth.err.loginFailed") : t("auth.err.registerFailed");
  }
}
