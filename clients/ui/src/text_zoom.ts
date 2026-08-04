// clients/ui/src/text_zoom.ts — measure the *system* text zoom the platform applies on top of our
// own font tokens, and publish it as `--gc-sys-text-zoom` on the root element.
//
// Why this exists (observed, not assumed). On the Android emulator with the system font size at its
// maximum (Settings → Display → Font size, `settings get system font_scale` = 2.0) the WebView
// multiplies every computed font-size by 2. Probed on the device through CDP: a probe element with
// `font-size: 11px` computes to 22px, `1rem` to 32px, even `3vw` doubles — no CSS unit escapes it,
// and `text-size-adjust: none` does not switch it off. That is correct for body copy: a user who
// asks for bigger text must get bigger text. It is wrong for the fixed five-cell bottom navigation:
// the "Exchange" label then needs 104px inside a 71px cell, so the bar reads "Wallet Exc…" with the
// words touching, and every label is also clipped vertically (scrollHeight 27 vs clientHeight 22).
//
// CSS cannot measure text, so we measure once in JS and hand CSS a number to divide by. Layout that
// must stay inside a fixed box uses `min(<token>, calc(<ceiling>px / var(--gc-sys-text-zoom)))` —
// at zoom 1 the token wins and nothing changes; at zoom 2 the rendered size is capped. Body copy
// never references the variable, so accessibility text growth is untouched.

/** Font size of the hidden probe element, in CSS px before any system zoom. */
export const TEXT_ZOOM_PROBE_PX = 16;
/** Below this the measurement is noise (rounding, unusual font metrics) — treat as "no zoom". */
export const TEXT_ZOOM_MIN = 1;
/** Guards against absurd values from a broken measurement; Android tops out at 2. */
export const TEXT_ZOOM_MAX = 4;
/**
 * At and above this factor the widest fixed-size chrome (the five-cell bottom navigation) switches
 * to capped type. 1.4 is the first Android step that breaks that bar: at 1.3 "Exchange" still fits.
 */
export const TEXT_ZOOM_LARGE = 1.4;
/**
 * Narrower fixed boxes break one step earlier. Measured on the signed APK on a 392 dp screen at
 * `font_scale` 1.30: the four-up wallet quick-action tiles are ~76 dp, and "Addresses" was already
 * cut mid-word there while the bottom bar was still fine. 1.15 is Android's first step above the
 * default, so any user who enlarged text at all gets those tiles capped; a device left at the
 * default publishes no attribute and renders byte-identical CSS to before this file existed.
 */
export const TEXT_ZOOM_MEDIUM = 1.15;

/** Pure: does this factor need the widest chrome capped (bottom bar)? */
export function isLargeTextZoom(value: number): boolean {
  return Number.isFinite(value) && value >= TEXT_ZOOM_LARGE;
}

/** Pure: which cap level a measured factor belongs to; `null` means "render exactly as before". */
export function textZoomLevel(value: number): "large" | "medium" | null {
  if (!Number.isFinite(value)) return null;
  if (value >= TEXT_ZOOM_LARGE) return "large";
  if (value >= TEXT_ZOOM_MEDIUM) return "medium";
  return null;
}

/** Pure: turn a measured probe size into a zoom factor. Never returns 0, NaN or a shrink factor. */
export function textZoomFrom(
  measuredPx: number,
  probePx: number = TEXT_ZOOM_PROBE_PX,
): number {
  if (!Number.isFinite(measuredPx) || !Number.isFinite(probePx) || probePx <= 0)
    return TEXT_ZOOM_MIN;
  const raw = measuredPx / probePx;
  if (!Number.isFinite(raw)) return TEXT_ZOOM_MIN;
  const clamped = Math.min(TEXT_ZOOM_MAX, Math.max(TEXT_ZOOM_MIN, raw));
  // Two decimals: enough for the cap arithmetic, stable enough not to churn the style property.
  return Math.round(clamped * 100) / 100;
}

export interface TextZoomEnv {
  /** Measure the rendered font size, in px, of a probe declared at `TEXT_ZOOM_PROBE_PX`. */
  measure(): number;
  /** Publish the factor (the root element in the browser). */
  publish(value: number): void;
  /** Re-measure hooks; each returns its own unsubscribe. */
  onChange(cb: () => void): () => void;
}

/** Measure now, publish, and keep it current. Returns a disposer. */
export function watchSystemTextZoom(env: TextZoomEnv): () => void {
  let last = -1;
  const run = (): void => {
    const value = textZoomFrom(env.measure());
    if (value === last) return;
    last = value;
    env.publish(value);
  };
  run();
  const off = env.onChange(run);
  return () => {
    off();
  };
}

/** Browser wiring. Every DOM access is guarded so importing this never throws outside a browser. */
export function browserTextZoomEnv(): TextZoomEnv | null {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function")
    return null;
  const root = document.documentElement;
  return {
    measure: () => {
      const probe = document.createElement("span");
      // The probe is styled through the CSSOM, NOT through a `style="…"` attribute. Measured in the
      // browser on 2026-07-30: our own Content-Security-Policy is `style-src 'self'`, which by spec
      // covers `style-src-attr`, so Chrome refused the attribute outright ("Applying inline style
      // violates … The action has been blocked"). The probe then inherited the page's font size and
      // this function measured the APP's font scale instead of the system's — a user who enlarged
      // text inside Green Chat would have been reported as a device at 1.25 system zoom. CSSOM
      // property writes are not inline styles and are not blocked, so the isolation is real again.
      const s = probe.style;
      s.position = "fixed";
      s.left = "-9999px";
      s.top = "0";
      s.visibility = "hidden";
      s.pointerEvents = "none";
      s.fontSize = `${TEXT_ZOOM_PROBE_PX}px`;
      s.lineHeight = "1";
      probe.textContent = "M";
      document.body.appendChild(probe);
      const measured =
        parseFloat(getComputedStyle(probe).fontSize) || TEXT_ZOOM_PROBE_PX;
      probe.remove();
      return measured;
    },
    publish: (value) => {
      root.style.setProperty("--gc-sys-text-zoom", String(value));
      const level = textZoomLevel(value);
      if (level) root.setAttribute("data-gc-text-zoom", level);
      else root.removeAttribute("data-gc-text-zoom");
    },
    onChange: (cb) => {
      // The system font size can change while the app is backgrounded: Android re-creates the
      // WebView configuration and fires a resize, and returning to the app fires visibilitychange.
      const onResize = (): void => cb();
      const onVisible = (): void => {
        if (document.visibilityState === "visible") cb();
      };
      if (typeof addEventListener === "function")
        addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        if (typeof removeEventListener === "function")
          removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
  };
}
