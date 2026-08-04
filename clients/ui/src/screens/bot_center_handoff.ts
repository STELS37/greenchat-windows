// A one-shot navigation intent used by the Chats → Create → Bot entry point. The hash router already
// owns /bots, so no second route is introduced; this tiny handoff only tells Bot Center to open its
// existing creation form rather than making the user tap “Create bot” again after navigation.
export const BOT_CREATE_INTENT_KEY = "gc.bot-center.create";

export interface BotIntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): BotIntentStorage | null {
  try {
    return (globalThis as { sessionStorage?: BotIntentStorage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function markBotCreateIntent(storage: BotIntentStorage | null = browserStorage()): void {
  try { storage?.setItem(BOT_CREATE_INTENT_KEY, "1"); } catch { /* storage can be blocked */ }
}

export function consumeBotCreateIntent(storage: BotIntentStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const requested = storage.getItem(BOT_CREATE_INTENT_KEY) === "1";
    storage.removeItem(BOT_CREATE_INTENT_KEY);
    return requested;
  } catch {
    return false;
  }
}

export function openBotCreateFlow(
  storage: BotIntentStorage | null = browserStorage(),
  locationPort: { hash: string } | null = (globalThis as { location?: { hash: string } }).location ?? null,
): void {
  markBotCreateIntent(storage);
  if (locationPort) locationPort.hash = "#/bots";
}
