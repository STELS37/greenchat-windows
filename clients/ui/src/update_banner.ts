// clients/ui/src/update_banner.ts — T-413: the APK-update surfaces for NATIVE shells.
//
// The shell (clients/web main.ts under Capacitor) asks clients/core fetchUpdateStatus() once at boot
// and hands the verdict here. Two surfaces, PRODUCT_UX tone («ненавязчиво по умолчанию», §8 — never
// steal the composer, never nag):
//   'update' → a dismissible banner («Доступно обновление X.Y.Z»), visually the PWA update banner's
//              sibling (.gc-pwa-update chrome). «Позже» removes it for THIS session — the check runs
//              once per boot and nothing is persisted, so dismissal costs one tap and one launch.
//   'force'  → a blocking full-screen alertdialog: this build is below the server's min_supported
//              (which the server only raises when a downloadable artifact exists — the T-412
//              anti-trap). No dismiss; the ONLY affordance is the download. The app behind it is a
//              build the server will refuse — blocking is honest, not hostile, and the screen says
//              exactly what happens next (browser download → system installer).
// NOTHING here downloads: the tap hands the manifest url to the shell's `openUrl` (Capacitor
// Browser.open / window.open), so the system browser+installer own the transfer — no silent traffic.
//
// UpdateStatusLike MIRRORS clients/core update_checker's UpdateStatus structurally (the ui layer
// deliberately does not import core — settings_model.ts convention).
import type { I18n } from "./i18n.ts";
import { el } from "./dom.ts";
import { createFocusTrap } from "./a11y.ts";

export type UpdateStatusLike =
  | { state: "latest" }
  | { state: "update" | "force"; latest: string; url: string; sha256: string | null; minSupported: string };

export interface PresentUpdateDeps {
  i18n: I18n;
  host: HTMLElement; // where the surface mounts (typically document.body, like the PWA banner)
  current: string; // the running build's version, for the force screen's honest explanation
  openUrl: (url: string) => void; // shell seam: system browser / native downloader takes the url
}

export interface UpdateSurfaceHandle {
  root: HTMLElement;
  destroy(): void;
}

// Mount the surface for a verdict; 'latest' / null (fail-safe silence) mount nothing. Returns a handle
// so a shell that re-checks later could clear a stale banner; destroy() is not wired to any timer here.
export function presentUpdateStatus(
  status: UpdateStatusLike | null,
  deps: PresentUpdateDeps,
): UpdateSurfaceHandle | null {
  if (!status || status.state === "latest") return null;
  return status.state === "update" ? mountBanner(status, deps) : mountForceScreen(status, deps);
}

function mountBanner(
  status: Extract<UpdateStatusLike, { state: "update" | "force" }>,
  deps: PresentUpdateDeps,
): UpdateSurfaceHandle {
  const t = (k: string, p?: Record<string, string | number>): string => deps.i18n.t(k, p);
  const go = el(
    "button",
    { type: "button", class: "gc-btn gc-btn-accent gc-update-banner-btn" },
    [t("update.action")],
  );
  const later = el(
    "button",
    {
      type: "button",
      class: "gc-update-banner-later gc-update-notice-dismiss",
      "aria-label": t("update.later"),
    },
  );
  const banner = el(
    "div",
    {
      class: "gc-pwa-update gc-update-banner gc-update-notice",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    [el("span", { class: "gc-pwa-update-text" }, [t("update.available", { version: status.latest })]), go, later],
  );
  go.addEventListener("click", () => deps.openUrl(status.url));
  later.addEventListener("click", () => banner.remove());
  deps.host.append(banner);
  return { root: banner, destroy: () => banner.remove() };
}

function mountForceScreen(
  status: Extract<UpdateStatusLike, { state: "update" | "force" }>,
  deps: PresentUpdateDeps,
): UpdateSurfaceHandle {
  const t = (k: string, p?: Record<string, string | number>): string => deps.i18n.t(k, p);
  const go = el("button", { type: "button", class: "gc-btn gc-btn-accent gc-update-force-btn" }, [
    t("update.forceAction"),
  ]);
  // The overlay COVERS the app (the reconsent-gate posture): the server refuses this build's writes
  // anyway, so surfaces behind it would only fail confusingly. aria-modal + alertdialog announce it.
  const screen = el(
    "div",
    { class: "gc-update-force", role: "alertdialog", "aria-modal": "true", "aria-label": t("update.forceTitle") },
    [
      el("div", { class: "gc-update-force-card" }, [
        el("h1", { class: "gc-update-force-title" }, [t("update.forceTitle")]),
        el("p", { class: "gc-update-force-body" }, [
          t("update.forceBody", { current: deps.current, min: status.minSupported, version: status.latest }),
        ]),
        go,
        el("p", { class: "gc-update-force-hint" }, [t("update.downloadHint")]),
      ]),
    ],
  );
  go.addEventListener("click", () => {
    // The screen stays mounted: only a successful install (relaunch of the new build) clears a force
    // verdict. The hint under the button tells the person the installer takes over from here.
    deps.openUrl(status.url);
  });
  deps.host.append(screen);
  // The screen has exactly one affordance and hides everything behind it from assistive technology.
  // Without the trap the caret stayed on whatever the app had focused a moment earlier — inside a
  // page the screen reader has just been told does not exist — and Tab walked that invisible page
  // instead of reaching the download button (V152). The trap also wraps Tab onto that single button.
  const trap = createFocusTrap(screen);
  trap.activate();
  return { root: screen, destroy: () => { trap.release(); screen.remove(); } };
}
