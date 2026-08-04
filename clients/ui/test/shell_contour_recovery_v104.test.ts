// A silence from /v1/config must not cost the user the money tabs for the whole session.
//
// Measured on the P0 device (redroid Android 15, signed direct APK 1000013, CDP request interception
// failing ONLY */v1/config*): signing in through a dead network produced the bar «Chats | Calls | More»
// and it never changed again. Restoring the network, switching tabs, backgrounding and returning —
// nothing asked a second time (the interception log counted 4 failed probes at start-up and then zero
// requests for the rest of the session). Killing the process and starting it again with the server
// reachable produced «Chats | Calls | Wallet | Exchange | More». So the contour was not "unavailable
// here"; it was "unknown, and never asked again" — a permanent loss of two fifths of the primary
// navigation caused by one badly timed second of network.
//
// The contract pinned here: the probe repeats until the server ACTUALLY answers, a wake-up (the app
// returning to the foreground) asks immediately, and an answer once received is final — no later
// failure may take a live destination away under the user's finger.
import test from "node:test";
import assert from "node:assert/strict";

import { installDomStub, dispatchDocument, settle, StubNode } from "./dom_stub.ts";
import { createApp } from "../src/screens/app.ts";
import { Session } from "../src/screens/session.ts";
import { HashRouter, WEB_ROUTES } from "../src/router.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import type { OutboxPort, EventFeed } from "../src/screens/feed_screen.ts";
import type { HashEnv } from "../src/router.ts";
import type {
  TokenHolder,
  SessionStorage,
  PersistedSession,
} from "../src/screens/session.ts";

installDomStub();

const CONFIG = "/v1/config";
const PAYMENTS_ON = { features: { cards: false, payments: true, demo_finance: true } };

class ScriptedApi implements ApiLike {
  calls: string[] = [];
  /** Flip to false to make the public config probe unreachable, exactly like a dead network. */
  configReachable = false;
  private dispatch<T>(path: string): Promise<T> {
    this.calls.push(path);
    if (path === CONFIG) {
      return this.configReachable
        ? (Promise.resolve(PAYMENTS_ON) as Promise<T>)
        : Promise.reject(Object.assign(new Error("offline"), { name: "NetworkError" }));
    }
    if (path.startsWith("/v1/chats")) return Promise.resolve([] as unknown as T);
    if (path === "/v1/badge") return Promise.resolve({ total_unread: 0 } as unknown as T);
    if (path === "/v1/legal/status")
      return Promise.resolve({ accepted_version: 2, current_version: 2, reconsent_required: false } as unknown as T);
    // Everything else is "the network shrugged": every gate in the shell fails open on that, so no
    // unrelated screen can hijack the surface this test is measuring.
    return Promise.reject(Object.assign(new Error(`unhandled ${path}`), { name: "NetworkError" }));
  }
  get<T>(path: string): Promise<T> { return this.dispatch<T>(path); }
  post<T>(path: string): Promise<T> { return this.dispatch<T>(path); }
  put<T>(path: string): Promise<T> { return this.dispatch<T>(path); }
  patch<T>(path: string): Promise<T> { return this.dispatch<T>(path); }
  delete<T>(path: string): Promise<T> { return this.dispatch<T>(path); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(true); }
  probes(): number { return this.calls.filter((p) => p === CONFIG).length; }
}

class FakeStorage implements SessionStorage {
  value: PersistedSession | null = { refresh: "ref-1", user: { id: 7, username: "ann", name: "Ann" } };
  load(): PersistedSession | null { return this.value; }
  save(v: PersistedSession): void { this.value = v; }
  clear(): void { this.value = null; }
}

const fakeHashEnv = (): HashEnv => {
  let hash = "";
  const subs = new Set<() => void>();
  return {
    getHash: () => hash,
    setHash: (h: string) => { hash = h; for (const s of [...subs]) s(); },
    listen: (cb: () => void) => { subs.add(cb); return () => subs.delete(cb); },
  };
};

const harness = async () => {
  const api = new ScriptedApi();
  const tokens: TokenHolder = { access: null, refresh: null, accessExpiresAt: null };
  const session = new Session({ api, tokens, storage: new FakeStorage() });
  await session.restore();
  const host = new StubNode("div");
  const app = createApp({
    host: host as unknown as HTMLElement,
    api,
    session,
    i18n: createI18n({ locale: "en", dicts: { ru, en } }),
    router: new HashRouter(WEB_ROUTES, fakeHashEnv()),
    outbox: { subscribe: () => () => {} } as unknown as OutboxPort,
    events: { subscribe: () => () => {} } as EventFeed,
  });
  return { api, app, host };
};

const bar = (host: StubNode): string[] =>
  host
    .findAll((n) => n.attrs["class"]?.split(/\s+/).includes("gc-shell-item") === true)
    .map((n) => n.textContent.trim())
    .filter((t) => t.length > 0);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a probe that never answered is retried, and the money tabs arrive without a restart", async () => {
  const h = await harness();
  h.app.start();
  await settle();

  // Cold start with the server unreachable: the conservative bar, exactly as measured on the device.
  const cold = bar(h.host);
  assert.ok(cold.length > 0, "the shell must paint a navigation bar");
  assert.equal(cold.some((t) => /wallet|exchange/i.test(t)), false, "an unknown contour is not advertised");
  const firstProbes = h.api.probes();
  assert.ok(firstProbes >= 1, "the shell probes /v1/config at start-up");

  // The network comes back. The user does nothing but return to the app.
  h.api.configReachable = true;
  dispatchDocument("visibilitychange");
  await settle();
  assert.ok(h.api.probes() > firstProbes, "waking the app must ask again, not trust the old silence");

  const warm = bar(h.host);
  assert.ok(warm.some((t) => /wallet/i.test(t)), `Wallet must return: ${warm.join(" | ")}`);
  // V161: «Биржа» is no longer a tab (the wallet already opens it, and the hub lists it), so the money
  // contour is proven by Wallet alone. What the bar must show either way is «Контакты»: it depends on
  // no server flag, so an unreachable /v1/config may never take it away.
  assert.equal(warm.some((t) => /exchange|бирж/i.test(t)), false, `the bar must not re-add the exchange: ${warm.join(" | ")}`);
  assert.ok(cold.some((t) => /contact|контакт/i.test(t)), `Contacts must survive an unreachable probe: ${cold.join(" | ")}`);
  assert.ok(warm.some((t) => /contact|контакт/i.test(t)), `Contacts must stay once the probe answers: ${warm.join(" | ")}`);
  h.app.destroy();
});

test("with no user interaction at all the backoff alone recovers the bar", async () => {
  const h = await harness();
  h.app.start();
  await settle();
  assert.equal(bar(h.host).some((t) => /wallet/i.test(t)), false);

  h.api.configReachable = true; // nobody touches the phone; the first backoff step is a second
  await sleep(1400);
  await settle();
  assert.ok(bar(h.host).some((t) => /wallet/i.test(t)), `the retry must land on its own: ${bar(h.host).join(" | ")}`);
  h.app.destroy();
});

test("an answer is final: a later failure cannot take a live destination away", async () => {
  const h = await harness();
  h.api.configReachable = true;
  h.app.start();
  await settle();
  assert.ok(bar(h.host).some((t) => /wallet/i.test(t)), "payments-on server shows the full bar");
  const answered = h.api.probes();

  h.api.configReachable = false; // the network dies while the user is inside the app
  dispatchDocument("visibilitychange");
  await settle();
  assert.equal(h.api.probes(), answered, "no re-probe once the contour is known");
  assert.ok(bar(h.host).some((t) => /wallet/i.test(t)), "a tab must never vanish under the finger");
  h.app.destroy();
});

test("destroy() stops the retry loop: a dead shell must not keep polling", async () => {
  const h = await harness();
  h.app.start();
  await settle();
  h.app.destroy();
  const after = h.api.probes();
  h.api.configReachable = true;
  dispatchDocument("visibilitychange");
  await sleep(1400);
  await settle();
  assert.equal(h.api.probes(), after, "a destroyed shell asks nothing");
});
