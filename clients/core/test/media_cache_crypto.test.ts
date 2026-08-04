// T-521 (DS-03) — интеграция media_crypto в MediaCache: passthrough без сессии байт-в-байт,
// шифрование под K_files при открытой сессии, honest re-download при порче, RAM-only при LOCKED,
// LRU-семантика без регресса. Всё на MemoryStore + фейковый fetch — без живого сервера.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.ts";
import { MediaCache, type MediaKeyProvider } from "../src/media_cache.ts";
import { MEDIA_CRYPTO_CONSTANTS } from "../src/media_crypto.ts";

function emptyTokens(): { access: string | null; refresh: string | null; accessExpiresAt: number | null } {
  return { access: null, refresh: null, accessExpiresAt: null };
}

// Фейковая сессия: K_files = детерминированные 32 байта. Контракт MediaKeyProvider структурный —
// боевая CryptoSession подходит под него без адаптера (isUnlocked + domainKey("files")).
function fakeSession(unlocked = true, seed = 9): MediaKeyProvider & { lock(): void; unlock(): void } {
  let open = unlocked;
  const k = new Uint8Array(MEDIA_CRYPTO_CONSTANTS.FILE_KEY_BYTES);
  for (let i = 0; i < k.length; i++) k[i] = (i * 13 + seed) & 0xff;
  return {
    get isUnlocked() {
      return open;
    },
    async domainKey(domain: "files"): Promise<Uint8Array> {
      if (!open) throw new Error("locked");
      assert.equal(domain, "files");
      return k.slice();
    },
    lock() {
      open = false;
    },
    unlock() {
      open = true;
    },
  };
}

// Сервер из одного файла: GET /v1/files/:id отдаёт заданные байты; считает обращения.
function fakeServer(blobs: Map<number, { bytes: Uint8Array; mime: string }>): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let n = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    n++;
    const m = String(input).match(/\/v1\/files\/(\d+)$/);
    const found = m ? blobs.get(Number(m[1])) : undefined;
    if (!found) return new Response("{}", { status: 404 });
    // Копия: Response не должен делить буфер с эталоном теста.
    return new Response(found.bytes.slice(), {
      status: 200,
      headers: { "content-type": found.mime },
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => n };
}

function canary(n = 4096): Uint8Array {
  // Заметная плейнтекст-канарейка: повторяющаяся ASCII-строка — легко искать подпоследовательностью.
  const marker = new TextEncoder().encode("FORENSIC_CANARY_9f31c2d4");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = marker[i % marker.length]!;
  return out;
}

function containsSub(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// Все Uint8Array из значений коллекции media нижнего store.
async function rawMediaBuffers(store: MemoryStore): Promise<Uint8Array[]> {
  const all = await store.scan<Record<string, unknown>>("media");
  const bufs: Uint8Array[] = [];
  for (const rec of all) {
    for (const v of Object.values(rec)) if (v instanceof Uint8Array) bufs.push(v);
  }
  return bufs;
}

function cache(opts: {
  store: MemoryStore;
  session?: MediaKeyProvider;

  allowPassthrough?: boolean | (() => boolean);
  fetchImpl?: typeof fetch;
  limitBytes?: number;
  now?: () => number;
}): MediaCache {
  return new MediaCache({
    baseUrl: "http://files.test",
    tokens: emptyTokens(),
    clientId: "node/0.1.0",
    ...opts,
  });
}

test("MediaCache без сессии: passthrough байт-в-байт, форма записи как до T-521", async () => {
  const store = new MemoryStore();
  const data = canary(1000);
  const mc = cache({ store, now: () => 5000 });
  await mc.put(77, data, "image/png");

  const raw = await store.get<Record<string, unknown>>("media", 77);
  assert.ok(raw);
  assert.deepEqual(raw.bytes, data, "на диске ровно исходные байты");
  assert.equal(raw.mime, "image/png");
  assert.equal(raw.size, 1000);
  assert.equal(raw.at, 5000);
  assert.ok(!("enc" in raw), "passthrough-запись не несёт enc-маркера (форма до T-521)");

  const blob = await mc.get(77);
  assert.deepEqual(blob.bytes, data);
  assert.equal(blob.mime, "image/png");
});

test("MediaCache: динамический passthrough сохраняет прежний кэш до включения замка и закрывается после", async () => {
  const store = new MemoryStore();
  const session = fakeSession(false);
  let passthrough = true;
  const mc = cache({ store, session, allowPassthrough: () => passthrough });
  const data = canary(333);

  await mc.put(41, data, "image/png");
  const plain = await store.get<Record<string, unknown>>("media", 41);
  assert.ok(plain && !("enc" in plain));
  assert.deepEqual(plain.bytes, data);

  passthrough = false;
  await mc.put(42, data, "image/png");
  assert.equal(await store.get("media", 42), undefined, "после включения замка LOCKED не пишет plaintext");

  session.unlock();
  await mc.put(43, data, "image/png");
  const sealed = await store.get<Record<string, unknown>>("media", 43);
  assert.equal(sealed?.enc, 1);
});

test("MediaCache с открытой сессией: put шифрует до диска — канарейки в store нет, mime скрыт", async () => {
  const store = new MemoryStore();
  const session = fakeSession();
  const mc = cache({ store, session });
  const data = canary();
  await mc.put(1, data, "image/jpeg");

  const marker = new TextEncoder().encode("FORENSIC_CANARY_9f31c2d4");
  for (const buf of await rawMediaBuffers(store)) {
    assert.ok(!containsSub(buf, marker), "плейнтекст-канарейка не должна попадать в store");
  }
  const raw = await store.get<Record<string, unknown>>("media", 1);
  assert.ok(raw);
  assert.equal(raw.enc, 1);
  assert.equal(raw.mime, "application/octet-stream", "реальный mime не светится в метаданных");
  assert.equal(
    raw.size,
    (raw.bytes as Uint8Array).byteLength,
    "size = длина шифроконтейнера (длина — допустимые метаданные)",
  );

  // get расшифровывает в памяти и возвращает исходные байты и реальный mime.
  const blob = await mc.get(1);
  assert.deepEqual(blob.bytes, data);
  assert.equal(blob.mime, "image/jpeg");
  assert.equal(blob.size, data.byteLength);
});

test("MediaCache с сессией: download шифрует перед записью, повторный get — из кэша без сети", async () => {
  const store = new MemoryStore();
  const session = fakeSession();
  const data = canary(2048);
  const srv = fakeServer(new Map([[5, { bytes: data, mime: "audio/ogg" }]]));
  const mc = cache({ store, session, fetchImpl: srv.fetchImpl });

  const b1 = await mc.get(5);
  assert.deepEqual(b1.bytes, data);
  assert.equal(b1.mime, "audio/ogg");
  assert.equal(srv.calls(), 1);

  const marker = new TextEncoder().encode("FORENSIC_CANARY_9f31c2d4");
  for (const buf of await rawMediaBuffers(store)) {
    assert.ok(!containsSub(buf, marker), "скачанный блоб лёг на диск только шифроблобом");
  }

  const b2 = await mc.get(5);
  assert.deepEqual(b2.bytes, data);
  assert.equal(srv.calls(), 1, "второй get — чистый кэш-хит");
});

test("MediaCache: повреждённый шифроблоб → честный re-download (как повреждённый кэш)", async () => {
  const store = new MemoryStore();
  const session = fakeSession();
  const data = canary(512);
  const srv = fakeServer(new Map([[8, { bytes: data, mime: "image/webp" }]]));
  const mc = cache({ store, session, fetchImpl: srv.fetchImpl });
  await mc.put(8, data, "image/webp");
  assert.equal(srv.calls(), 0);

  // Портим байт тела контейнера прямо в store (симуляция порчи диска/подмены).
  const raw = await store.get<{ bytes: Uint8Array } & Record<string, unknown>>("media", 8);
  assert.ok(raw);
  const bad = raw.bytes.slice();
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
  await store.put("media", 8, { ...raw, bytes: bad });

  const blob = await mc.get(8);
  assert.deepEqual(blob.bytes, data, "после порчи блоб честно перекачан");
  assert.equal(srv.calls(), 1, "порча тега = кэш-мисс → ровно один download");
  // Перекачанный блоб снова лёг шифроблобом и читается из кэша.
  const again = await mc.get(8);
  assert.deepEqual(again.bytes, data);
  assert.equal(srv.calls(), 1);
});

test("MediaCache: сессия есть, но LOCKED → ни байта на диск, блоб отдаётся RAM-only из сети", async () => {
  const store = new MemoryStore();
  const session = fakeSession(false);
  const data = canary(256);
  const srv = fakeServer(new Map([[3, { bytes: data, mime: "image/png" }]]));
  const mc = cache({ store, session, fetchImpl: srv.fetchImpl });

  await mc.put(3, data, "image/png");
  assert.equal(await store.get("media", 3), undefined, "put при LOCKED не пишет на диск");

  const blob = await mc.get(3);
  assert.deepEqual(blob.bytes, data, "блоб отдан из сети");
  assert.equal(srv.calls(), 1);
  assert.equal(await store.get("media", 3), undefined, "download при LOCKED не пишет на диск");
  assert.equal((await store.scan("media")).length, 0, "0 записей в коллекции media");
});

test("MediaCache: сохранённый до сессии плейнтекст-блоб мигрирует в шифроблоб при первом get", async () => {
  const store = new MemoryStore();
  const data = canary(300);
  // Эпоха passthrough: без сессии.
  await cache({ store }).put(4, data, "video/mp4");
  const before = await store.get<Record<string, unknown>>("media", 4);
  assert.ok(before && !("enc" in before));

  // Появилась открытая сессия (тот же store).
  const mc = cache({ store, session: fakeSession() });
  const blob = await mc.get(4);
  assert.deepEqual(blob.bytes, data);
  assert.equal(blob.mime, "video/mp4");

  const after = await store.get<Record<string, unknown>>("media", 4);
  assert.ok(after);
  assert.equal(after.enc, 1, "плейнтекст-запись перешифрована на месте");
  const marker = new TextEncoder().encode("FORENSIC_CANARY_9f31c2d4");
  for (const buf of await rawMediaBuffers(store)) {
    assert.ok(!containsSub(buf, marker), "после миграции плейнтекста в store не осталось");
  }
  // И читается обратно.
  assert.deepEqual((await mc.get(4)).bytes, data);
});

test("MediaCache: LRU-вытеснение по бюджету работает по-прежнему (и с шифрослоем)", async () => {
  // Без сессии — прежняя семантика (пин старого поведения).
  {
    const store = new MemoryStore();
    let clock = 1000;
    const mc = cache({ store, limitBytes: 10, now: () => (clock += 1000) });
    await mc.put(1, new Uint8Array(6), "application/octet-stream");
    await mc.put(2, new Uint8Array(6), "application/octet-stream");
    assert.equal(await mc.has(1), false, "LRU-старый вытеснен");
    assert.equal(await mc.has(2), true);
    assert.ok((await mc.size()) <= 10);
  }
  // С сессией — бюджет считается по фактическим байтам на диске (шифроконтейнер).
  {
    const store = new MemoryStore();
    let clock = 1000;
    const mc = cache({ store, session: fakeSession(), limitBytes: 200, now: () => (clock += 1000) });
    await mc.put(1, new Uint8Array(120), "a/b"); // контейнер ~150 байт
    await mc.put(2, new Uint8Array(120), "a/b"); // суммарно > 200 → вытеснить №1
    assert.equal(await mc.has(1), false, "LRU-старый вытеснен и под шифрослоем");
    assert.equal(await mc.has(2), true);
    assert.ok((await mc.size()) <= 200, "бюджет держится по байтам контейнеров");
  }
});

test("MediaCache: get при открытой сессии обновляет LRU-метку шифрозаписи (touch)", async () => {
  const store = new MemoryStore();
  let clock = 1000;
  const mc = cache({ store, session: fakeSession(), limitBytes: 10_000, now: () => (clock += 1000) });
  await mc.put(6, new Uint8Array(10), "x/y"); // at=2000
  await mc.get(6); // touch → at=3000
  const raw = await store.get<Record<string, unknown>>("media", 6);
  assert.ok(raw);
  assert.equal(raw.at, 3000, "last-access обновлён без перешифровки");
});

// ── T-201: «секретные чаты НЕ кэшируются на диск вовсе» — регресс-пин по исходникам ────────────
// На 2026-07-14 у клиента НЕТ кода секретных чатов (T-201 — серверная реализация: /v1/secret,
// secret_chats/secret_messages): grep по clients/{core,ui,web}/src не находит ни /v1/secret, ни
// e2e-kind. «Не кэшируются» выполняется архитектурно: единственный писатель коллекции "media" —
// MediaCache. Этот тест закрепляет оба факта: появление клиентского секретного кода или второго
// писателя "media" закрасит его и заставит явно спроектировать «secret → 0 записей на диск».
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("T-201 пин: в клиентском src нет секретных чатов, писатель \"media\" — только MediaCache", () => {
  const clientsRoot = resolve(import.meta.dirname, "../..");
  const srcRoots = ["core/src", "ui/src", "web/src"].map((d) => resolve(clientsRoot, d));
  const mediaWriters: string[] = [];
  const secretRefs: string[] = [];
  for (const root of srcRoots) {
    for (const file of tsFilesUnder(root)) {
      const text = readFileSync(file, "utf8");
      if (text.includes('put("media"') || text.includes("put('media'")) mediaWriters.push(file);
      if (/\/v1\/secret|\bsecret_chat\b|secretChat|['"]e2e['"]/.test(text)) secretRefs.push(file);
    }
  }
  assert.deepEqual(
    mediaWriters.map((f) => f.split("/").slice(-2).join("/")),
    ["src/media_cache.ts"],
    "в коллекцию media пишет только MediaCache",
  );
  assert.deepEqual(
    secretRefs,
    [],
    "клиентский код секретных чатов появился — спроектируйте обход дискового кэша (T-201: не кэшировать) и обновите пин",
  );
});


test("T-529 cloud-only media bypasses an existing disk row and performs zero disk writes", async () => {
  const store = new MemoryStore();
  const session = fakeSession();
  const stale = canary(64);
  const fresh = new Uint8Array([7, 8, 9, 10]);
  const srv = fakeServer(new Map([[91, { bytes: fresh, mime: "image/png" }]]));
  const mc = cache({ store, session, fetchImpl: srv.fetchImpl });

  await mc.put(91, stale, "image/jpeg");
  const before = await store.get<Record<string, unknown>>("media", 91);
  assert.ok(before, "fixture starts with a durable encrypted row");

  const first = await mc.get(91, { persist: false });
  assert.deepEqual(first.bytes, fresh, "cloud-only does not read the stale disk row");
  assert.equal(first.mime, "image/png");
  assert.equal(srv.calls(), 1);
  assert.deepEqual(await store.get("media", 91), before, "RAM-only download does not mutate disk");

  const second = await mc.get(91, { persist: false });
  assert.deepEqual(second.bytes, fresh);
  assert.equal(srv.calls(), 2, "no disk cache hit exists for a later cloud-only request");
  assert.deepEqual(await store.get("media", 91), before);
});

test("T-529 cloud-only media put is a strict no-op for the durable collection", async () => {
  const store = new MemoryStore();
  const mc = cache({ store, session: fakeSession() });
  await mc.put(92, canary(128), "image/png", { persist: false });
  assert.equal(await store.get("media", 92), undefined);
  assert.equal(await mc.has(92), false);
});
