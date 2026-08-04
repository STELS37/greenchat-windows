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

test("a late signed URL for an old avatar cannot replace a newer avatar", async () => {
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
  resolvers.get(2)?.({ url: "/new-photo", expires_at: 99 });
  await latest;
  resolvers.get(1)?.({ url: "/old-photo", expires_at: 99 });
  await settle();

  const images = target.querySelectorAll("img.gc-avatar-photo");
  assert.equal(images.length, 1);
  assert.equal(images[0]?.getAttribute("src"), "/new-photo");
  binding.destroy();
});
