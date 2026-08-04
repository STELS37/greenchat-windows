// clients/ui/src/pwa_model.ts — pure PWA helpers (T-408). DOM-free so node:test covers platform
// detection, the iOS install-hint gate, Web Share Target parsing and the badge value without a browser.

export interface ShareParams {
  title?: string;
  text?: string;
  url?: string;
}

// iOS / iPadOS. iPadOS 13+ reports a desktop "Macintosh" UA but exposes multi-touch — the maxTouchPoints
// probe recovers it. UA + touch are injected so the check is testable without a real navigator.
export function isIos(ua: string, maxTouchPoints = 0): boolean {
  if (/iphone|ipod|ipad/i.test(ua)) return true;
  return /macintosh/i.test(ua) && maxTouchPoints > 1;
}

// Only Safari on iOS can Add-to-Home-Screen into a push-capable PWA; the WebKit-wrapped Chrome/Firefox/
// Edge cannot, and they tag their iOS UA (CriOS/FxiOS/EdgiOS/OPiOS). So the install hint targets Safari.
export function isIosSafari(ua: string, maxTouchPoints = 0): boolean {
  return isIos(ua, maxTouchPoints) && !/crios|fxios|edgios|opios|mercury/i.test(ua);
}

export interface StandaloneInput {
  displayStandalone: boolean; // matchMedia("(display-mode: standalone)").matches
  navigatorStandalone?: boolean; // iOS Safari legacy navigator.standalone
}

// Already installed / launched from the Home Screen — either the standard display-mode media query or
// the iOS-legacy navigator.standalone flag.
export function isInstalled(input: StandaloneInput): boolean {
  return input.displayStandalone === true || input.navigatorStandalone === true;
}

export interface IosInstallInput extends StandaloneInput {
  ua: string;
  maxTouchPoints?: number;
  dismissed: boolean;
}

// Show the "Add to Home Screen" hint only to iOS-Safari users who have neither installed nor dismissed it.
export function shouldPromptIosInstall(input: IosInstallInput): boolean {
  if (input.dismissed) return false;
  if (isInstalled(input)) return false;
  return isIosSafari(input.ua, input.maxTouchPoints ?? 0);
}

// Web Share Target (GET): the OS launches the PWA at the action URL with title/text/url in the query.
// Blank fields are dropped so shareToText joins only what was actually shared.
export function parseShareParams(search: string): ShareParams {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pick = (k: string): string | undefined => {
    const v = q.get(k);
    return v != null && v.trim().length > 0 ? v : undefined;
  };
  const title = pick("title");
  const text = pick("text");
  const url = pick("url");
  return {
    ...(title !== undefined ? { title } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

export function hasShare(p: ShareParams): boolean {
  return p.title !== undefined || p.text !== undefined || p.url !== undefined;
}

// Fold shared fields into one message body: title, then text, then url — skipping a url already present
// verbatim inside the text (many apps duplicate the link into the text field).
export function shareToText(p: ShareParams): string {
  const parts: string[] = [];
  if (p.title) parts.push(p.title.trim());
  if (p.text) parts.push(p.text.trim());
  if (p.url && (!p.text || !p.text.includes(p.url))) parts.push(p.url.trim());
  return parts.join("\n").trim();
}

// The Badging API takes a non-negative integer; a count of 0 (or invalid) means "clear the badge".
export function badgeCount(total: number): number {
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}
