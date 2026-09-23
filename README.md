# Collaborative DOM Editor

A block-based rich-text editor that syncs live between browser tabs. Built for a take-home assignment; this README covers how to run it, the data model, the collaboration approach, and what is deliberately unfinished.

**Phase 1 scope:** DOM editing (type / modify / delete, Enter to split, Backspace at the start of a block to merge) plus live sync between two tabs. **Phase 2** adds accounts: registration, sign-in, persisted users, and per-account read-only enforcement. The interface is **Chinese by default** and can be switched to English. ACK, reconnect semantics, conflict resolution, cursors, locks, and undo are still out of scope — see [Not done](#not-done).

## How to run

### Local development

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>, create an account, and open a second tab (or a second browser) signed in as someone else.

### Docker

```bash
cp .env.example .env      # then edit it — see Accounts and access
docker compose up --build
```

Then open <http://localhost>. The stack is nginx on `:80` proxying `/api` and `/ws` to the server on `:3000`, with the database on the `collab-data` volume.

| Script | What it does |
| --- | --- |
| `npm run dev` | Builds `shared` in watch mode, starts the server on `:3000` and Vite on `:5173` |
| `npm test` | Vitest, 251 tests |
| `npm run typecheck` | All three packages plus the test project |
| `npm run build` | Production build of all three packages |
| `npm start` | Runs the built server and a preview of the built client |

## Tech

Vanilla TypeScript, Vite, Node with `ws`, Vitest. No editor framework: the interesting part of this assignment is the collaboration layer, not rich-text rendering, and pulling in ProseMirror would have hidden it. npm workspaces split the code three ways — `shared/` (protocol and block operations), `server/` (document state and WebSocket), `client/` (DOM editor and transport).

## Data structure

A document is `Block[]`, where a block is `{ id, text }`.

The choice that matters is that an operation names a **block by id**, not a position in a single string. With one big string, editing block 3 shifts every offset after it and every concurrent edit becomes a reindexing problem. With blocks, ids are stable, split and merge are one `splice`, and a peer can say "insert at offset 5 of block-7" without knowing anything about the rest of the document.

- **Ops carry intent, not results:** `insert`, `delete`, `split`, `merge`. Results are only sent as whole snapshots, at join and resync.
- **Offsets are UTF-16 code units** everywhere — protocol validation, caret maths, and caret restoration all agree on that unit. `client/src/editor/text-diff.ts` widens its diff window when a boundary lands mid-surrogate-pair so an emoji is never split in half on the wire.
- **A linear scan is fine for now.** `LIMITS.maxBlocks` is 500, so `indexOfBlock` is cheap; a `Map<BlockId, index>` would need invalidation on every split and merge, which is not worth it below a few thousand blocks.
- Rejected: a rope or a tree. Both pay off for very large single documents, which is not what this is.

## Collaboration approach

The server is the only validator and the only source of order.

1. A client applies its edit locally first, so typing never waits on the network, then sends the ops as a transaction.
2. The server validates every op against a **folded working copy** and only applies the transaction if all of them pass. That is what makes a transaction all-or-nothing, and it is why a `split` followed by an `insert` into the block it just created is legal inside a single transaction.
3. On success the server bumps the version by exactly one and broadcasts the stamped transaction to **every** client, including the sender. Echoing to the sender means one code path instead of two, and the echo is where an ACK will slot in later; the client filters out its own edit (`client/src/main.ts`) because it already applied it.
4. On rejection the server replies with `error` and then a `resync` snapshot. The pairing is a contract: `error` alone leaves a client stuck, `resync` alone hides the reason. Snapshots are the only way state is corrected, so a rejected edit visibly reverts instead of silently diverging.
5. A client that receives a version other than `current + 1` asks for a resync rather than guessing. This is only sound because of the "exactly one version per accepted transaction" rule above.

`shared/` is aliased to **source** by Vite and Vitest, but resolved to **`shared/dist`** by the server through the workspace symlink. The trade-off: client HMR never needs a watch build, and the cost is that `build:shared` must run before the server — which the npm scripts encode.

## Accounts and access

The document is still one global shared document, but reaching it requires an account. Nobody sees the editor until they are signed in.

### The first administrator

The server creates it from `ROOT_USERNAME` and `ROOT_PASSWORD` on the first start against an empty database, and never again. **If neither is set the server refuses to start** rather than falling back to a default. On a machine reachable from the internet a default admin password is the same thing as no admin password, so there is no default. In Docker both come from `.env`; in development, export them.

Changing them afterwards has no effect — the account lives in the database.

### Sessions

A signed-in browser holds an opaque 256-bit random token in an `httpOnly`, `SameSite=Lax` cookie. Nothing about the user is encoded in it, so revocation is a `DELETE` rather than a denylist, and no script on the page can read it. `SameSite=Lax` is what stands in for a CSRF token here.

Passwords are hashed with `scrypt` (N=2¹⁵, r=8, unique 16-byte salt, compared with `timingSafeEqual`) and the login route spends the same hashing time on an unknown username as on a wrong password, so the response cannot be used to enumerate accounts. Login attempts are rate-limited per address and per account.

### Authorization lives outside the collaboration core

`createCollabServer` takes an optional `AuthPolicy`. When it is omitted the server behaves exactly as it did before auth existed, which is what lets the protocol tests exercise the collaboration core without a database. `server.ts` always supplies the real one, and a test wires it the same way to prove the two cannot come apart.

The policy is checked in two places:

- **Once per WebSocket handshake.** The cookie rides along on the handshake because `/ws` is same-origin with the page, so `join` / `tx` / `resync` needed no changes at all. A rejected handshake is closed with **4401**, and the client stops rather than retrying a cookie that will never be accepted.
- **Before every transaction**, re-resolving the session. That single indexed lookup is what makes an admin's `readonly` or `deleted` flip take effect on the user's next keystroke instead of their next reconnect.

`DocumentState.applyTx` never learns who authored a transaction — it takes no `clientId` and knows nothing about users. Keeping that out is what keeps it a pure linearizer. A rejection reuses the existing `error` + `resync` pairing, so the client's rollback path is unchanged.

### What is enforced where

| | Server | Client |
| --- | --- | --- |
| Signed out | Handshake closed with 4401; `/api/me` is 401 | Sign-in page only; the editor is not rendered |
| `readonly` | Every transaction rejected with `READ_ONLY`, version does not advance | `contenteditable="false"`, so nothing is typed in the first place |
| `deleted` | Every transaction rejected with `ACCOUNT_DISABLED` | — |

The client-side read-only is a convenience, not a boundary: the server rejects the transaction either way.

### Not yet wired

Registration is **open** — anyone who can reach the site can create an account. The admin role currently only changes the badge in the top bar. The audit log and the user-management screens are designed (`audit_log` already exists in the schema) but not implemented; until they are, `status` has to be changed directly in the database.

## Languages

The interface is Chinese by default and English on request, from a `<select>` on the sign-in card and another in the top bar (a signed-out visitor needs one too). The choice is kept in `localStorage` and applied without a reload; every component that renders text redraws on a change rather than being re-created, so the document, the caret and the socket are untouched.

Two details are load-bearing:

- **`en` defines the key set.** `MessageKey` is derived from the English dictionary and `zh` is typed as a complete `Record<MessageKey, string>`, so a forgotten translation is a compile error. A test asserts the same thing at runtime.
- **The server sends a `detail`, not a sentence.** `BAD_REQUEST` covers five different validation failures, and the UI cannot translate them from `error.message` without matching on English prose — which would break silently the first time a message was reworded. So `credentials.ts` returns a `ValidationCode`, `respond.ts` passes it through as `detail`, and the client switches on that. The server's English `message` is still there for logs and for calling the API by hand; the UI never shows it.

The dictionary repeats the limits the server enforces (username 3–32, password 4–200) because a `detail` code carries no numbers. Those copies are commented in both places, but they are copies.

## Tests

```bash
npm test
```

| File | Pins |
| --- | --- |
| `shared/src/document.test.ts` | The op algebra: validation against the folded state, atomicity, boundaries, and that nothing mutates its input |
| `shared/src/protocol.test.ts` | The trust boundary: what the parser checks (shape) versus what it defers (`validateOps`) |
| `server/src/document-state.test.ts` | Version increments of exactly one, deep-copied snapshots, and the documented Phase 1 limits |
| `server/src/create-server.test.ts` | Real WebSocket server and clients: join, broadcast, rejection, and that replaying the stream converges |
| `client/src/editor/text-diff.test.ts` | Diff offsets, including the surrogate-pair guard, which only an exact-offset assertion can catch |
| `client/src/transport/connection.test.ts` | The reconnect and resync state machine against a fake socket |
| `server/src/auth/password.test.ts` | Hash/verify round-trips, per-hash salts, and that a corrupt row reads as "wrong password" rather than throwing |
| `server/src/db/*.test.ts` | `COLLATE NOCASE` uniqueness, soft delete keeping the row, session expiry boundaries, revocation, cascade |
| `server/src/auth/auth-policy.test.ts` | `active` edits, `readonly` and `deleted` do not, and a flip takes effect without a new handshake |
| `server/src/http/router.test.ts` | Path and method matching, 404 vs 405, and that a throwing handler cannot leak its stack |
| `server/src/http/routes/auth-routes.test.ts` | The whole HTTP surface over real requests: status codes, cookie flags, the timing-equalized login, and the throttle |
| `client/src/api/client.test.ts` | Status-to-`ApiError` mapping, 401-as-null, network failure, and a non-JSON error body |
| `client/src/i18n/i18n.test.ts` | That both dictionaries have exactly the same keys, that `zh` is the default and switching works, and that an unrecognised server `detail` falls back instead of reaching the user as a raw token |

`editor.ts`, `main.ts` and `auth-view.ts` have no automated tests **on purpose**: jsdom cannot faithfully model `Selection`, `Range` and `contenteditable`, so a DOM test would give false confidence about the hardest part. The honest alternatives (Playwright, Vitest browser mode) would add a dependency. Everything around them is pure and is tested: `text-diff.ts` is the caret-adjacent maths, `connection.ts` is the socket state machine against a fake socket, and `api/client.ts` is the HTTP mapping against a stubbed `fetch`.

**Manual verification** (`npm run dev`, two tabs):

1. Open the site signed out → only the sign-in card, no editor. `/` and `/api/me` through the proxy, not just directly against the server.
2. Register, then register the same name in a different case → rejected.
3. Sign in as two accounts in two tabs → both see the same document and edits sync.
4. Press Enter mid-text → the caret lands at the start of the new block in **both** tabs.
5. Press Backspace at offset 0 → the caret lands at the join point in both tabs.
6. Type an emoji in one tab, then type in the same block in the other → no `U+FFFD` appears.
7. Paste multi-line text → newlines become spaces, and it stays a single block.
8. Type in one tab while the other splits or merges the same document → focus and caret are preserved.
9. Set an account to `readonly` in the database, type in that tab → the edit reverts, the version does not move, and the document is still readable.
10. Restart the server container → the accounts still sign in (the volume), and the document is empty (it is not persisted).
11. Open the site with a cleared `localStorage` → the interface is Chinese, and `<html lang>` is `zh`.
12. Switch to English → the whole interface changes with no reload, including the top-bar badges while signed in; reload → it is still English.
13. Register with a two-character username → the error is Chinese, and the server's English sentence never appears.

## Problems hit

- **`replaceChildren` destroyed focus and caret.** A remote split or merge changes the number of blocks, which triggered a full DOM rebuild and blew away the caret of whoever was typing. Fixed by capturing the focused block and caret offset before rebuilding and restoring them through the existing focus-hint path — with a guard so an intentional caret move from a local Enter still wins.
- **`contenteditable` produces nested markup.** All reads go through `element.textContent` because the caret maths depends on a single flat text node, which is also why paste uses `document.execCommand("insertText")` instead of inserting nodes directly.
- **IME input needed three guards** (`isComposing` on `input`, `keyCode === 229` on `keydown`, plus a `composing` set) or Enter would split a block mid-composition. There is a known remaining hole: a remote op into a block being composed is skipped by the DOM update, and `compositionend` can then diff the local text against the already-updated block and revert the remote insert.
- **`sendTx` drops ops silently when the socket is not open**, while still consuming a sequence number. Typing during the one-second reconnect window is lost with no error and leaves a gap in the sequence. Pinned by a test; the fix belongs with ACK.
- **An oversized paste** fails validation as `TEXT_TOO_LONG`, reverts via resync, and the only feedback is a `console.warn` while the status badge still reads "connected".
- **`scrypt` at N=2¹⁵ throws with the default `maxmem`.** It needs `128 * N * r` = 33.5 MB against Node's 32 MB default, so every call failed with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`. Now explicit at 64 MB, measured at ~58 ms per hash.
- **nginx answered `/api/*` with `index.html` and a 200.** There was only a `location /`, so `fetch` saw a success and then failed to parse the body — a failed login would have looked like a server bug. Fixed with a `location /api/` block, no trailing slash, exactly like `/ws`.
- **`X-Forwarded-Proto` cannot be `$scheme` here.** Cloudflare terminates TLS at its edge and speaks plain http to the tunnel, so nginx sees http for every request even on the https site, and the session cookie would never be marked `Secure`. The config now passes an upstream's value through when there is one and falls back to `$scheme` only for a direct request.
- **The reconnect was armed before the flag it reads.** Guarding only the scheduling left an already-armed one-second timer that would fire after `disconnect()` and reconnect anyway; the check now happens when the timer fires.
- **`data-i18n` on a badge that later shows a username.** Marking the top bar's static text for translation is uniform and tempting, but three of those badges are rewritten from live state. A language change would have redrawn them from the dictionary and replaced the signed-in user's name with "signed out". Those three are rendered by the component that owns them instead, and the markup carries a comment saying why.

## Not done

- **No ACK.** A client cannot tell whether its transaction was applied, only whether it was rejected.
- **No reconnect or session semantics.** `clientId` is per socket, so identity does not survive a reconnect — which is also why cursors need a client-supplied session token first. Reconnection retries every second with no backoff, and re-joining adopts a fresh snapshot, silently discarding unsynced local edits.
- **Not idempotent.** `seq` and `baseVersion` are on the wire and validated for shape, but the server ignores both. A replayed transaction applies twice — pinned by a test by design, not by accident. The fix is a per-`clientId` high-water mark for `seq` that treats anything at or below it as a duplicate and **re-sends the ACK rather than erroring**, because the client needs the version to avoid triggering a resync; plus a `baseVersion` staleness check. Note that a `clientId`-keyed table only works once `clientId` is stable across reconnects.
- **No conflict resolution.** Concurrent edits to the same block diverge (the server only rejects *invalid* ops, not *stale* ones), and a remote insert before your caret shifts it by one. Deliberately deferred rather than half-implemented: a partial OT is worse than visible drift.
- **No cursors, locks, or undo.**
- **The document is still in memory.** Accounts, sessions and the audit table are on disk in SQLite, but the document itself is not — restarting the server empties it. Persisting it is a different problem from persisting an account, and doing it properly means storing the op log, not just a snapshot.
- **No rooms.** Signed in or not, every connection shares one global document.
- **No audit log and no user management.** The `audit_log` table is created and indexed but nothing writes to it, and `readonly` / `deleted` are only reachable through the database. These are the next two pieces, and the wiring points already exist: every accepted transaction passes through one place in `create-server.ts`, which is where a write would go.
- **Registration is open.** There is no invite code, so anyone who finds the site can create an account.
- **No password reset and no email verification.** A forgotten password means editing the database.
- **The deleted-user path is incomplete.** Their transactions are rejected on the next keystroke, but their socket stays open and can still read the document until it disconnects on its own.
- **Rate limiting is in-memory and per-process.** Fine while `compose.yaml` pins one replica; it would have to move into the database if that ever changed.
- **Two languages, and no browser-language detection.** The default is hard-coded to Chinese rather than following `Accept-Language`, and the few places that repeat a server-enforced limit in prose have to be updated by hand when that limit changes.

## Future optimizations

1. **Idempotency**, as described above — it is the question the brief asks.
2. **Reconnect with a session token** and resend of unacknowledged transactions.
3. **Conflict resolution.** Because the server is already a single linearizing sequencer, server-side OT is a smaller step from here than a CRDT would be; per-block last-writer-wins with version vectors is the cheaper option if full convergence is not needed.
4. **Extract the editor's local block maths** (`splitBlock`, `mergeWithPrevious`) into a pure `applyLocalEdit(blocks, edit) → { blocks, ops }` so the highest-risk logic is testable without a DOM. This is the single highest-leverage testability change.
5. **A `Map<BlockId, index>`** if `maxBlocks` ever grows past a few thousand.
6. **The audit log and the admin screens**, which are the other half of why accounts were added: the point of knowing who someone is, is being able to see what they did. The write belongs immediately after `applyTx` succeeds and before the broadcast, so that one funnel records every edit in the order the server linearized them. Per-transaction fidelity in storage, merged into time ranges for display — an audit log should not be lossy, but a list of single keystrokes is unreadable.
7. **Document persistence.** The op log is the honest unit, not the snapshot: it is already the thing the server stamps and orders, and it is what would let the document outlive a restart without losing the ability to replay or audit it.
