// clients/web/src/native_shell.ts — WHICH shell is this bundle running in, and has that shell PROVEN
// that a hardware-backed key actually works here?
//
// The same web bundle is served to a browser tab, to the Capacitor Android/iOS WebView and to the
// Tauri desktop shell, so the answer cannot be read off the bundle — it has to be asked of the host.
//
// Measured on the signed direct APK app.greenchat versionCode 1000013 (redroid 15, dedicated device
// 127.0.0.1:5557, 2026-07-31): `window.__GC_NATIVE` was UNDEFINED in the Android WebView. Only the
// Tauri bridge (clients/desktop/src-tauri/src/bridge.js) and the e2e fixtures ever assign it — the
// Capacitor bridge never did — so every Android install reported itself as a plain browser tab.
// Capacitor's own `window.Capacitor` IS present there (clients/web/src/call_media.ts already reads
// it), so that is the second source consulted here.
//
// The two questions are deliberately SEPARATE. "I am an Android app" is a label; "a hardware-backed
// key works on this device" is a fact that only a completed native key operation can establish, and
// the app lock must key its factor policy off the fact, never off the label. See hardwareKeyProven().

/** The coarse shell family. No version, no PII. */
export type ShellPlatform = "web" | "android" | "ios" | "desktop";

/** The host-provided surfaces consulted here; all optional, all absent in a plain browser tab. */
interface ShellWindow {
  /** Set by the Tauri desktop bridge and by the e2e native fixtures. */
  __GC_NATIVE?: { platform?: string } | undefined;
  /** Capacitor's own runtime, present in the Android/iOS WebView. */
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } | undefined;
  /** Set ONLY by a shell that has completed a hardware-backed key operation. See below. */
  __gcSecureKeyHardware?: unknown;
}

function shellWindow(win: unknown): ShellWindow | undefined {
  return typeof win === "object" && win !== null ? (win as ShellWindow) : undefined;
}

function knownPlatform(value: unknown): ShellPlatform | undefined {
  return value === "android" || value === "ios" || value === "desktop" ? value : undefined;
}

/**
 * The shell family, from the host itself: an explicit `__GC_NATIVE.platform` first (the desktop
 * bridge and the e2e fixtures speak that dialect), then Capacitor's runtime, then "web".
 *
 * Every read is wrapped: a hostile or half-initialised host may throw from a getter, and a
 * diagnostics label is never worth taking the boot down with it.
 */
export function nativeShellPlatform(win: unknown): ShellPlatform {
  const w = shellWindow(win);
  if (!w) return "web";
  try {
    const declared = knownPlatform(w.__GC_NATIVE?.platform);
    if (declared) return declared;
  } catch { /* no native bridge */ }
  try {
    const cap = w.Capacitor;
    if (cap?.isNativePlatform?.() === true) {
      const platform = knownPlatform(cap.getPlatform?.());
      if (platform) return platform;
    }
  } catch { /* no Capacitor runtime */ }
  return "web";
}

/**
 * Has a hardware-backed key been PROVEN to work on this device?
 *
 * Not "is there a SecureKey object" — the Capacitor bridge installs that proxy unconditionally, and
 * its own comment says so: "Merely installing the proxy performs no key operation and shows no
 * prompt". The proxy exists on devices where the key cannot be created at all. Measured on the
 * signed APK on the dedicated redroid device (2026-07-31): the proxy was installed and
 * `SecureKey.ensure()` rejected, because SecureKeyPlugin.kt requires a TEE/StrongBox-backed key
 * (`requireHardwareBacked`) plus a secure lock screen (`setUserAuthenticationRequired(true)`), and
 * the emulator has neither. `__gcDeviceBootMarker` proves nothing either: bootMarker() only reads
 * `Settings.Global.BOOT_COUNT` and never touches the keystore.
 *
 * So the flag below means exactly one thing: a shell called a real hardware key operation and it
 * SUCCEEDED. Absent flag = fail closed = passphrase-mandatory app lock. Anything else lets the lock
 * offer a six-digit PIN whose only defence is Argon2id against an offline filesystem dump, or —
 * worse — pick a "max" container the device then cannot create.
 */
export function hardwareKeyProven(win: unknown): boolean {
  const w = shellWindow(win);
  if (!w) return false;
  try {
    return w.__gcSecureKeyHardware === true;
  } catch {
    return false;
  }
}
