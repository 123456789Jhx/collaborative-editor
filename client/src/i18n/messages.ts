/**
 * Every string the UI shows, in both languages.
 *
 * `en` is the source of truth for the *shape*: `MessageKey` is derived from it
 * and `zh` is typed as a complete `Record<MessageKey, string>`, so forgetting a
 * translation is a compile error rather than a stray English word on a Chinese
 * page. There is a test that asserts the same thing at runtime.
 *
 * ⚠️ The validation messages repeat the limits enforced by
 * `server/src/auth/credentials.ts` and `server/src/auth/password.ts`
 * (username 3–32, password 4–200). The server sends a stable `detail` code, not
 * a number, so these copies cannot be derived from it — **changing a limit
 * there means changing the text here too.**
 */

export const LOCALES = ["zh", "en"] as const;

export type Locale = (typeof LOCALES)[number];

const en = {
  "app.title": "Collaborative Editor",
  "app.hint": "Open this page in a second tab or window to see edits sync live.",
  "app.signOut": "Sign out",
  "app.document": "Document",
  "app.language": "Language",

  "boot.loading": "Loading…",
  "boot.unreachable": "Could not reach the server. Reload the page to try again.",

  "status.connecting": "connecting…",
  "status.open": "connected",
  "status.closed": "disconnected — retrying",
  "status.client": "client",

  "user.signedOut": "signed out",
  "user.roleAdmin": "Administrator",
  "user.roleMember": "Member",

  "auth.username": "Username",
  "auth.password": "Password",
  "auth.wait": "Please wait…",
  "auth.missingFields": "Enter both a username and a password.",
  "auth.sessionEnded": "Your session has ended. Please sign in again.",

  "auth.title.login": "Sign in",
  "auth.subtitle.login": "You need an account to open the document.",
  "auth.submit.login": "Sign in",
  "auth.switchPrompt.login": "No account yet?",
  "auth.switchAction.login": "Create one",

  "auth.title.register": "Create an account",
  "auth.subtitle.register": "Pick a username and a password of at least 4 characters.",
  "auth.submit.register": "Create account",
  "auth.switchPrompt.register": "Already have an account?",
  "auth.switchAction.register": "Sign in",

  "auth.err.network": "Could not reach the server. Check your connection and try again.",
  "auth.err.usernameTaken": "That username is taken. Try another one.",
  "auth.err.tooManyRequests": "Too many attempts. Wait a few minutes and try again.",
  "auth.err.unauthorized": "Incorrect username or password.",
  "auth.err.loginFailed": "Could not sign in. Please try again.",
  "auth.err.registerFailed": "Could not create the account. Please try again.",
  "auth.err.unexpected": "Something went wrong. Please try again.",
  "auth.err.fallback": "The request was rejected. Please try again.",

  "auth.err.USERNAME_TOO_SHORT": "Username must be at least 3 characters.",
  "auth.err.USERNAME_TOO_LONG": "Username must be at most 32 characters.",
  "auth.err.USERNAME_INVALID":
    "Username may only contain letters, digits, dot, dash and underscore.",
  "auth.err.PASSWORD_TOO_SHORT": "Password must be at least 4 characters.",
  "auth.err.PASSWORD_TOO_LONG": "Password must be at most 200 characters.",
  "auth.err.MALFORMED_REQUEST": "The request was malformed. Reload the page and try again.",
  "auth.err.CREDENTIALS_REQUIRED": "Enter both a username and a password.",
  "auth.err.ACCOUNT_REMOVED": "This account has been removed and can no longer sign in.",
} as const;

/** The keys the UI may ask for. Derived from `en` so the two cannot drift. */
export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "app.title": "协同编辑器",
  "app.hint": "在第二个标签页或窗口打开本页，就能看到编辑实时同步。",
  "app.signOut": "退出登录",
  "app.document": "文档",
  "app.language": "语言",

  "boot.loading": "加载中…",
  "boot.unreachable": "连不上服务器，请刷新页面重试。",

  "status.connecting": "连接中…",
  "status.open": "已连接",
  "status.closed": "已断开，正在重连",
  "status.client": "客户端",

  "user.signedOut": "未登录",
  "user.roleAdmin": "管理员",
  "user.roleMember": "成员",

  "auth.username": "用户名",
  "auth.password": "密码",
  "auth.wait": "请稍候…",
  "auth.missingFields": "用户名和密码都要填写。",
  "auth.sessionEnded": "登录已失效，请重新登录。",

  "auth.title.login": "登录",
  "auth.subtitle.login": "需要账号才能打开文档。",
  "auth.submit.login": "登录",
  "auth.switchPrompt.login": "还没有账号？",
  "auth.switchAction.login": "去注册",

  "auth.title.register": "创建账号",
  "auth.subtitle.register": "选一个用户名，密码至少 4 个字符。",
  "auth.submit.register": "创建账号",
  "auth.switchPrompt.register": "已经有账号了？",
  "auth.switchAction.register": "去登录",

  "auth.err.network": "连不上服务器，请检查网络后重试。",
  "auth.err.usernameTaken": "该用户名已被占用，换一个试试。",
  "auth.err.tooManyRequests": "尝试次数过多，请过几分钟再试。",
  "auth.err.unauthorized": "用户名或密码不正确。",
  "auth.err.loginFailed": "登录失败，请重试。",
  "auth.err.registerFailed": "创建账号失败，请重试。",
  "auth.err.unexpected": "出了点问题，请重试。",
  "auth.err.fallback": "请求被拒绝，请重试。",

  "auth.err.USERNAME_TOO_SHORT": "用户名至少 3 个字符。",
  "auth.err.USERNAME_TOO_LONG": "用户名最多 32 个字符。",
  "auth.err.USERNAME_INVALID": "用户名只能用字母、数字、点、短横线和下划线。",
  "auth.err.PASSWORD_TOO_SHORT": "密码至少 4 个字符。",
  "auth.err.PASSWORD_TOO_LONG": "密码最多 200 个字符。",
  "auth.err.MALFORMED_REQUEST": "请求格式不正确，请刷新页面重试。",
  "auth.err.CREDENTIALS_REQUIRED": "用户名和密码都要填写。",
  "auth.err.ACCOUNT_REMOVED": "该账号已被删除，无法登录。",
};

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { zh, en };

/**
 * The server's `detail` codes, mapped to the keys that translate them.
 *
 * Two codes share one message where the user cannot act on the difference:
 * `BODY_NOT_OBJECT` and `BODY_INVALID` are both "the client sent something
 * broken", which is a bug rather than something to phrase differently.
 */
const DETAIL_KEYS: Record<string, MessageKey> = {
  USERNAME_TOO_SHORT: "auth.err.USERNAME_TOO_SHORT",
  USERNAME_TOO_LONG: "auth.err.USERNAME_TOO_LONG",
  USERNAME_INVALID: "auth.err.USERNAME_INVALID",
  PASSWORD_TOO_SHORT: "auth.err.PASSWORD_TOO_SHORT",
  PASSWORD_TOO_LONG: "auth.err.PASSWORD_TOO_LONG",
  BODY_NOT_OBJECT: "auth.err.MALFORMED_REQUEST",
  BODY_INVALID: "auth.err.MALFORMED_REQUEST",
  CREDENTIALS_REQUIRED: "auth.err.CREDENTIALS_REQUIRED",
  ACCOUNT_REMOVED: "auth.err.ACCOUNT_REMOVED",
};

/**
 * A key for a server-supplied detail, or null when it is absent or unknown.
 * Null means "fall back to something generic" — an unrecognised code must not
 * reach the user as a raw token like `SOMETHING_NEW`.
 */
export function detailKey(detail: string | undefined): MessageKey | null {
  if (detail === undefined) return null;
  return DETAIL_KEYS[detail] ?? null;
}
