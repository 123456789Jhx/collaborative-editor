import { fetchCurrentUser, logout, type ApiUser } from "./api/client.js";
import { startEditor, type EditorSession } from "./app/start-editor.js";
import { AuthView } from "./auth/auth-view.js";
import { requireElement } from "./dom.js";
import { applyLocaleGlobally, getLocale, onLocaleChange, setLocale, t } from "./i18n/i18n.js";

const bootNotice = requireElement<HTMLElement>("#boot");
const appView = requireElement<HTMLElement>("#app-view");

const authView = new AuthView({
  onAuthenticated(user) {
    authView.hide();
    openSession(user);
  },
});

let session: EditorSession | null = null;

/**
 * Wires every `[data-lang-select]` on the page.
 *
 * There are two — one on the sign-in card and one in the top bar — because a
 * signed-out visitor has to be able to switch as well. They are kept in step on
 * every change: switching one must not leave the other showing the old value.
 */
function mountLanguageSelects(): void {
  const selects = document.querySelectorAll<HTMLSelectElement>("[data-lang-select]");

  for (const select of selects) {
    select.addEventListener("change", () => {
      // Checked rather than cast: `<option value>` is a string as far as the
      // type system is concerned, and an unrecognised value must not become
      // the locale.
      if (select.value === "zh" || select.value === "en") setLocale(select.value);
    });
  }

  onLocaleChange(() => {
    for (const select of selects) select.value = getLocale();
    applyLocaleGlobally();
    document.title = t("app.title");
    authView.refresh();
  });

  for (const select of selects) select.value = getLocale();
  applyLocaleGlobally();
  document.title = t("app.title");
}

function openSession(user: ApiUser): void {
  session = startEditor({
    user,
    onSignedOut(reason, message) {
      session = null;
      if (reason === "requested") {
        // Tell the server too, not just the browser: clearing the cookie here
        // would leave the token valid for anyone who had copied it.
        void logout().catch(() => undefined);
        authView.setMode("login");
        authView.show();
        return;
      }
      authView.setMode("login");
      authView.show(message);
    },
  });
}

function showSignIn(message?: string): void {
  appView.hidden = true;
  authView.setMode("login");
  authView.show(message);
}

async function boot(): Promise<void> {
  mountLanguageSelects();

  try {
    const user = await fetchCurrentUser();
    bootNotice.hidden = true;
    if (user === null) showSignIn();
    else openSession(user);
  } catch {
    // A 500, a proxy returning HTML, or no network at all. Showing the sign-in
    // card beats a blank page, and the next submit will surface the real error.
    bootNotice.hidden = true;
    showSignIn(t("boot.unreachable"));
  }
}

void boot();
