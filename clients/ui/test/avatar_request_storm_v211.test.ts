import test from "node:test";
import assert from "node:assert/strict";

import {
  createAvatarImageBinding,
  resetAvatarBindingCacheForTests,
} from "../src/screens/avatar_binding.ts";
import { resetNativeAvatarCacheForTests } from "../src/screens/avatar_native.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();

test("V211 repeated same-origin avatar bindings coalesce signed URL and blob requests", async () => {
  installDomStub();
  resetAvatarBindingCacheForTests();
  resetNativeAvatarCacheForTests();
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  let signedCalls = 0;
  let blobCalls = 0;
  let objectUrls = 0;

  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.greenchat.example/chats"),
    });
    globalThis.fetch = (async () => {
      blobCalls += 1;
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    }) as typeof fetch;
    URL.createObjectURL = () => `blob:https://app.greenchat.example/avatar-${++objectUrls}`;
    URL.revokeObjectURL = () => {};

    const api = {
      get: async <T>() => {
        signedCalls += 1;
        return {
          url: "/f/700?e=4102444800&u=73&s=signature",
          expires_at: 4_102_444_800,
        } as T;
      },
      resolveUrl: (path: string) => new URL(path, "https://app.greenchat.example/").toString(),
    };

    const targets: StubNode[] = [];
    const bindings = Array.from({ length: 40 }, () => {
      const target = document.createElement("div") as unknown as StubNode;
      target.append("GC");
      targets.push(target);
      return createAvatarImageBinding(target as unknown as HTMLElement, api, "Green Chat");
    });
    const loads = bindings.map((binding) => binding.set(700));

    for (let pass = 0; pass < 20 && targets.some((target) => !target.querySelector("img.gc-avatar-photo")); pass += 1) {
      await settle();
    }
    assert.equal(signedCalls, 1, "all rows share one signed-URL lookup");
    assert.equal(blobCalls, 1, "all rows share one downloaded/validated avatar blob");
    for (const target of targets) {
      const candidate = target.querySelector("img.gc-avatar-photo");
      assert.ok(candidate, "each row receives an object-URL image candidate");
      candidate.dispatch("load");
    }
    await Promise.all(loads);
    assert.ok(targets.every((target) => target.hasClass("has-image")));
    for (const binding of bindings) binding.destroy();
  } finally {
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as { location?: Location }).location;
    resetAvatarBindingCacheForTests();
    resetNativeAvatarCacheForTests();
  }
});

test("V211 a shared 429 refreshes once instead of multiplying retries per avatar row", async () => {
  installDomStub();
  resetAvatarBindingCacheForTests();
  resetNativeAvatarCacheForTests();
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  let signedCalls = 0;
  let blobCalls = 0;

  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.greenchat.example/chats"),
    });
    globalThis.fetch = (async () => {
      blobCalls += 1;
      if (blobCalls === 1) return new Response("rate limited", { status: 429 });
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    }) as typeof fetch;
    let objectUrls = 0;
    URL.createObjectURL = () => `blob:https://app.greenchat.example/retry-${++objectUrls}`;
    URL.revokeObjectURL = () => {};

    const api = {
      get: async <T>() => {
        signedCalls += 1;
        return {
          // The server may mint the exact same signature inside one second. Generation, not URL text,
          // is therefore the only reliable way to recognize that another row already refreshed it.
          url: "/f/701?e=4102444800&u=73&s=same-signature",
          expires_at: 4_102_444_800,
        } as T;
      },
      resolveUrl: (path: string) => new URL(path, "https://app.greenchat.example/").toString(),
    };
    const targets: StubNode[] = [];
    const bindings = Array.from({ length: 40 }, () => {
      const target = document.createElement("div") as unknown as StubNode;
      target.append("GC");
      targets.push(target);
      return createAvatarImageBinding(target as unknown as HTMLElement, api, "Green Chat");
    });
    const loads = bindings.map((binding) => binding.set(701));

    for (let pass = 0; pass < 30 && targets.some((target) => !target.querySelector("img.gc-avatar-photo")); pass += 1) {
      await settle();
    }
    assert.equal(signedCalls, 2, "one initial signature plus one coalesced refresh");
    assert.equal(blobCalls, 2, "one rejected blob plus one coalesced retry");
    for (const target of targets) {
      const candidate = target.querySelector("img.gc-avatar-photo");
      assert.ok(candidate);
      candidate.dispatch("load");
    }
    await Promise.all(loads);
    for (const binding of bindings) binding.destroy();
  } finally {
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as { location?: Location }).location;
    resetAvatarBindingCacheForTests();
    resetNativeAvatarCacheForTests();
  }
});
