import type { Op, Snapshot } from "@collab/shared";
import type { ApiUser } from "../api/client.js";
import { requireElement } from "../dom.js";
import { Editor } from "../editor/editor.js";
import { onLocaleChange, t } from "../i18n/i18n.js";
import type { MessageKey } from "../i18n/messages.js";
import { Connection, type ConnectionStatus } from "../transport/connection.js";

const CLIENT_COLORS = ["#2563eb", "#16a34a", "#db2777", "#ea580c", "#7c3aed", "#0891b2"];

const STATUS_KEYS: Record<ConnectionStatus, MessageKey> = {
  connecting: "status.connecting",
  open: "status.open",
  closed: "status.closed",
};

export interface EditorSession {
  /** Terminal: stops reconnecting, for signing out. */
  disconnect(): void;
}

/** Why the session ended, which decides whether the cookie still needs revoking. */
export type SignedOutReason = "requested" | "unauthorized";

export interface StartEditorOptions {
  user: ApiUser;
  /**
   * The session ended. `message` is set when it was not the user's own doing —
   * a revoked session, say — so the sign-in page can explain itself.
   */
  onSignedOut(reason: SignedOutReason, message?: string): void;
}

function hash(value: string): number {
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    result = (result * 31 + value.charCodeAt(i)) >>> 0;
  }
  return result;
}

/**
 * Wires the document editor to a live connection.
 *
 * Everything here is built fresh on each sign-in rather than reset in place: a
 * `Connection` carries a version counter and a sequence number that belong to
 * one session, and reusing it after a sign-out would have the next session
 * assert versions from the previous one.
 */
export function startEditor(options: StartEditorOptions): EditorSession {
  const editorRoot = requireElement<HTMLElement>("#editor");
  const statusBadge = requireElement<HTMLElement>("#status");
  const clientBadge = requireElement<HTMLElement>("#client");
  const userBadge = requireElement<HTMLElement>("#user");
  const signOutButton = requireElement<HTMLButtonElement>("#sign-out");
  const appView = requireElement<HTMLElement>("#app-view");

  // The document is shared, so an admin sees exactly what everyone else does.
  // The role only changes what the *badge* claims and whether signing out is
  // the only privileged action available.
  userBadge.dataset["role"] = options.user.role;

  // The three badges are rendered rather than written once, so a language
  // change can redraw them from the last known state.
  let ownClientId: string | null = null;
  let lastStatus: ConnectionStatus = "connecting";
  let stopped = false;

  function renderUserBadge(): void {
    userBadge.textContent = options.user.username;
    userBadge.title = t(options.user.role === "admin" ? "user.roleAdmin" : "user.roleMember");
  }

  function renderStatus(): void {
    statusBadge.textContent = t(STATUS_KEYS[lastStatus]);
    statusBadge.dataset["status"] = lastStatus;
  }

  function renderClient(): void {
    clientBadge.textContent =
      ownClientId === null
        ? t("status.connecting")
        : `${t("status.client")} ${ownClientId.slice(0, 4)}`;
  }

  function renderLabels(): void {
    renderUserBadge();
    renderStatus();
    renderClient();
    editorRoot.setAttribute("aria-label", t("app.document"));
  }

  renderLabels();
  const unsubscribeLocale = onLocaleChange(renderLabels);

  appView.hidden = false;

  function teardown(): void {
    if (stopped) return;
    stopped = true;
    // Without this the next sign-in would subscribe a second time and leave the
    // first listener holding DOM nodes from the session that just ended.
    unsubscribeLocale();
    connection.disconnect();
    appView.hidden = true;
  }

  const editor = new Editor(editorRoot, [], {
    onOps: (ops: Op[]) => connection.sendTx(ops),
  });
  editor.setReadOnly(options.user.status !== "active");

  const connection = new Connection({
    onWelcome(clientId, snapshot) {
      ownClientId = clientId;
      renderClient();
      const color = CLIENT_COLORS[hash(clientId) % CLIENT_COLORS.length];
      if (color !== undefined) {
        clientBadge.style.setProperty("--client-color", color);
        editorRoot.style.setProperty("--caret-color", color);
      }
      adopt(snapshot);
    },

    onTx(tx, _version) {
      // Our own tx is broadcast back to us. It was already applied locally when
      // the user typed, so re-applying it would duplicate the edit.
      if (tx.clientId === ownClientId) return;
      editor.applyRemoteOps(tx.ops);
    },

    onResync(snapshot) {
      adopt(snapshot);
    },

    onStatus(status) {
      lastStatus = status;
      renderStatus();
    },

    onUnauthorized() {
      // The server closed the handshake with 4401: the cookie is gone, expired,
      // or the account was disabled while this tab was open.
      teardown();
      options.onSignedOut("unauthorized", t("auth.sessionEnded"));
    },
  });

  function adopt(snapshot: Snapshot): void {
    editor.setBlocks(snapshot.blocks);
  }

  const onSignOut = (): void => {
    teardown();
    options.onSignedOut("requested");
  };
  signOutButton.addEventListener("click", onSignOut);

  connection.connect();

  return {
    disconnect(): void {
      signOutButton.removeEventListener("click", onSignOut);
      teardown();
    },
  };
}
