// The address bar must never promise a screen the app is not showing.
//
// Measured defect (signed direct APK app.greenchat versionCode 1000012, redroid 15, CDP against the
// device WebView, 2026-07-31): the fifth item of the bottom bar is labelled «Ещё»/"More", so `#/more`
// is an address a person, a shortcut or a shared link will produce. No route pattern matched it, the
// shell fell through to its home branch, and the chat list was drawn while `location.hash` still read
// `#/more`. The same happened for any typo (`#/definitely-not-a-route`). Because the hash is what a
// reload, a share and a back-press replay, the person was silently returned to a screen they never
// opened — and any bug report made from that address was unreproducible.
//
// The rule under test: an unmatched address is CORRECTED (aliases go to their real screen, everything
// else goes home) instead of being kept while another screen is drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HashRouter, WEB_ROUTES, aliasTarget, correctedPath, matchRoutes, parsePath } from "../src/router.ts";
import type { HashEnv } from "../src/router.ts";

// Browser-faithful: assigning the hash it already holds fires no hashchange.
function hashEnv(initial = "#/"): HashEnv {
  let hash = initial;
  let cb: (() => void) | null = null;
  return {
    getHash: () => hash,
    setHash: (h: string) => { if (h === hash) return; hash = h; cb?.(); },
    listen: (fn: () => void) => { cb = fn; return () => { cb = null; }; },
  };
}

test("correctedPath: only an unmatched address is rewritten", () => {
  assert.equal(correctedPath({ name: "chats", path: "/chats" }), null);
  assert.equal(correctedPath({ name: "home", path: "/" }), null);
  assert.equal(correctedPath({ name: "chat", path: "/chat/7" }), null);
  // The one address whose label and route genuinely disagree.
  assert.equal(correctedPath({ name: "notFound", path: "/more" }), "/settings");
  // Everything else is a real not-found: home, not a silent chat list under a foreign address.
  assert.equal(correctedPath({ name: "notFound", path: "/definitely-not-a-route" }), "/");
  assert.equal(correctedPath({ name: "notFound", path: "/wallet/typo" }), "/");
});

test("every alias target is a real route (an alias may never point into the void)", () => {
  for (const [from, to] of Object.entries({ "/more": aliasTarget("/more") })) {
    assert.equal(matchRoutes(WEB_ROUTES, from), null, `${from} must not be a pattern itself`);
    assert.ok(to, `${from} must resolve`);
    assert.ok(matchRoutes(WEB_ROUTES, to as string), `${from} -> ${to} must match a real route`);
    // Guards against an alias loop: the target itself is never a not-found.
    assert.equal(correctedPath({ name: matchRoutes(WEB_ROUTES, to as string)!.name, path: to as string }), null);
  }
});

test("the corrected address is what the router ends on, and it stops there", () => {
  const env = hashEnv("#/more");
  const router = new HashRouter(WEB_ROUTES, env);
  router.start();
  assert.equal(router.current().name, "notFound", "precondition: #/more matches nothing");

  // What the shell does on a not-found route.
  const fix = correctedPath(router.current());
  assert.ok(fix);
  router.navigate(fix as string);

  assert.equal(router.current().name, "settings", "«Ещё» must land on the screen its button opens");
  assert.equal(env.getHash(), "#/settings", "the address must be rewritten, not merely ignored");
  // Second pass: the corrected route is stable — no ping-pong between two addresses.
  assert.equal(correctedPath(router.current()), null);
  router.stop();
});

test("a typo lands on home with home in the address bar", () => {
  const env = hashEnv("#/definitely-not-a-route");
  const router = new HashRouter(WEB_ROUTES, env);
  router.start();
  const fix = correctedPath(router.current());
  assert.equal(fix, "/");
  router.navigate(fix as string);
  assert.equal(router.current().name, "home");
  assert.equal(parsePath(env.getHash()), "/");
  router.stop();
});

test("the shell applies the correction before it draws anything", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(resolve(here, "../src/screens/app.ts"), "utf8");
  const body = app.slice(app.indexOf("const route = (): void => {"));
  const correction = body.indexOf("correctedPath(");
  assert.ok(correction > 0, "route() must consult correctedPath");
  // It must run before the screen-drawing branches, otherwise a frame of the wrong screen is shown.
  const firstSwap = body.indexOf("swap(");
  assert.ok(firstSwap > 0);
  assert.ok(correction < firstSwap, "the address is corrected before any screen is swapped in");
});
