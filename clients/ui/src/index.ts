// clients/ui — screens and components (vanilla TS + a mini-store), design tokens, i18n, a11y.
// Shared by every shell (web/desktop/mobile). T-404 lands the UI foundation; real screens follow in
// T-405+. This barrel re-exports the foundation primitives.
export const CLIENT_UI_VERSION = "0.1.0" as const;

// Mini-store (reactive state).
export { createStore } from "./store.ts";
export type {
  Store,
  Selector,
  SliceListener,
  Listener,
  Equality,
  Updater,
  SelectOptions,
} from "./store.ts";

// Virtual scroller.
export { computeWindow, VirtualList } from "./virtual_list.ts";
export type {
  WindowInput,
  WindowRange,
  VirtualListOptions,
} from "./virtual_list.ts";

// i18n.
export { createI18n } from "./i18n.ts";
export type { I18n, I18nOptions, Locale, Dict, Params } from "./i18n.ts";
// Locale dictionaries are loaded directly by each shell, not through this startup barrel.

// Theme & density tokens.
export {
  ThemeController,
  browserThemeEnv,
  resolveTheme,
  clampFontScale,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
} from "./theme.ts";
export type {
  ThemePref,
  EffectiveTheme,
  Density,
  ThemeState,
  ThemeEnv,
  RootElementLike,
} from "./theme.ts";

// Interface language (V155): the user's own choice, persisted, with "system" resolved against the whole
// platform language list instead of a single navigator.language guess taken once at boot.
export {
  LanguageController,
  browserLangEnv,
  resolveLocale,
  normalizeLangPref,
  primarySubtag,
  LANG_PREFS,
  SUPPORTED_LOCALES,
  FALLBACK_LOCALE,
} from "./lang.ts";
export type { LangPref, LangState, LangEnv, LangRootLike } from "./lang.ts";

// System text zoom (the platform's own font-size multiplier, measured — see text_zoom.ts).
export {
  watchSystemTextZoom,
  browserTextZoomEnv,
  textZoomFrom,
  isLargeTextZoom,
  TEXT_ZOOM_PROBE_PX,
  TEXT_ZOOM_MIN,
  TEXT_ZOOM_MAX,
  TEXT_ZOOM_LARGE,
  TEXT_ZOOM_MEDIUM,
  textZoomLevel,
} from "./text_zoom.ts";
export type { TextZoomEnv } from "./text_zoom.ts";

// Hash router.
export {
  HashRouter,
  browserHashEnv,
  parsePath,
  matchRoutes,
  deepLinkToHash,
  WEB_ROUTES,
} from "./router.ts";
export type { Route, RouteDef, HashEnv } from "./router.ts";

// Keyboard shortcuts.
export { Shortcuts, parseCombo, matchChord, detectIsMac } from "./shortcuts.ts";
export type {
  Binding,
  KeyChord,
  KeyEventLike,
  ShortcutsOptions,
} from "./shortcuts.ts";

// Command palette (Ctrl+K).
export { CommandPalette, filterCommands } from "./command_palette.ts";
export type { Command, CommandPaletteOptions } from "./command_palette.ts";

// Accessibility helpers.
export {
  nextIndex,
  prefersReducedMotion,
  focusableWithin,
  createFocusTrap,
  createLiveRegion,
} from "./a11y.ts";
export type { FocusTrap, LiveRegion, MediaMatcher } from "./a11y.ts";

// DOM + sanitisation helpers.
export { el, clear, safeUrl, isSuspiciousHost } from "./dom.ts";
export type { Attrs } from "./dom.ts";

// PWA runtime (service worker + update banner, Badging API, iOS install hint) and its pure helpers.
export { PwaController, browserPwaEnv } from "./pwa.ts";
export type { PwaEnv, PwaControllerDeps, SwUpdateHandle } from "./pwa.ts";

// GC_MESSENGER_DIRECT_APK_ONLY_START
// T-413 — native (APK) update surfaces: the dismissible banner + the blocking force screen. Only a
// native shell mounts these; the web/PWA update path stays the service worker above.
export { presentUpdateStatus } from "./update_banner.ts";
export type {
  UpdateStatusLike,
  PresentUpdateDeps,
  UpdateSurfaceHandle,
} from "./update_banner.ts";
// GC_MESSENGER_DIRECT_APK_ONLY_END
export {
  isIos,
  isIosSafari,
  isInstalled,
  shouldPromptIosInstall,
  parseShareParams,
  hasShare,
  shareToText,
  badgeCount,
} from "./pwa_model.ts";
export type {
  ShareParams,
  StandaloneInput,
  IosInstallInput,
} from "./pwa_model.ts";
