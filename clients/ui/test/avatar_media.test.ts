import test from "node:test";
import assert from "node:assert/strict";

import { bindAvatarImage, uploadAvatarFile } from "../src/screens/avatar_media.ts";
import type { UploadedFile } from "../src/screens/media.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();

const uploaded: UploadedFile = {
  file_id: 77,
  name: "avatar.png",
  mime: "image/png",
  size: 4,
  meta: null,
};

test("avatar upload uses the canonical media uploader with original bytes and metadata", async () => {
  let seenBytes: number[] = [];
  let seenOptions: { name: string; mime: string } | null = null;
  const result = await uploadAvatarFile({
    name: "avatar.png",
    type: "image/png",
    size: 4,
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  }, {
    upload: async (data, options) => {
      seenBytes = [...data];
      seenOptions = { name: options.name, mime: options.mime };
      return uploaded;
    },
  });
  assert.deepEqual(seenBytes, [1, 2, 3, 4]);
  assert.deepEqual(seenOptions, { name: "avatar.png", mime: "image/png" });
  assert.equal(result.file_id, 77);
});

test("avatar upload rejects non-images, SVG and files above 25 MB before network I/O", async () => {
  let calls = 0;
  const media = { upload: async () => { calls += 1; return uploaded; } };
  const bad = (type: string, size = 4) => ({
    name: "bad",
    type,
    size,
    arrayBuffer: async () => new ArrayBuffer(size),
  });
  await assert.rejects(() => uploadAvatarFile(bad("text/plain"), media), /AVATAR_IMAGE_REQUIRED/);
  await assert.rejects(() => uploadAvatarFile(bad("image/svg+xml"), media), /AVATAR_IMAGE_REQUIRED/);
  await assert.rejects(() => uploadAvatarFile(bad("image/png", 25 * 1024 * 1024 + 1), media), /AVATAR_TOO_LARGE/);
  assert.equal(calls, 0);
});

test("native avatar URL is resolved through the API origin and revealed only after load", async () => {
  installDomStub();
  const target = document.createElement("div") as unknown as StubNode;
  target.append("AE");
  const api = {
    get: async <T>() => ({ url: "/f/7?e=99&u=2&s=sig", expires_at: 99 }) as T,
    resolveUrl: (path: string) => `https://api.greenchat.example${path}`,
  };
  const binding = bindAvatarImage(target as unknown as HTMLElement, api, null, "Aero");
  const pending = binding.set(7);
  await settle();

  const candidate = target.querySelector("img.gc-avatar-photo");
  assert.ok(candidate, "a hidden image request is mounted");
  assert.equal(candidate.getAttribute("src"), "https://api.greenchat.example/f/7?e=99&u=2&s=sig");
  assert.equal(candidate.hidden, true, "broken/partial bytes cannot cover the initials");
  assert.equal(target.hasClass("has-image"), false);
  assert.equal(target.textContent, "AE");

  candidate.dispatch("load");
  await pending;
  assert.equal(candidate.hidden, false);
  assert.equal(target.hasClass("has-image"), true);
  binding.destroy();
});

test("cross-origin native avatar is fetched into a CSP-safe blob URL and revoked", async () => {
  installDomStub();
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousFetch = globalThis.fetch;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("http://tauri.localhost/"),
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    }) as typeof fetch;
    URL.createObjectURL = () => "blob:http://tauri.localhost/avatar-7";
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };

    const target = document.createElement("div") as unknown as StubNode;
    target.append("AE");
    const api = {
      get: async <T>() => ({ url: "/f/7?e=99&u=2&s=sig", expires_at: 99 }) as T,
      resolveUrl: (path: string) => `https://api.greenchat.example${path}`,
    };
    const binding = bindAvatarImage(target as unknown as HTMLElement, api, null, "Aero");
    const pending = binding.set(7);
    await settle();
    await settle();

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request?.url, "https://api.greenchat.example/f/7?e=99&u=2&s=sig");
    assert.equal(request?.init?.credentials, "omit");
    assert.equal(request?.init?.cache, "force-cache");
    const candidate = target.querySelector("img.gc-avatar-photo");
    assert.ok(candidate);
    assert.equal(candidate.getAttribute("src"), "blob:http://tauri.localhost/avatar-7");
    assert.equal(candidate.hidden, true);

    candidate.dispatch("load");
    await pending;
    assert.equal(candidate.hidden, false);
    assert.equal(target.hasClass("has-image"), true);
    binding.destroy();
    assert.deepEqual(revoked, ["blob:http://tauri.localhost/avatar-7"]);
  } finally {
    globalThis.fetch = previousFetch;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as { location?: Location }).location;
  }
});

test("failed avatar blob retries once and never leaves a blank image over initials", async () => {
  installDomStub();
  const target = document.createElement("div") as unknown as StubNode;
  target.append("AE");
  let signedCalls = 0;
  const api = {
    get: async <T>() => {
      signedCalls += 1;
      return { url: "/f/7?e=99&u=2&s=sig", expires_at: 99 } as T;
    },
    resolveUrl: (path: string) => `https://api.greenchat.example${path}`,
  };
  const binding = bindAvatarImage(target as unknown as HTMLElement, api, null, "Aero");
  const pending = binding.set(7);
  await settle();
  target.querySelector("img.gc-avatar-photo")?.dispatch("error");
  await settle();

  const retry = target.querySelector("img.gc-avatar-photo");
  assert.ok(retry, "a fresh signed URL is tried after a blob error");
  assert.match(retry.getAttribute("src") ?? "", /gc_avatar_retry=1$/);
  retry.dispatch("error");
  await pending;

  assert.equal(signedCalls, 2);
  assert.equal(target.querySelectorAll("img.gc-avatar-photo").length, 0);
  assert.equal(target.hasClass("has-image"), false);
  assert.equal(target.textContent, "AE", "initials remain the permanent no-network fallback");
  binding.destroy();
});

test("a late signed URL for an old avatar cannot replace a newer loaded avatar", async () => {
  installDomStub();
  const target = document.createElement("div") as unknown as StubNode;
  target.append("GC");
  const resolvers = new Map<number, (value: { url: string; expires_at: number }) => void>();
  const api = {
    get: <T>(path: string): Promise<T> => {
      const id = Number(path.split("/").at(-2));
      return new Promise<T>((resolve) => {
        resolvers.set(id, resolve as (value: { url: string; expires_at: number }) => void);
      });
    },
  };
  const binding = bindAvatarImage(target as unknown as HTMLElement, api, 1, "Green Chat");
  const latest = binding.set(2);
  for (let i = 0; i < 6 && !resolvers.has(2); i += 1) await settle();
  assert.ok(resolvers.has(2), "the latest revision reaches the API after the lazy binding loads");
  resolvers.get(2)?.({ url: "/new-photo", expires_at: 99 });
  await settle();
  const candidate = target.querySelector("img.gc-avatar-photo");
  assert.ok(candidate);
  candidate.dispatch("load");
  await latest;

  resolvers.get(1)?.({ url: "/old-photo", expires_at: 99 });
  await settle();
  const images = target.querySelectorAll("img.gc-avatar-photo");
  assert.equal(images.length, 1);
  assert.equal(images[0]?.getAttribute("src"), "/new-photo");
  binding.destroy();
});
