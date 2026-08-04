// T-417 — Telegram export parser + import driver. Pure unit tests (no server, no DOM): the parser
// normalises a representative result.json, and the driver is exercised with fake I/O ports so we can
// assert media-upload dedup, ≤ 500 batching, the done flag, and file_id mapping deterministically.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTelegramExport,
  flattenTgText,
  guessMimeFromName,
  batchMessages,
  batchMessagesBySize,
  runTelegramImport,
  TG_IMPORT_BATCH_BYTES,
  type TgImportBatch,
  type TgImportResult,
  type TgImportProgress,
} from "../src/tg_import.ts";

test("flattenTgText: string, entity array, and non-text", () => {
  assert.equal(flattenTgText("hello"), "hello");
  assert.equal(
    flattenTgText(["see ", { type: "bold", text: "this" }, " and ", { type: "link", text: "here" }]),
    "see this and here",
  );
  assert.equal(flattenTgText(undefined), "");
  assert.equal(flattenTgText(42), "");
});

test("guessMimeFromName", () => {
  assert.equal(guessMimeFromName("photo_1@01.jpg"), "image/jpeg");
  assert.equal(guessMimeFromName("clip.MP4"), "video/mp4");
  assert.equal(guessMimeFromName("voice.ogg"), "audio/ogg");
  assert.equal(guessMimeFromName("archive"), "application/octet-stream");
  assert.equal(guessMimeFromName("weird.xyz"), "application/octet-stream");
});

test("parseTelegramExport: title, service skip, seq gaps, media, text flatten", () => {
  const exportObj = {
    name: "Мой чат",
    type: "personal_chat",
    messages: [
      { id: 1, type: "service", date_unixtime: "1560000000", action: "create_group" },
      { id: 2, type: "message", date_unixtime: "1560000100", from: "Алиса", text: "привет" },
      {
        id: 3,
        type: "message",
        date_unixtime: "1560000200",
        from: "Боб",
        text: ["смотри ", { type: "bold", text: "фото" }],
        photo: "photos/photo_1@01.jpg",
      },
      {
        id: 4,
        type: "message",
        date_unixtime: "1560000300",
        from: "Алиса",
        text: "",
        file: "video_files/clip.mp4",
        media_type: "video_file",
        mime_type: "video/mp4",
      },
      {
        id: 5,
        type: "message",
        date_unixtime: "1560000400",
        from: "Боб",
        text: "медиа не скачано",
        file: "(File not included. Change data exporting settings to download.)",
      },
    ],
  };
  const parsed = parseTelegramExport(exportObj);
  assert.equal(parsed.title, "Мой чат");
  // Service row skipped → 4 conversation messages.
  assert.equal(parsed.messages.length, 4);
  // seq is the raw index → service row's index (0) is absent, so seqs are 1,2,3,4.
  assert.deepEqual(parsed.messages.map((m) => m.seq), [1, 2, 3, 4]);
  assert.equal(parsed.messages[0]!.from, "Алиса");
  assert.equal(parsed.messages[0]!.date, 1560000100);
  assert.equal(parsed.messages[1]!.text, "смотри фото");
  assert.equal(parsed.messages[1]!.mediaPath, "photos/photo_1@01.jpg");
  assert.equal(parsed.messages[1]!.mediaMime, "image/jpeg");
  assert.equal(parsed.messages[2]!.mediaPath, "video_files/clip.mp4");
  assert.equal(parsed.messages[2]!.mediaMime, "video/mp4");
  // "(File not included…)" is a placeholder, not a path → text kept, no media.
  assert.equal(parsed.messages[3]!.mediaPath, null);
  assert.equal(parsed.messages[3]!.text, "медиа не скачано");
  // Distinct media, first-seen order.
  assert.deepEqual(parsed.mediaPaths, ["photos/photo_1@01.jpg", "video_files/clip.mp4"]);
});

test("parseTelegramExport: date fallback to ISO, then 0", () => {
  const parsed = parseTelegramExport({
    name: "x",
    messages: [
      { type: "message", date: "2019-06-08T12:00:00", text: "a" }, // no unixtime → parse ISO
      { type: "message", text: "b" }, // no date at all → 0 (server clamps to import time)
    ],
  });
  assert.ok(parsed.messages[0]!.date > 0);
  assert.equal(parsed.messages[1]!.date, 0);
});

test("parseTelegramExport: rejects non-exports", () => {
  assert.throws(() => parseTelegramExport(null), /not a Telegram export/);
  assert.throws(() => parseTelegramExport({ name: "x" }), /missing messages/);
});

test("batchMessages: chunking", () => {
  assert.deepEqual(batchMessages([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batchMessages([], 2), []);
  assert.throws(() => batchMessages([1], 0), /positive/);
});

test("batchMessagesBySize: splits on the byte budget before the count cap", () => {
  const ten = () => 10;
  // Count cap alone.
  assert.deepEqual(batchMessagesBySize([1, 2, 3, 4, 5], 2, 1000, ten), [[1, 2], [3, 4], [5]]);
  // Byte budget bites first: each item costs 10 + 1, so 33 bytes fits exactly three.
  assert.deepEqual(batchMessagesBySize([1, 2, 3, 4, 5, 6, 7], 500, 33, ten), [[1, 2, 3], [4, 5, 6], [7]]);
  // An item larger than the whole budget still travels (alone) instead of hanging the loop.
  assert.deepEqual(batchMessagesBySize([1, 2], 500, 5, ten), [[1], [2]]);
  assert.deepEqual(batchMessagesBySize([], 500, 100, ten), []);
  assert.throws(() => batchMessagesBySize([1], 0, 100, ten), /positive/);
  assert.throws(() => batchMessagesBySize([1], 5, 0, ten), /positive/);
});

// --- driver ---------------------------------------------------------------------------------

function fakeResult(over: Partial<TgImportResult>): TgImportResult {
  return {
    chat_id: 7,
    imported: 0,
    skipped: 0,
    message_count: 0,
    file_count: 0,
    done: false,
    summary: "",
    ...over,
  };
}

test("runTelegramImport: uploads distinct media once, batches, maps file_id, done last", async () => {
  const parsed = {
    title: "Мой чат",
    messages: [
      { seq: 0, from: "A", date: 1, text: "hi", mediaPath: "a.jpg", mediaMime: "image/jpeg" },
      { seq: 1, from: "B", date: 2, text: "again", mediaPath: "a.jpg", mediaMime: "image/jpeg" },
      { seq: 2, from: "A", date: 3, text: "no media", mediaPath: "miss.bin", mediaMime: "application/octet-stream" },
    ],
    mediaPaths: ["a.jpg", "miss.bin"],
  };

  const uploads: string[] = [];
  const sent: TgImportBatch[] = [];
  const progress: TgImportProgress[] = [];
  let nextId = 100;
  let cumMsg = 0;
  let cumFiles = 0;

  const result = await runTelegramImport(
    parsed,
    {
      importId: "imp-xyz",
      async readMedia(path) {
        if (path === "miss.bin") return null; // simulate a partial export
        return { bytes: new Uint8Array([1, 2, 3]), name: path, mime: "image/jpeg" };
      },
      async upload(_bytes, name, _mime) {
        uploads.push(name);
        return nextId++;
      },
      async sendBatch(payload) {
        sent.push(payload);
        const imported = payload.messages.length;
        const files = payload.messages.filter((m) => m.file_id !== null).length;
        cumMsg += imported;
        cumFiles += files;
        return fakeResult({
          imported,
          message_count: cumMsg,
          file_count: cumFiles,
          done: payload.done,
          summary: `${cumMsg} сообщений, ${cumFiles} файлов`,
        });
      },
      onProgress: (p) => progress.push(p),
    },
    { batchSize: 2 },
  );

  // Only the readable media uploaded, and only once despite two references.
  assert.deepEqual(uploads, ["a.jpg"]);
  // Two batches (2 + 1); done only on the last.
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.done, false);
  assert.equal(sent[1]!.done, true);
  assert.equal(sent[0]!.import_id, "imp-xyz");
  assert.equal(sent[0]!.title, "Мой чат");
  // file_id mapping: both a.jpg refs → 100; miss.bin → null.
  assert.equal(sent[0]!.messages[0]!.file_id, 100);
  assert.equal(sent[0]!.messages[1]!.file_id, 100);
  assert.equal(sent[1]!.messages[0]!.file_id, null);
  // Final result is cumulative.
  assert.equal(result.message_count, 3);
  assert.equal(result.file_count, 2);
  assert.equal(result.summary, "3 сообщений, 2 файлов");
  // Progress: one media tick per path, one per batch, one final done.
  assert.equal(progress.filter((p) => p.phase === "media").length, 2);
  assert.equal(progress.filter((p) => p.phase === "batch").length, 2);
  assert.equal(progress.filter((p) => p.phase === "done").length, 1);
});

test("runTelegramImport: empty export still sends one done batch", async () => {
  const sent: TgImportBatch[] = [];
  await runTelegramImport(
    { title: "Empty", messages: [], mediaPaths: [] },
    {
      importId: "imp-empty",
      async readMedia() {
        return null;
      },
      async upload() {
        return 1;
      },
      async sendBatch(payload) {
        sent.push(payload);
        return fakeResult({ done: payload.done, summary: "0 сообщений, 0 файлов" });
      },
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.done, true);
  assert.equal(sent[0]!.messages.length, 0);
});


test("runTelegramImport: abort after an upload stops the next media and every batch", async () => {
  const ctrl = new AbortController();
  const reads: string[] = [];
  const uploads: string[] = [];
  let batches = 0;

  await assert.rejects(
    runTelegramImport(
      {
        title: "cancel media",
        messages: [],
        mediaPaths: ["a.jpg", "b.jpg"],
      },
      {
        importId: "imp-cancel-media",
        async readMedia(path) {
          reads.push(path);
          return { bytes: new Uint8Array([1]), name: path, mime: "image/jpeg" };
        },
        async upload(_bytes, name, _mime, signal) {
          assert.equal(signal, ctrl.signal);
          uploads.push(name);
          ctrl.abort();
          return 101;
        },
        async sendBatch() {
          batches += 1;
          return fakeResult({ done: true });
        },
      },
      { signal: ctrl.signal },
    ),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );

  assert.deepEqual(reads, ["a.jpg"]);
  assert.deepEqual(uploads, ["a.jpg"]);
  assert.equal(batches, 0, "no authenticated batch starts after cancellation");
});

test("runTelegramImport: abort after a batch prevents the next batch and terminal progress", async () => {
  const ctrl = new AbortController();
  const sent: TgImportBatch[] = [];
  const progress: TgImportProgress[] = [];

  await assert.rejects(
    runTelegramImport(
      {
        title: "cancel batches",
        messages: [
          { seq: 0, from: "A", date: 1, text: "one", mediaPath: null, mediaMime: null },
          { seq: 1, from: "A", date: 2, text: "two", mediaPath: null, mediaMime: null },
        ],
        mediaPaths: [],
      },
      {
        importId: "imp-cancel-batch",
        async readMedia() { return null; },
        async upload() { return 1; },
        async sendBatch(payload) {
          sent.push(payload);
          ctrl.abort();
          return fakeResult({ imported: payload.messages.length, done: payload.done });
        },
        onProgress: (p) => progress.push(p),
      },
      { batchSize: 1, signal: ctrl.signal },
    ),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );

  assert.equal(sent.length, 1);
  assert.equal(progress.some((p) => p.phase === "batch" || p.phase === "done"), false);
});

// Regression (QA, hostile + ordinary persona): a long-form Russian chat used to be chunked by MESSAGE
// COUNT only, so a legal 500-message batch serialised to ~1.2 MB and the server refused the whole body
// (cfg.maxJsonBytes = 1 MiB). Worse, the refusal arrived as a dead socket, so the import surfaced as a
// generic network failure. The server now answers 413 honestly; the driver must ALSO stop producing
// bodies it knows are too big — the export is the user's real history, not an abuse case.
test("runTelegramImport: keeps every batch under the server's 1 MiB JSON ceiling", async () => {
  const SERVER_MAX_JSON_BYTES = 1048576; // server/src/core/config.ts cfg.maxJsonBytes
  // 1200 Cyrillic characters per message = 2400 UTF-8 bytes: an ordinary long-form conversation.
  const text = "п".repeat(1200);
  const messages = Array.from({ length: 900 }, (_, i) => ({
    seq: i,
    from: "Иван Петров",
    date: 1700000000 + i,
    text,
    mediaPath: null,
    mediaMime: null,
  }));

  const sizes: number[] = [];
  let counted = 0;
  await runTelegramImport(
    { title: "Рабочий чат", messages, mediaPaths: [] },
    {
      importId: "imp-long",
      async readMedia() {
        return null;
      },
      async upload() {
        return 1;
      },
      async sendBatch(payload) {
        sizes.push(new TextEncoder().encode(JSON.stringify(payload)).length);
        counted += payload.messages.length;
        return fakeResult({ done: payload.done, message_count: counted, summary: "" });
      },
    },
  );

  assert.ok(sizes.length > 1, "a 900-message long-form export must span several batches");
  for (const size of sizes) {
    assert.ok(
      size < SERVER_MAX_JSON_BYTES,
      `batch of ${size} bytes exceeds the server ceiling of ${SERVER_MAX_JSON_BYTES}`,
    );
  }
  // Nothing is dropped on the way: every message still travels exactly once.
  assert.equal(counted, 900);
  // And the budget is the reason for the split, not an accidentally tiny chunk size.
  assert.ok(Math.max(...sizes) > TG_IMPORT_BATCH_BYTES / 2, "batches should still be filled up");
});
