import test from "node:test";
import assert from "node:assert/strict";

import { acquireNativeAvatar, resetNativeAvatarCacheForTests } from "../src/screens/avatar_native.ts";

const png = (): Response => new Response(Uint8Array.from([137, 80, 78, 71]), {
  status: 200,
  headers: { "content-type": "image/png", "content-length": "4" },
});

test("native avatar transport deduplicates downloads, reuses decoded bytes and revokes each object URL", async () => {
  resetNativeAvatarCacheForTests();
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  let fetches = 0;
  let serial = 0;
  const revoked: string[] = [];
  try {
    globalThis.fetch = (async () => { fetches += 1; return png(); }) as typeof fetch;
    URL.createObjectURL = () => `blob:native/avatar-${++serial}`;
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };
    const signal = new AbortController().signal;

    const [a, b] = await Promise.all([
      acquireNativeAvatar(7, "https://api.example/f/7?one", signal),
      acquireNativeAvatar(7, "https://api.example/f/7?two", signal),
    ]);
    const c = await acquireNativeAvatar(7, "https://api.example/f/7?three", signal);

    assert.equal(fetches, 1, "one immutable file id is downloaded once per app session");
    assert.notEqual(a.src, b.src);
    assert.notEqual(b.src, c.src);
    a.release(); b.release(); c.release();
    assert.deepEqual(revoked, [a.src, b.src, c.src]);
  } finally {
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    resetNativeAvatarCacheForTests();
  }
});


test("native avatar cache is namespaced by media origin and path, not only by numeric file id", async () => {
  resetNativeAvatarCacheForTests();
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const requested: string[] = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return png();
    }) as typeof fetch;
    URL.createObjectURL = () => `blob:native/${requested.length}`;
    URL.revokeObjectURL = () => {};
    const signal = new AbortController().signal;

    const first = await acquireNativeAvatar(7, "https://one.example/f/7?old", signal);
    first.release();
    const sameServer = await acquireNativeAvatar(7, "https://one.example/f/7?fresh", signal);
    sameServer.release();
    const otherServer = await acquireNativeAvatar(7, "https://two.example/f/7?fresh", signal);
    otherServer.release();

    assert.deepEqual(requested, [
      "https://one.example/f/7?old",
      "https://two.example/f/7?fresh",
    ], "signed query rotation shares bytes on one server, while another server never inherits that avatar");
  } finally {
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    resetNativeAvatarCacheForTests();
  }
});

test("a decode failure can invalidate the cached blob so a fresh signed URL is downloaded", async () => {
  resetNativeAvatarCacheForTests();
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  let fetches = 0;
  try {
    globalThis.fetch = (async () => { fetches += 1; return png(); }) as typeof fetch;
    URL.createObjectURL = () => `blob:native/${fetches}`;
    URL.revokeObjectURL = () => {};
    const signal = new AbortController().signal;
    const first = await acquireNativeAvatar(9, "https://api.example/f/9?old", signal);
    first.invalidate();
    first.release();
    const second = await acquireNativeAvatar(9, "https://api.example/f/9?fresh", signal);
    second.release();
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    resetNativeAvatarCacheForTests();
  }
});

test("native avatar transport rejects non-image responses before caching", async () => {
  resetNativeAvatarCacheForTests();
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  try {
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("not an image", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const signal = new AbortController().signal;
    await assert.rejects(() => acquireNativeAvatar(11, "https://api.example/f/11?bad", signal), /AVATAR_IMAGE_REQUIRED/);
    await assert.rejects(() => acquireNativeAvatar(11, "https://api.example/f/11?bad2", signal), /AVATAR_IMAGE_REQUIRED/);
    assert.equal(fetches, 2, "a rejected response never poisons the cache");
  } finally {
    globalThis.fetch = previousFetch;
    resetNativeAvatarCacheForTests();
  }
});
