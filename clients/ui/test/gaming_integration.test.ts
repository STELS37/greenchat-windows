import { test } from "node:test";
import assert from "node:assert/strict";
import { gamingExternalUrl, gamingProfile, validateGamingState, type GamingState } from "../src/screens/gaming_model.ts";
import { createGamerModeScreen } from "../src/screens/gamer_mode_screen.ts";
import { createGamingScreen } from "../src/screens/gaming_screen.ts";
import { WEB_ROUTES, matchRoutes } from "../src/router.ts";
import { installDomStub, StubNode, settle, deferred } from "./dom_stub.ts";
import type { ApiLike } from "../src/screens/api.ts";
import type { I18n } from "../src/i18n.ts";

const snapshot = (): GamingState => ({
  settings: { enabled: false, show_current_game: false, show_accounts: false, show_faceit_rank: false },
  profile: { steam: null, faceit: null, current_game: null },
  providers: { steam: { link_available: true }, faceit: { link_available: true, requires_steam: true } },
});
const all = (node: StubNode): StubNode[] => [node, ...node.children.flatMap(all)];
const switchIn = (root: HTMLElement): StubNode => all(root as unknown as StubNode).find(n => n.className === "gc-gm-switch-input")!;
function env(): void {
  installDomStub();
  Object.assign(globalThis, { window: { addEventListener() {}, removeEventListener() {}, confirm: () => true } });
}

test("Gamer Mode route is real and provider links reject unsafe destinations", () => {
  assert.equal(matchRoutes(WEB_ROUTES, "/gamer")?.name, "gamer");
  assert.equal(gamingExternalUrl("https://steamcommunity.com/openid/login?x=1", "steam", true), "https://steamcommunity.com/openid/login?x=1");
  for (const url of ["javascript:alert(1)", "https://steamcommunity.com.evil.test/", "https://user@steamcommunity.com/", "http://steamcommunity.com/", "https://steamcommunity.com:444/"]) {
    assert.throws(() => gamingExternalUrl(url, "steam"));
  }
  assert.throws(() => gamingExternalUrl("https://steamcommunity.com/profiles/1", "steam", true));
});

test("server data maps to rank and current game without invented Epic, hours or achievements", () => {
  const state = snapshot();
  state.profile.steam = { connected: true, steam_level: 12, friends_count: 9 };
  state.profile.faceit = { connected: true, cs2: { skill_level: 8, elo: 1700 } };
  state.profile.current_game = { name: "CS2", art_url: "/v1/gaming/media/steam/game/1/730" };
  const profile = gamingProfile(state, { name: "Player", username: "player" }, { resolveUrl: p => `https://greenchat.test${p}` } as ApiLike);
  assert.equal(profile.faceit?.elo, 1700);
  assert.equal(profile.steam?.level, 12);
  assert.equal(profile.steam?.hours, undefined);
  assert.equal(profile.epic?.linked, false);
  assert.equal(profile.nowPlaying?.imageUrl, "https://greenchat.test/v1/gaming/media/steam/game/1/730");
  assert.throws(() => validateGamingState({ ...state, settings: {} } as GamingState));
});

test("empty cards show no fake rank or connected Epic and particles have distinct positions", () => {
  env();
  const view = createGamerModeScreen({ profile: { name: "Player" }, locale: "en", initialEnabled: false });
  const nodes = all(view.root as unknown as StubNode);
  assert.equal(nodes.find(n => n.className === "gc-gm-faceit-badge")?.textContent, "—");
  assert.equal(nodes.filter(n => n.className.includes("gc-gm-status is-linked")).length, 0);
  assert.equal(new Set(nodes.filter(n => n.className === "gc-gm-particle").map(n => n.style["--x"])).size, 22);
  assert.doesNotMatch(view.root.textContent ?? "", /TikTok|Игровая библиотека/);
  view.destroy();
});

test("failed setting save reverts and requires a fresh read before another mutation", async () => {
  env();
  let patches = 0;
  const state = snapshot();
  const api = { get: async () => state, patch: async () => { patches++; throw new Error("offline"); } } as unknown as ApiLike;
  const screen = createGamingScreen({ api, i18n: { locale: "en" } as I18n, self: { name: "Player", username: "player" }, onBack() {} });
  await settle();
  const toggle = switchIn(screen.root);
  toggle.checked = true;
  toggle.dispatch("change");
  await settle();
  assert.equal(patches, 1);
  assert.equal(switchIn(screen.root).checked, false);
  assert.equal(switchIn(screen.root).disabled, true);
  assert.match(screen.root.textContent ?? "", /Could not confirm/);
  screen.destroy();
});

test("server-confirmed enable persists and detached reads cannot rebuild a destroyed screen", async () => {
  env();
  let state = snapshot();
  const api = { get: async () => state, patch: async (_p: string, body: { enabled: boolean }) => { state = { ...state, settings: { ...state.settings, ...body } }; return state; } } as unknown as ApiLike;
  const deps = { api, i18n: { locale: "en" } as I18n, self: { name: "Player", username: "player" }, onBack() {} };
  const first = createGamingScreen(deps);
  await settle();
  const toggle = switchIn(first.root); toggle.checked = true; toggle.dispatch("change");
  await settle();
  assert.equal(switchIn(first.root).checked, true);
  first.destroy();
  const second = createGamingScreen(deps);
  await settle();
  assert.equal(switchIn(second.root).checked, true);
  second.destroy();
  const pending = deferred<GamingState>();
  const third = createGamingScreen({ ...deps, api: { get: () => pending.promise } as unknown as ApiLike });
  third.destroy();
  pending.resolve(state);
  await settle();
  assert.equal(all(third.root as unknown as StubNode).filter(n => n.className === "gc-gm").length, 0);
});
