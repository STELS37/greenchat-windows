// clients/ui/src/pwa.ts — PWA runtime controller (T-408, CLIENTS §7.1): registers the service worker,
// surfaces the «Обновить» update banner (skipWaiting handshake), drives the Badging API from the unread
// total, and shows the iOS "Add to Home Screen" hint. All browser specifics sit behind PwaEnv so the
// control flow is unit-testable with a fake env; banners are built from gc- classes + i18n like every
// other screen. The pure decisions (platform gate, badge value) live in pwa_model.ts.
import type { I18n } from "./i18n.ts";
import { el } from "./dom.ts";
import { badgeCount, shouldPromptIosInstall } from "./pwa_model.ts";
import { icon } from "./icons.ts";

// A registered service worker with a pending update. The messy browser wiring lives in browserPwaEnv;
// the controller only needs to know whether a new worker waits and how to activate it.
export interface SwUpdateHandle {
  hasWaiting(): boolean;
  onWaiting(cb: () => void): void;
  activate(): void; // ask the waiting worker to skipWaiting
}

export interface PwaEnv {
  registerSW(url: string): Promise<SwUpdateHandle | null>;
  onControllerChange(cb: () => void): void;
  reload(): void;
  setBadge(count: number): void;
  ua(): string;
  maxTouchPoints(): number;
  matchStandalone(): boolean;
  navigatorStandalone(): boolean | undefined;
  storageGet(key: string): string | null;
  storageSet(key: string, value: string): void;
}

const IOS_DISMISS_KEY = "gc.pwa.iosHintDismissed";

export interface PwaControllerDeps {
  env: PwaEnv;
  i18n: I18n;
  host: HTMLElement; // where banners mount (typically document.body)
  swUrl?: string; // default "/sw.js"
}

export class PwaController {
  private readonly env: PwaEnv;
  private readonly i18n: I18n;
  private readonly host: HTMLElement;
  private readonly swUrl: string;
  private pendingReload = false; // set when the user accepts an update → reload on controllerchange
  private updateBanner: HTMLElement | null = null; // kept after dismiss so this app run stays quiet

  constructor(deps: PwaControllerDeps) {
    this.env = deps.env;
    this.i18n = deps.i18n;
    this.host = deps.host;
    this.swUrl = deps.swUrl ?? "/sw.js";
  }

  // Register the SW and wire the update handshake. Safe to call once at boot; a no-op where SW is absent.
  async start(): Promise<void> {
    this.env.onControllerChange(() => {
      // Reload only for an update the user accepted here. The initial clients.claim() on first visit also
      // fires controllerchange but must not reload — pendingReload gates that out.
      if (!this.pendingReload) return;
      this.pendingReload = false;
      this.env.reload();
    });
    const handle = await this.env.registerSW(this.swUrl);
    if (!handle) return;
    if (handle.hasWaiting()) this.showUpdateBanner(handle);
    handle.onWaiting(() => this.showUpdateBanner(handle));
  }

  private showUpdateBanner(handle: SwUpdateHandle): void {
    if (this.updateBanner) return;
    const t = (k: string): string => this.i18n.t(k);
    const btn = el(
      "button",
      { type: "button", class: "gc-btn gc-btn-accent gc-pwa-update-btn" },
      [t("pwa.updateAction")],
    );
    const close = el(
      "button",
      {
        type: "button",
        class: "gc-update-notice-dismiss",
        "aria-label": t("common.close"),
      },
    );
    const banner = el(
      "div",
      {
        class: "gc-pwa-update gc-update-notice",
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
      },
      [el("span", { class: "gc-pwa-update-text" }, [t("pwa.updateAvailable")]), btn, close],
    );
    btn.addEventListener("click", () => {
      btn.disabled = true;
      this.pendingReload = true;
      handle.activate();
    });
    close.addEventListener("click", () => banner.remove());
    this.updateBanner = banner;
    this.host.append(banner);
  }

  // Badging API: reflect the unread total on the app icon; a total of 0 clears it.
  setBadge(total: number): void {
    this.env.setBadge(badgeCount(total));
  }

  // iOS install hint: one dismissible card for iOS-Safari users who have not installed the PWA.
  maybeShowIosInstall(): void {
    const dismissed = this.env.storageGet(IOS_DISMISS_KEY) === "1";
    const nav = this.env.navigatorStandalone();
    const show = shouldPromptIosInstall({
      ua: this.env.ua(),
      maxTouchPoints: this.env.maxTouchPoints(),
      displayStandalone: this.env.matchStandalone(),
      dismissed,
      ...(nav !== undefined ? { navigatorStandalone: nav } : {}),
    });
    if (!show) return;
    const t = (k: string): string => this.i18n.t(k);
    const close = el("button", { type: "button", class: "gc-pwa-ios-close", "aria-label": t("common.close") }, [
      icon("close"),
    ]);
    const card = el("div", { class: "gc-pwa-ios", role: "dialog", "aria-label": t("pwa.iosTitle") }, [
      el("div", { class: "gc-pwa-ios-body" }, [
        el("strong", {}, [t("pwa.iosTitle")]),
        el("p", {}, [
          t("pwa.iosStep1"),
          " ",
          el("span", { class: "gc-pwa-ios-share", "aria-hidden": "true" }, [icon("upload")]),
          " ",
          t("pwa.iosStep2"),
        ]),
      ]),
      close,
    ]);
    close.addEventListener("click", () => {
      this.env.storageSet(IOS_DISMISS_KEY, "1");
      card.remove();
    });
    this.host.append(card);
  }
}

// Real browser environment. Guarded by typeof so importing this module never throws under node/tests.
export function browserPwaEnv(): PwaEnv {
  const swSupported = (): boolean => typeof navigator !== "undefined" && "serviceWorker" in navigator;
  return {
    async registerSW(url: string): Promise<SwUpdateHandle | null> {
      if (!swSupported()) return null;
      let reg: ServiceWorkerRegistration;
      try {
        reg = await navigator.serviceWorker.register(url);
      } catch {
        return null;
      }
      const waitingCbs = new Set<() => void>();
      const notify = (): void => {
        for (const cb of [...waitingCbs]) cb();
      };
      // Mobile browsers may keep an installed PWA alive for days and throttle the browser's implicit
      // service-worker checks. Ask explicitly at boot, when connectivity returns, when the app becomes
      // visible again, and periodically while it remains open. Every call is best-effort and absorbed:
      // update discovery must never block startup or create an unhandled rejection.
      const check = (): void => {
        try {
          if (typeof reg.update === "function") void reg.update().catch(() => undefined);
        } catch {
          /* older WebView / synchronous browser failure */
        }
      };
      check();
      const interval = globalThis.setInterval(check, 15 * 60 * 1000);
      if (typeof globalThis.addEventListener === "function") {
        globalThis.addEventListener("online", check);
      }
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        });
      }
      void interval; // the PWA controller is process-lifetime; no detached screen owns this timer.
      // A new worker appears now or later; it becomes "waiting" once installed while an old one controls.
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) notify();
        });
      });

      return {
        hasWaiting: () => reg.waiting != null && navigator.serviceWorker.controller != null,
        onWaiting: (cb) => {
          waitingCbs.add(cb);
        },
        activate: () => {
          reg.waiting?.postMessage({ type: "SKIP_WAITING" });
        },
      };
    },
    onControllerChange: (cb) => {
      if (!swSupported()) return;
      navigator.serviceWorker.addEventListener("controllerchange", cb);
    },
    reload: () => {
      if (typeof location !== "undefined") location.reload();
    },
    setBadge: (count) => {
      if (typeof navigator === "undefined") return;
      const n = navigator as Navigator & {
        setAppBadge?: (n?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      try {
        if (count > 0 && typeof n.setAppBadge === "function") {
          void n.setAppBadge(count).catch(() => undefined);
        } else if (typeof n.clearAppBadge === "function") {
          void n.clearAppBadge().catch(() => undefined);
        }
      } catch {
        /* badging unsupported or blocked */
      }
    },
    ua: () => (typeof navigator !== "undefined" ? navigator.userAgent : ""),
    maxTouchPoints: () => (typeof navigator !== "undefined" ? navigator.maxTouchPoints || 0 : 0),
    matchStandalone: () =>
      typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: () => {
      if (typeof navigator === "undefined") return undefined;
      const s = (navigator as Navigator & { standalone?: boolean }).standalone;
      return typeof s === "boolean" ? s : undefined;
    },
    storageGet: (k) => {
      try {
        return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null;
      } catch {
        return null;
      }
    },
    storageSet: (k, v) => {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
      } catch {
        /* private mode / quota — ignore */
      }
    },
  };
}
