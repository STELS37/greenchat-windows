import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePath, matchRoutes, deepLinkToHash, HashRouter, WEB_ROUTES } from "../src/router.ts";
import type { HashEnv, Route } from "../src/router.ts";

test("parsePath: normalises hashes", () => {
  assert.equal(parsePath("#/chat/42"), "/chat/42");
  assert.equal(parsePath(""), "/");
  assert.equal(parsePath("#"), "/");
  assert.equal(parsePath("#/chat/42/"), "/chat/42");
  assert.equal(parsePath("#/chat/42?from=list"), "/chat/42");
  assert.equal(parsePath("chat/42"), "/chat/42");
});

test("matchRoutes: specific routes win over generic ones", () => {
  assert.equal(matchRoutes(WEB_ROUTES, "/")?.name, "home");
  assert.equal(matchRoutes(WEB_ROUTES, "/settings")?.name, "settings");
  const authQr = matchRoutes(WEB_ROUTES, `/auth/qr/${"a".repeat(96)}`);
  assert.equal(authQr?.name, "authQr");
  assert.equal(authQr?.params.token, "a".repeat(96));
  const chat = matchRoutes(WEB_ROUTES, "/chat/42");
  assert.equal(chat?.name, "chat");
  assert.equal(chat?.params.id, "42");
  const msg = matchRoutes(WEB_ROUTES, "/chat/42/message/9");
  assert.equal(msg?.name, "message");
  assert.deepEqual(msg?.params, { id: "42", mid: "9" });
  assert.equal(matchRoutes(WEB_ROUTES, "/user/john")?.params.username, "john");
  assert.equal(matchRoutes(WEB_ROUTES, "/nope"), null);
});

test("matchRoutes: the T-419 «Адрес сервера» route resolves (with a ?host= query stripped by parsePath)", () => {
  assert.equal(matchRoutes(WEB_ROUTES, "/connect")?.name, "connect");
  // The deep link greenchat://connect?host=… arrives as "#/connect?host=…"; parsePath drops the query,
  // and the shell reads ?host separately — so the route must still match the bare "/connect" path.
  assert.equal(matchRoutes(WEB_ROUTES, parsePath("#/connect?host=https%3A%2F%2Fchat.example.org"))?.name, "connect");
});

test("deepLinkToHash: native scheme → web hash", () => {
  assert.equal(deepLinkToHash("greenchat://chat/42"), "#/chat/42");
  assert.equal(deepLinkToHash(`greenchat://auth/qr/${"b".repeat(96)}`), `#/auth/qr/${"b".repeat(96)}`);
  assert.equal(deepLinkToHash("gcpay://invoice/ABC"), "#/pay/invoice/ABC");
  assert.equal(deepLinkToHash("https://example.com"), null);
});

// A fake HashEnv drives the router without a browser: setHash emulates a hashchange.
function fakeHashEnv(initial = "#/"): HashEnv {
  let hash = initial;
  let cb: (() => void) | null = null;
  return {
    getHash: () => hash,
    setHash: (h: string) => { hash = h; cb?.(); },
    listen: (fn: () => void) => { cb = fn; return () => { cb = null; }; },
  };
}

test("HashRouter: resolves, navigates and notifies", () => {
  const env = fakeHashEnv("#/");
  const router = new HashRouter(WEB_ROUTES, env);
  const seen: Route[] = [];
  router.subscribe((r) => seen.push(r));
  router.start();
  assert.equal(router.current().name, "home");

  router.navigate("/chat/7");
  assert.equal(router.current().name, "chat");
  assert.equal(router.current().params.id, "7");
  assert.equal(seen.at(-1)?.name, "chat");

  router.navigate("/nope");
  assert.equal(router.current().name, "notFound");

  router.stop();
  router.navigate("/settings"); // ignored after stop (listener detached)
  assert.equal(router.current().name, "notFound");
});

// A hash env that behaves like a real browser: assigning the value the hash already holds fires no
// `hashchange`. The fake above is deliberately looser (it always notifies), and both shapes are
// exercised, because the router must not depend on which one it is given.
function browserFaithfulHashEnv(initial = "#/"): HashEnv {
  let hash = initial;
  let cb: (() => void) | null = null;
  return {
    getHash: () => hash,
    setHash: (h: string) => { if (h === hash) return; hash = h; cb?.(); },
    listen: (fn: () => void) => { cb = fn; return () => { cb = null; }; },
  };
}

test("HashRouter: re-navigating to the live route still notifies (re-tap of the active tab)", () => {
  // The bottom bar sends you to "/settings" whether or not Settings is already on screen, and the
  // app answers a same-destination route by popping that screen back to its own root
  // (Mounted.reset). With a browser-faithful hash env that used to be a dead press: no hashchange,
  // no route delivery, no reset — «Ещё» -> «Профиль» had no way back except the in-screen arrow.
  const env = browserFaithfulHashEnv("#/");
  const router = new HashRouter(WEB_ROUTES, env);
  const seen: Route[] = [];
  router.subscribe((r) => seen.push(r));
  router.start();

  router.navigate("/settings");
  assert.equal(seen.length, 1);
  assert.equal(seen.at(-1)?.name, "settings");

  router.navigate("/settings"); // same destination, re-tap
  assert.equal(seen.length, 2, "a re-tap of the live destination must still be delivered");
  assert.equal(seen.at(-1)?.name, "settings");
  assert.equal(router.current().name, "settings");
});

test("HashRouter: a same-destination navigate is delivered exactly once, on either env shape", () => {
  // The looser fake notifies from inside setHash() even when the value did not change. The router
  // must not add a second delivery on top of it, or every re-tap would run the app's route() twice
  // (double screen rebuild, lost scroll position).
  const env = fakeHashEnv("#/settings");
  const router = new HashRouter(WEB_ROUTES, env);
  const seen: Route[] = [];
  router.subscribe((r) => seen.push(r));
  router.start();

  router.navigate("/settings");
  assert.equal(seen.length, 1, "exactly one delivery, never two");
});

test("HashRouter: a same-destination navigate before start() stays silent", () => {
  // Nothing is subscribed to a stopped router, and start() re-resolves from the hash anyway.
  const env = browserFaithfulHashEnv("#/settings");
  const router = new HashRouter(WEB_ROUTES, env);
  const seen: Route[] = [];
  router.subscribe((r) => seen.push(r));
  router.navigate("/settings");
  assert.equal(seen.length, 0);
});
