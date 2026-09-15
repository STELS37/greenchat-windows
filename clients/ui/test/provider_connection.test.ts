import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderConnection, providerAuthorizationUrl } from "../src/screens/provider_connection.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { installDomStub, StubNode, settle, deferred } from "./dom_stub.ts";
const all = (n: StubNode): StubNode[] => [n, ...n.children.flatMap(all)];
const button = (root: HTMLElement, text: string) => all(root as unknown as StubNode).find(n => n.tag === "button" && n.textContent === text)!;
function env() { installDomStub(); Object.assign(globalThis, { window: { addEventListener() {}, removeEventListener() {} } }); }
test("provider authentication rejects alternate hosts, paths and missing state", () => {
  assert.match(providerAuthorizationUrl("https://www.epicgames.com/id/authorize?response_type=code&state=one", "epic"), /epicgames/);
  for (const url of ["https://www.tiktok.com/evil?response_type=code&state=a", "https://www.tiktok.com.evil.test/v2/auth/authorize/?response_type=code&state=a",
    "https://www.tiktok.com/v2/auth/authorize/?response_type=code", "https://user@www.tiktok.com/v2/auth/authorize/?response_type=code&state=a"])
    assert.throws(() => providerAuthorizationUrl(url, "tiktok"));
});
test("opening browser never claims connected; server identity controls link and unlink", async () => {
  env(); let account: null | { id: string; name: string } = null; const calls: string[] = []; let opened = "";
  const api = { get: async (path: string) => { calls.push(path); return { available: true, account }; },
    post: async (path: string) => { calls.push(path); return { url: "https://www.epicgames.com/id/authorize?response_type=code&state=one" }; },
    delete: async (path: string) => { calls.push(path); account = null; } } as unknown as ApiLike;
  const screen = createProviderConnection({ provider: "epic", locale: "en", api, openExternal: url => { opened = url; } });
  try {
    await settle(); button(screen.root, "Connect").dispatch("click"); await settle();
    assert.match(opened, /epicgames/); assert.match(screen.root.textContent ?? "", /Finish signing in/);
    assert.doesNotMatch(screen.root.textContent ?? "", /Connected:/);
    account = { id: "verified-id", name: "Verified player" };
    button(screen.root, "Check connection").dispatch("click"); await settle();
    assert.match(screen.root.textContent ?? "", /Connected: Verified player/);
    button(screen.root, "Disconnect").dispatch("click"); await settle();
    assert.ok(calls.includes("/v1/gaming/connect/epic/connection"));
    assert.doesNotMatch(screen.root.textContent ?? "", /Connected:/);
  } finally { screen.destroy(); }
});
test("unconfigured TikTok stays social and cannot start authentication", async () => {
  env(); const paths: string[] = [];
  const api = { get: async (path: string) => { paths.push(path); return { available: false, account: null }; } } as unknown as ApiLike;
  const screen = createProviderConnection({ provider: "tiktok", locale: "en", api });
  try { await settle(); assert.equal(button(screen.root, "Connect").disabled, true);
    assert.deepEqual(paths, ["/v1/social/connect/tiktok/status"]); } finally { screen.destroy(); }
});
test("destroying a view during start prevents late browser navigation", async () => {
  env(); let opened = false; const pending = deferred<{ url: string }>();
  const api = { get: async () => ({ available: true, account: null }), post: () => pending.promise } as unknown as ApiLike;
  const screen = createProviderConnection({ provider: "tiktok", locale: "en", api, openExternal() { opened = true; } });
  await settle(); button(screen.root, "Connect").dispatch("click"); screen.destroy();
  pending.resolve({ url: "https://www.tiktok.com/v2/auth/authorize/?response_type=code&state=one" });
  await settle(); assert.equal(opened, false);
});
