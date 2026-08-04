// clients/ui/src/screens/share.ts — Web Share Target intake (T-408). When the OS shares text/a link
// into the installed PWA, the shell opens at the action URL ("/") with the payload in the query; the
// boot code parses it (pwa_model.parseShareParams/shareToText) and stashes the composed text here. The
// next chat the user opens seeds its composer from this pending value (a share has no target chat of its
// own). A module singleton keeps the app/router untouched; the value is taken exactly once. DOM-free so
// node:test covers it.
let pending: string | null = null;

// Stash text shared into the app. Empty/blank input clears any pending share instead of storing noise.
export function setPendingShare(text: string): void {
  const trimmed = text.trim();
  pending = trimmed.length > 0 ? trimmed : null;
}

export function hasPendingShare(): boolean {
  return pending !== null;
}

// Read without consuming (e.g. to decide whether to route to a chat first).
export function peekPendingShare(): string | null {
  return pending;
}

// Consume the pending share, returning it once and clearing it so later chats don't re-seed.
export function takePendingShare(): string | null {
  const value = pending;
  pending = null;
  return value;
}
