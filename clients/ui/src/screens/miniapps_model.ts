// Pure Mini Apps client model: wire shapes, permission presentation and strict frame-bridge parsing.
export type MiniAppScope =
  | "user.basic"
  | "theme"
  | "chat.context"
  | "clipboard.write"
  | "payments.invoice";

export interface MiniAppBotView {
  id: number;
  username: string;
  name: string;
  avatar_file_id: number | null;
}

export interface MiniAppView {
  id: number;
  bot_user_id: number;
  bot: MiniAppBotView;
  title: string;
  description: string;
  launch_url: string;
  launch_origin: string;
  icon_file_id: number | null;
  requested_scopes: MiniAppScope[];
  status: "draft" | "active" | "disabled";
  version: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

export interface MiniAppLaunch {
  app: MiniAppView;
  launch_id: string;
  launch_url: string;
  launch_origin: string;
  init_data: string;
  expires_at: number;
  scopes: MiniAppScope[];
  bridge: { version: 1; methods: string[] };
}

export interface OwnedBotListItem {
  id: number;
  bot_user_id?: number;
  username: string;
  name: string;
}

export interface MiniAppBridgeMessage {
  type: "greenchat:miniapp";
  version: 1;
  id: string;
  method:
    | "ready"
    | "close"
    | "expand"
    | "requestTheme"
    | "writeClipboard"
    | "openLink"
    | "setMainButton"
    | "setBackButton"
    | "setSettingsButton"
    | "openInvoice";
  payload?: unknown;
}

const BRIDGE_METHODS = new Set<MiniAppBridgeMessage["method"]>([
  "ready",
  "close",
  "expand",
  "requestTheme",
  "writeClipboard",
  "openLink",
  "setMainButton",
  "setBackButton",
  "setSettingsButton",
  "openInvoice",
]);

export function parseMiniAppBridgeMessage(raw: unknown): MiniAppBridgeMessage | null {

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.type !== "greenchat:miniapp" || value.version !== 1) return null;
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 64) return null;
  if (typeof value.method !== "string" || !BRIDGE_METHODS.has(value.method as MiniAppBridgeMessage["method"]))
    return null;
  return {
    type: "greenchat:miniapp",
    version: 1,
    id: value.id,
    method: value.method as MiniAppBridgeMessage["method"],
    ...(Object.prototype.hasOwnProperty.call(value, "payload") ? { payload: value.payload } : {}),
  };
}

export interface MiniAppMainButtonState {
  visible: boolean;
  text: string;
  enabled: boolean;
  loading: boolean;
}

export interface MiniAppControlsState {
  main: MiniAppMainButtonState;
  backVisible: boolean;
  settingsVisible: boolean;
}

export const DEFAULT_MINI_APP_CONTROLS: Readonly<MiniAppControlsState> = Object.freeze({
  main: Object.freeze({ visible: false, text: "", enabled: true, loading: false }),
  backVisible: false,
  settingsVisible: false,
});

const CONTROL_TEXT_MAX = 64;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** Strictly reduce one control mutation. null means a malformed/unsupported payload. */
export function applyMiniAppControlMessage(
  current: MiniAppControlsState,
  method: MiniAppBridgeMessage["method"],
  payload: unknown,
): MiniAppControlsState | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (method === "setMainButton") {
    if (!exactKeys(value, ["visible", "text", "enabled", "loading"])) return null;
    if (
      typeof value.visible !== "boolean" ||
      typeof value.text !== "string" ||
      typeof value.enabled !== "boolean" ||
      typeof value.loading !== "boolean"
    ) return null;
    const text = value.text.trim();
    if (Array.from(text).length > CONTROL_TEXT_MAX || CONTROL_CHARS.test(text)) return null;
    if (value.visible && text.length === 0) return null;
    return {
      ...current,
      main: {
        visible: value.visible,
        text,
        enabled: value.enabled,
        loading: value.loading,
      },
    };
  }
  if (method === "setBackButton" || method === "setSettingsButton") {
    if (!exactKeys(value, ["visible"]) || typeof value.visible !== "boolean") return null;
    return method === "setBackButton"
      ? { ...current, backVisible: value.visible }
      : { ...current, settingsVisible: value.visible };
  }
  return null;
}

export function miniAppFramePolicy(
  hostOrigin: string | undefined = typeof location === "undefined" ? undefined : location.origin,
): {
  sandbox: string;
  allow: string;
  referrerPolicy: ReferrerPolicy;
  credentialless: true;
  csp: string;
} {
  let sdkOrigin = "";
  try {
    if (hostOrigin) {
      const parsed = new URL(hostOrigin);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") sdkOrigin = parsed.origin;
    }
  } catch {
    sdkOrigin = "";
  }
  const scriptSources = sdkOrigin ? `'self' ${sdkOrigin}` : "'self'";
  return {
    // External origin + sandbox. No top-navigation, popups, downloads, camera, microphone,
    // geolocation or payment capabilities. External links are opened only by the validated host bridge.
    sandbox: "allow-scripts allow-forms allow-same-origin allow-modals",
    allow: "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'",
    referrerPolicy: "no-referrer",
    // A Mini App authenticates through signed initData, not ambient third-party cookies. Browsers that
    // support credentialless iframes get an ephemeral, credential-free network/storage context.
    credentialless: true,
    // Defense in depth for browsers implementing iframe[csp]: executable code may come only from the
    // app itself and the exact GreenChat origin that serves the official SDK. Nested frames/plugins
    // are forbidden, while HTTPS APIs remain reachable.
    csp: `default-src 'self'; script-src ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data:; media-src 'self' blob: https:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`,
  };
}

export function validateMiniAppOrigin(
  url: string,
  declaredOrigin: string,
  hostOrigin: string | undefined = typeof location === "undefined" ? undefined : location.origin,
): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.origin !== declaredOrigin) return null;
    // allow-scripts + allow-same-origin is required for normal app storage/networking, but it would be
    // unsafe against a frame served from GreenChat's own origin. Same-origin Mini Apps are rejected.
    if (hostOrigin && parsed.origin === hostOrigin) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseMiniAppInvoiceRequest(raw: unknown): { code: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, ["code"])) return null;
  const code = normalizeMiniAppInvoiceCode(value.code);
  return code ? { code } : null;
}

export interface MiniAppMetricTotals {
  launches: number;
  chat_launches: number;
  grants: number;
  verifications: number;
}

export interface MiniAppMetricDay extends MiniAppMetricTotals {
  day_start: number;
}

export interface MiniAppAnalytics {
  app_id: number;
  days: number;
  from: number;
  to: number;
  totals: MiniAppMetricTotals;
  daily: MiniAppMetricDay[];
}

function metricCount(raw: unknown): number | null {
  return Number.isSafeInteger(raw) && Number(raw) >= 0 ? Number(raw) : null;
}

function parseMetricTotals(raw: unknown): MiniAppMetricTotals | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, ["launches", "chat_launches", "grants", "verifications"])) return null;
  const launches = metricCount(value.launches);
  const chatLaunches = metricCount(value.chat_launches);
  const grants = metricCount(value.grants);
  const verifications = metricCount(value.verifications);
  if (launches === null || chatLaunches === null || grants === null || verifications === null) return null;
  return { launches, chat_launches: chatLaunches, grants, verifications };
}

export function parseMiniAppAnalytics(raw: unknown, expectedAppId: number): MiniAppAnalytics | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, ["app_id", "days", "from", "to", "totals", "daily"])) return null;
  const appId = Number(value.app_id);
  const days = Number(value.days);
  const from = Number(value.from);
  const to = Number(value.to);
  if (appId !== expectedAppId || !Number.isSafeInteger(appId) || appId <= 0) return null;
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) return null;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to - from !== days * 86400) return null;
  if (from % 86400 !== 0 || to % 86400 !== 0) return null;
  const totals = parseMetricTotals(value.totals);
  if (!totals || !Array.isArray(value.daily) || value.daily.length !== days) return null;
  const daily: MiniAppMetricDay[] = [];
  for (let index = 0; index < value.daily.length; index += 1) {
    const item = value.daily[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!exactKeys(row, ["day_start", "launches", "chat_launches", "grants", "verifications"])) return null;
    const dayStart = Number(row.day_start);
    const counts = parseMetricTotals({
      launches: row.launches,
      chat_launches: row.chat_launches,
      grants: row.grants,
      verifications: row.verifications,
    });
    if (dayStart !== from + index * 86400 || !counts) return null;
    daily.push({ day_start: dayStart, ...counts });
  }
  const recomputed = daily.reduce(
    (sum, row) => ({
      launches: sum.launches + row.launches,
      chat_launches: sum.chat_launches + row.chat_launches,
      grants: sum.grants + row.grants,
      verifications: sum.verifications + row.verifications,
    }),
    { launches: 0, chat_launches: 0, grants: 0, verifications: 0 },
  );
  if (
    recomputed.launches !== totals.launches ||
    recomputed.chat_launches !== totals.chat_launches ||
    recomputed.grants !== totals.grants ||
    recomputed.verifications !== totals.verifications
  ) return null;
  return { app_id: appId, days, from, to, totals, daily };
}

export interface MiniAppInvoiceView {
  code: string;
  creator_kind: "bot";
  creator_id: number;
  asset: string;
  amount: string;
  description: string;
  status: "open";
  expires_at: number;
}

export function normalizeMiniAppInvoiceCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(code) ? code : null;
}

/** Parse only the fields the system confirmation sheet is allowed to use. */
export function parseMiniAppInvoiceResult(raw: unknown, expectedCode: string): MiniAppInvoiceView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const invoice = (raw as { invoice?: unknown }).invoice;
  if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) return null;
  const value = invoice as Record<string, unknown>;
  const code = normalizeMiniAppInvoiceCode(value.code);
  if (!code || code !== expectedCode) return null;
  if (value.creator_kind !== "bot") return null;
  const creatorId = Number(value.creator_id);
  if (!Number.isSafeInteger(creatorId) || creatorId <= 0) return null;
  if (typeof value.asset !== "string" || !/^[A-Za-z][A-Za-z0-9_]{1,15}$/.test(value.asset)) return null;
  if (typeof value.amount !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value.amount)) return null;
  if (/^0(?:\.0+)?$/.test(value.amount)) return null;
  if (typeof value.description !== "string" || Array.from(value.description).length > 200) return null;
  if (value.status !== "open") return null;
  const expiresAt = Number(value.expires_at);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return {
    code,
    creator_kind: "bot",
    creator_id: creatorId,
    asset: value.asset,
    amount: value.amount,
    description: value.description,
    status: "open",
    expires_at: expiresAt,
  };
}

export function safeMiniAppExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeMiniAppScopes(scopes: readonly string[]): MiniAppScope[] {
  const order: MiniAppScope[] = [
    "user.basic",
    "theme",
    "chat.context",
    "clipboard.write",
    "payments.invoice",
  ];
  const set = new Set(scopes);
  return order.filter((scope) => set.has(scope));
}

export function miniAppNeedsConsentData(error: unknown): { app: MiniAppView; scopes: MiniAppScope[] } | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || (data as { consent_required?: unknown }).consent_required !== true)
    return null;
  const app = (data as { app?: unknown }).app;
  const scopes = (data as { scopes?: unknown }).scopes;
  if (!app || typeof app !== "object" || !Array.isArray(scopes)) return null;
  return {
    app: app as MiniAppView,
    scopes: normalizeMiniAppScopes(scopes.filter((item): item is string => typeof item === "string")),
  };
}

export function miniAppThemeSnapshot(root: HTMLElement = document.documentElement): Record<string, string> {
  const style = getComputedStyle(root);
  return {
    colorScheme: root.dataset.theme === "dark" ? "dark" : "light",
    backgroundColor: style.getPropertyValue("--gc-bg").trim(),
    surfaceColor: style.getPropertyValue("--gc-panel-solid").trim(),
    textColor: style.getPropertyValue("--gc-fg").trim(),
    secondaryTextColor: style.getPropertyValue("--gc-fg-secondary").trim(),
    accentColor: style.getPropertyValue("--gc-accent").trim(),
    dangerColor: style.getPropertyValue("--gc-danger").trim(),
  };
}
