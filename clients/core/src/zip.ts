// clients/core — a minimal, zero-dependency ZIP reader (T-417).
//
// The Telegram export can be handed to us either as a chosen folder (File System Access / an
// <input webkitdirectory>) or as the single .zip Telegram produces. Folder selection needs no
// decompression; this module covers the .zip case. It reads the End-Of-Central-Directory record,
// walks the central directory, and inflates entries on demand — "stored" (method 0) verbatim and
// "deflate" (method 8) through the platform's DecompressionStream("deflate-raw"), which exists in
// both the browser and Node ≥ 22. Zip64 sizes/offsets are handled so large exports (big videos push
// a member past 4 GiB / the archive past the classic offsets) still read.
//
// Only reading is implemented, and only the two compression methods real exports use. Anything else
// (encryption, other methods) throws a clear error rather than returning corrupt bytes.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function u16(v: DataView, o: number): number {
  return v.getUint16(o, true);
}
function u32(v: DataView, o: number): number {
  return v.getUint32(o, true);
}
// 64-bit little-endian read via two u32 halves (values here are far below 2^53, so a JS number is safe).
function u64(v: DataView, o: number): number {
  return u32(v, o) + u32(v, o + 4) * 0x1_0000_0000;
}

// `Uint8Array<ArrayBuffer>` (not the default `ArrayBufferLike`) because the platform stream + DataView
// APIs reject a possibly-SharedArrayBuffer-backed view under TS's typed-array generics.
type Bytes = Uint8Array<ArrayBuffer>;

async function inflateRaw(data: Bytes): Promise<Bytes> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  // Observe the writable side immediately. A corrupt stream may reject both writer.write()/close() and
  // reader.read(); leaving the writer promise fire-and-forget produces a separate unhandled rejection.
  const writeResult = (async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    try {
      await writer.write(data);
      await writer.close();
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  })();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = ds.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const written = await writeResult;
    if (!written.ok) throw written.error;
  } catch (readError) {
    const written = await writeResult;
    throw written.ok ? readError : written.error;
  }

  const out = new Uint8Array(total) as Bytes;
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// Scan backwards for the End-Of-Central-Directory signature (it sits before an optional ≤ 64 KiB
// comment, so a bounded tail scan finds it).
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - (0xffff + 22));
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (u32(view, i) === SIG_EOCD) return i;
  }
  throw new Error("not a zip file (no end-of-central-directory record)");
}

// Resolve the central directory's location + entry count, transparently upgrading to the Zip64 records
// when the classic EOCD stores the 0xFFFF / 0xFFFFFFFF sentinels.
function locateCentralDirectory(view: DataView): { offset: number; count: number } {
  const eocd = findEocd(view);
  let count = u16(view, eocd + 10);
  let offset = u32(view, eocd + 16);
  if (count !== U16_MAX && offset !== U32_MAX) return { offset, count };

  // Zip64: the EOCD64 locator sits 20 bytes before the EOCD and points at the EOCD64 record.
  const locator = eocd - 20;
  if (locator >= 0 && u32(view, locator) === SIG_EOCD64_LOCATOR) {
    const eocd64 = u64(view, locator + 8);
    if (eocd64 + 56 <= view.byteLength && u32(view, eocd64) === SIG_EOCD64) {
      count = u64(view, eocd64 + 32);
      offset = u64(view, eocd64 + 48);
    }
  }
  return { offset, count };
}

// Pull the effective size/offset for an entry, reading the Zip64 extra field (id 0x0001) when the
// central-directory 32-bit fields are sentinels.
function readZip64Extra(
  view: DataView,
  extraStart: number,
  extraLen: number,
  base: { compressedSize: number; uncompressedSize: number; localHeaderOffset: number },
): { compressedSize: number; uncompressedSize: number; localHeaderOffset: number } {
  let { compressedSize, uncompressedSize, localHeaderOffset } = base;
  let p = extraStart;
  const end = extraStart + extraLen;
  while (p + 4 <= end) {
    const id = u16(view, p);
    const size = u16(view, p + 2);
    let f = p + 4;
    if (id === 0x0001) {
      if (uncompressedSize === U32_MAX) { uncompressedSize = u64(view, f); f += 8; }
      if (compressedSize === U32_MAX) { compressedSize = u64(view, f); f += 8; }
      if (localHeaderOffset === U32_MAX) { localHeaderOffset = u64(view, f); f += 8; }
    }
    p += 4 + size;
  }
  return { compressedSize, uncompressedSize, localHeaderOffset };
}

function parseCentralDirectory(view: DataView, start: number, count: number): CentralEntry[] {
  const decoder = new TextDecoder("utf-8");
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const entries: CentralEntry[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (u32(view, p) !== SIG_CENTRAL) break;
    const method = u16(view, p + 10);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const sizes = readZip64Extra(view, p + 46 + nameLen, extraLen, {
      compressedSize: u32(view, p + 20),
      uncompressedSize: u32(view, p + 24),
      localHeaderOffset: u32(view, p + 42),
    });
    entries.push({ name, method, ...sizes });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export class ZipArchive {
  private readonly view: DataView;
  private readonly bytes: Bytes;
  private readonly entries: Map<string, CentralEntry>;

  private constructor(bytes: Bytes, entries: CentralEntry[]) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.entries = new Map(entries.map((e) => [e.name, e]));
  }

  static open(input: ArrayBuffer | Uint8Array): ZipArchive {
    const bytes = (input instanceof Uint8Array ? input : new Uint8Array(input)) as Bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { offset, count } = locateCentralDirectory(view);
    return new ZipArchive(bytes, parseCentralDirectory(view, offset, count));
  }

  // Entry names (forward slashes, as stored), directories excluded.
  list(): string[] {
    return [...this.entries.keys()].filter((n) => !n.endsWith("/"));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  // Find the first entry whose name matches, e.g. locating result.json anywhere in the archive.
  find(pred: (name: string) => boolean): string | null {
    for (const n of this.entries.keys()) if (!n.endsWith("/") && pred(n)) return n;
    return null;
  }

  // Read + decompress one entry, or null when it is absent.
  async read(name: string): Promise<Uint8Array | null> {
    const e = this.entries.get(name);
    if (!e) return null;
    // The central directory's local-header offset points at a local header whose own name/extra
    // lengths give the true start of the file data.
    const lh = e.localHeaderOffset;
    const nameLen = u16(this.view, lh + 26);
    const extraLen = u16(this.view, lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const compressed = this.bytes.subarray(dataStart, dataStart + e.compressedSize);
    if (e.method === 0) return compressed.slice();
    if (e.method === 8) return inflateRaw(compressed);
    throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
  }
}
