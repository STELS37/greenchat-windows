// T-417 — the zero-dependency ZIP reader. We build real archives in-process with node:zlib
// (deflate-raw) and assert both compression methods round-trip: "stored" (0) verbatim and
// "deflate" (8) via DecompressionStream. CRC fields are left 0 — the reader does not verify them,
// mirroring how it tolerates the real Telegram archive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ZipArchive } from "../src/zip.ts";

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

interface FileSpec {
  name: string;
  data: Uint8Array;
  method: 0 | 8;
}

// Assemble a valid (classic, no-Zip64) ZIP from the given members.
function buildZip(files: FileSpec[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const raw = Buffer.from(f.data);
    const comp = f.method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(f.method),
      u16(0), u16(0), u32(0), // time, date, crc
      u32(comp.length), u32(raw.length),
      u16(nameBuf.length), u16(0),
      nameBuf,
    ]);
    const localOffset = offset;
    parts.push(local, comp);
    offset += local.length + comp.length;
    central.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(f.method),
        u16(0), u16(0), u32(0), // time, date, crc
        u32(comp.length), u32(raw.length),
        u16(nameBuf.length), u16(0), u16(0), // name, extra, comment
        u16(0), u16(0), u32(0), // disk, internal, external attrs
        u32(localOffset),
        nameBuf,
      ]),
    );
  }
  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(centralOffset),
    u16(0),
  ]);
  return new Uint8Array(Buffer.concat([...parts, centralBuf, eocd]));
}

test("ZipArchive: list, has, find, read (deflate + stored), and missing", async () => {
  const json = JSON.stringify({ name: "Мой чат", messages: [{ type: "message", text: "привет" }] });
  const jsonBytes = new TextEncoder().encode(json);
  const photo = new Uint8Array(2048);
  for (let i = 0; i < photo.length; i++) photo[i] = i & 0xff;

  const zip = buildZip([
    { name: "result.json", data: jsonBytes, method: 8 }, // compressible → deflate
    { name: "photos/photo_1@01.jpg", data: photo, method: 0 }, // stored verbatim
  ]);

  const arc = ZipArchive.open(zip);
  assert.deepEqual(arc.list().sort(), ["photos/photo_1@01.jpg", "result.json"]);
  assert.ok(arc.has("result.json"));
  assert.equal(arc.find((n) => n.endsWith("result.json")), "result.json");

  const readJson = await arc.read("result.json");
  assert.ok(readJson);
  assert.equal(new TextDecoder().decode(readJson!), json);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(readJson!)).name, "Мой чат");

  const readPhoto = await arc.read("photos/photo_1@01.jpg");
  assert.ok(readPhoto);
  assert.deepEqual(readPhoto!, photo);

  assert.equal(await arc.read("does/not/exist"), null);
});

test("ZipArchive.open: rejects non-zip input", () => {
  assert.throws(() => ZipArchive.open(new Uint8Array([1, 2, 3, 4, 5])), /no end-of-central-directory/);
});

test("ZipArchive: locates result.json nested under an export folder", async () => {
  const json = new TextEncoder().encode('{"name":"x","messages":[]}');
  const zip = buildZip([{ name: "ChatExport_2019-06/result.json", data: json, method: 8 }]);
  const arc = ZipArchive.open(zip);
  const found = arc.find((n) => n.endsWith("/result.json") || n === "result.json");
  assert.equal(found, "ChatExport_2019-06/result.json");
  const bytes = await arc.read(found!);
  assert.ok(bytes);
});


test("ZipArchive: a failing deflate stream rejects normally without an unhandled writer promise", () => {
  const zip = buildZip([{ name: "broken.txt", data: new TextEncoder().encode("broken"), method: 8 }]);
  const here = dirname(fileURLToPath(import.meta.url));
  const moduleUrl = pathToFileURL(join(here, "..", "src", "zip.ts")).href;
  const encoded = Buffer.from(zip).toString("base64");
  const script = `
    import { ZipArchive } from ${JSON.stringify(moduleUrl)};
    globalThis.DecompressionStream = class {
      constructor() {
        this.writable = {
          getWriter() {
            return {
              write() { return Promise.reject(new Error("writer rejected")); },
              close() { return Promise.resolve(); },
            };
          },
        };
        this.readable = {
          getReader() {
            return { read() { return Promise.reject(new Error("reader rejected")); } };
          },
        };
      }
    };
    const archive = ZipArchive.open(new Uint8Array(Buffer.from(${JSON.stringify(encoded)}, "base64")));
    let rejected = false;
    try { await archive.read("broken.txt"); } catch { rejected = true; }
    if (!rejected) process.exitCode = 2;
    await new Promise((resolve) => setTimeout(resolve, 20));
    console.log("clean-exit");
  `;
  const child = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "--experimental-strip-types", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, `child must not crash from an unhandled writer rejection:\n${child.stderr}`);
  assert.match(child.stdout, /clean-exit/);
});
