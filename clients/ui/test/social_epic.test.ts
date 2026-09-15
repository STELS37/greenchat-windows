import { test } from "node:test";
import assert from "node:assert/strict";
import { tiktokPost } from "../src/screens/tiktok_model.ts";
import { createSocialScreen } from "../src/screens/social_screen.ts";
import { createEpicLibrary } from "../src/screens/epic_library.ts";
import { installDomStub, StubNode, settle, deferred } from "./dom_stub.ts";
const all = (n: StubNode): StubNode[] => [n, ...n.children.flatMap(all)];
const nodes = (root: HTMLElement) => all(root as unknown as StubNode);
function env() {
  installDomStub();
  const listeners = new Map<string, (e: unknown) => void>();
  Object.assign(globalThis, { window: { addEventListener(k: string, fn: (e: unknown) => void) { listeners.set(k, fn); },
    removeEventListener(k: string) { listeners.delete(k); } } });
  return listeners;
}
test("TikTok accepts canonical video/photo links and strips tracking, never arbitrary frames", () => {
  assert.equal(tiktokPost("https://www.tiktok.com/@someone/video/6718335390845095173?token=private").url,
    "https://www.tiktok.com/@someone/video/6718335390845095173");
  assert.match(tiktokPost("https://tiktok.com/@a/photo/6718335390845095173").playerUrl, /^https:\/\/www\.tiktok\.com\/player\/v1\/6718335390845095173\?/);
  for (const url of ["javascript:alert(1)", "https://www.tiktok.com.evil.com/@a/video/6718335390845095173", "https://user@www.tiktok.com/@a/video/6718335390845095173",
    "https://www.tiktok.com:444/@a/video/6718335390845095173", "https://vm.tiktok.com/abc", "https://www.tiktok.com/@a/video/nope"])
    assert.throws(() => tiktokPost(url));
});
test("social feed loads no third party before submit, replaces playback and tears it down", () => {
  const listeners = env();
  const screen = createSocialScreen({ locale: "en", onBack() {} });
  assert.equal(nodes(screen.root).filter(n => n.tag === "iframe").length, 0);
  const input = nodes(screen.root).find(n => n.tag === "input")!;
  const form = nodes(screen.root).find(n => n.tag === "form")!;
  input.value = "https://www.tiktok.com/@a/video/6718335390845095173";
  form.dispatch("submit", { preventDefault() {} });
  assert.equal(nodes(screen.root).filter(n => n.tag === "iframe").length, 1);
  input.value = "https://www.tiktok.com/@b/video/6718335390845095174";
  form.dispatch("submit", { preventDefault() {} });
  assert.equal(nodes(screen.root).filter(n => n.tag === "iframe").length, 1);
  assert.doesNotMatch(screen.root.textContent ?? "", /Steam|FACEIT|Epic/);
  screen.destroy();
  assert.equal(listeners.has("message"), false);
  assert.equal(nodes(screen.root).filter(n => n.tag === "iframe").length, 0);
});
test("Epic inventory is read on request, launch failures never claim success", async () => {
  env(); let reads = 0; let launched = "";
  const screen = createEpicLibrary("en", { list: async () => { reads++; return [{ id: "Fortnite", name: "Fortnite" }]; },
    launch: async id => { launched = id; throw new Error("launcher missing"); } });
  assert.equal(reads, 0);
  nodes(screen.root).find(n => n.textContent === "Find installed games")!.dispatch("click");
  await settle(); assert.equal(reads, 1);
  nodes(screen.root).find(n => n.textContent === "Play")!.dispatch("click");
  await settle(); assert.equal(launched, "Fortnite");
  assert.match(screen.root.textContent ?? "", /Could not open/);
  screen.destroy();
});
test("late Epic inventory cannot rebuild a destroyed view", async () => {
  env(); const pending = deferred<Array<{ id: string; name: string }>>();
  const screen = createEpicLibrary("en", { list: () => pending.promise, launch: async () => {} });
  nodes(screen.root).find(n => n.textContent === "Find installed games")!.dispatch("click");
  screen.destroy(); pending.resolve([{ id: "Fortnite", name: "Fortnite" }]); await settle();
  assert.doesNotMatch(screen.root.textContent ?? "", /Fortnite/);
});
