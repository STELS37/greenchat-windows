// T-417 — the import state machine. Pure: fake parse/drive ports drive it through
// idle→parsing→running→done, and separately into the error state, asserting the observable
// transitions and single-flight guard the screen relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createImportModel,
  type ImportPorts,
  type ImportSource,
  type ImportState,
  type ImportDriveProgress,
} from "../src/screens/import_model.ts";

const source: ImportSource = {
  async readManifest() {
    return '{"name":"Мой чат","messages":[]}';
  },
  async readMedia() {
    return null;
  },
};

function capturingPorts(over: Partial<ImportPorts> = {}): ImportPorts {
  return {
    async parse(_text) {
      return { parsed: { tag: "P" }, title: "Мой чат", messageCount: 5, mediaCount: 2 };
    },
    async drive(_parsed, _src, _importId, onProgress) {
      onProgress({ phase: "media", done: 1, total: 2, summary: null });
      onProgress({ phase: "media", done: 2, total: 2, summary: null });
      onProgress({ phase: "sending", done: 1, total: 1, summary: "5 сообщений, 1 файлов" });
      return { chatId: 42, messageCount: 5, fileCount: 1, summary: "5 сообщений, 1 файлов" };
    },
    newImportId() {
      return "imp-fixed-1";
    },
    ...over,
  };
}

test("import model: happy path idle→parsing→running→done", async () => {
  const seen: ImportState[] = [];
  const model = createImportModel(capturingPorts());
  model.subscribe((s) => seen.push(s));
  assert.equal(model.getState().status, "idle");

  await model.run(source);

  const statuses = seen.map((s) => s.status);
  assert.deepEqual(statuses[0], "parsing");
  // At least one media-phase and one sending-phase running state, then done.
  assert.ok(seen.some((s) => s.status === "running" && s.phase === "media"));
  assert.ok(seen.some((s) => s.status === "running" && s.phase === "sending"));
  const final = model.getState();
  assert.equal(final.status, "done");
  if (final.status === "done") {
    assert.equal(final.chatId, 42);
    assert.equal(final.summary, "5 сообщений, 1 файлов");
  }
});

test("import model: threads title/counts and drive's progress into running state", async () => {
  const progresses: ImportDriveProgress[] = [];
  const model = createImportModel(
    capturingPorts({
      async drive(_p, _s, importId, onProgress) {
        assert.equal(importId, "imp-fixed-1"); // newImportId() was used
        const emit = (p: ImportDriveProgress): void => {
          progresses.push(p);
          onProgress(p);
        };
        emit({ phase: "media", done: 2, total: 2, summary: null });
        emit({ phase: "sending", done: 1, total: 3, summary: "partial" });
        return { chatId: 7, messageCount: 5, fileCount: 2, summary: "done" };
      },
    }),
  );
  const running: Extract<ImportState, { status: "running" }>[] = [];
  model.subscribe((s) => {
    if (s.status === "running") running.push(s);
  });
  await model.run(source);
  const last = running.at(-1);
  assert.ok(last, "expected at least one running state");
  assert.equal(last.title, "Мой чат");
  assert.equal(last.messageCount, 5);
  assert.equal(last.phase, "sending");
  assert.equal(last.done, 1);
  assert.equal(last.total, 3);
});

test("import model: parse failure lands in error state", async () => {
  const model = createImportModel(
    capturingPorts({
      async parse() {
        throw new Error("not a Telegram export (missing messages[])");
      },
    }),
  );
  await model.run(source);
  const s = model.getState();
  assert.equal(s.status, "error");
  if (s.status === "error") assert.match(s.message, /Telegram export/);
});

test("import model: drive failure lands in error state", async () => {
  const model = createImportModel(
    capturingPorts({
      async drive() {
        throw new Error("RATE_LIMITED");
      },
    }),
  );
  await model.run(source);
  const s = model.getState();
  assert.equal(s.status, "error");
  if (s.status === "error") assert.equal(s.message, "RATE_LIMITED");
});

test("import model: single-flight — a second run while busy is ignored", async () => {
  let parseCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const model = createImportModel(
    capturingPorts({
      async parse() {
        parseCalls++;
        await gate; // hold in the parsing state
        return { parsed: {}, title: "t", messageCount: 0, mediaCount: 0 };
      },
    }),
  );
  const first = model.run(source);
  assert.equal(model.getState().status, "parsing");
  await model.run(source); // ignored (still parsing)
  assert.equal(parseCalls, 1);
  release();
  await first;
  assert.equal(model.getState().status, "done");
});

test("import model: reset returns to idle after done", async () => {
  const model = createImportModel(capturingPorts());
  await model.run(source);
  assert.equal(model.getState().status, "done");
  model.reset();
  assert.equal(model.getState().status, "idle");
});

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("import model: reset during parsing cancels the run and late parse completion cannot start drive", async () => {
  const gate = deferredVoid();
  let parseStarted!: () => void;
  const started = new Promise<void>((r) => { parseStarted = r; });
  let driveCalls = 0;
  const model = createImportModel(capturingPorts({
    async parse() {
      parseStarted();
      await gate.promise;
      return { parsed: {}, title: "old", messageCount: 1, mediaCount: 0 };
    },
    async drive() {
      driveCalls += 1;
      return { chatId: 1, messageCount: 1, fileCount: 0, summary: "old" };
    },
  }));

  const run = model.run(source);
  await started;
  model.reset();
  assert.equal(model.getState().status, "idle", "reset is an active cancellation, not a no-op");
  gate.resolve();
  await run;
  assert.equal(model.getState().status, "idle");
  assert.equal(driveCalls, 0, "a cancelled parse never starts authenticated import traffic");
});

test("import model: reset during drive ignores late progress/result and returns to idle", async () => {
  const gate = deferredVoid();
  let driveStarted!: () => void;
  const started = new Promise<void>((r) => { driveStarted = r; });
  let emit!: (p: ImportDriveProgress) => void;
  const model = createImportModel(capturingPorts({
    async drive(_p, _s, _id, onProgress) {
      emit = onProgress;
      driveStarted();
      await gate.promise;
      emit({ phase: "sending", done: 1, total: 1, summary: "late" });
      return { chatId: 9, messageCount: 1, fileCount: 0, summary: "late done" };
    },
  }));

  const run = model.run(source);
  await started;
  model.reset();
  assert.equal(model.getState().status, "idle");
  gate.resolve();
  await run;
  assert.equal(model.getState().status, "idle", "late done/error cannot resurrect a destroyed import screen");
});

test("import model: a new run starts immediately after cancelling an older parse", async () => {
  const firstGate = deferredVoid();
  let parseCalls = 0;
  const model = createImportModel(capturingPorts({
    async parse() {
      parseCalls += 1;
      if (parseCalls === 1) await firstGate.promise;
      return { parsed: { run: parseCalls }, title: `run-${parseCalls}`, messageCount: 0, mediaCount: 0 };
    },
  }));

  const oldRun = model.run(source);
  await Promise.resolve();
  model.reset();
  const newRun = model.run(source);
  await newRun;
  assert.equal(parseCalls, 2, "new account/screen is not blocked by the cancelled old run");
  assert.equal(model.getState().status, "done");
  firstGate.resolve();
  await oldRun;
  assert.equal(model.getState().status, "done", "old completion cannot overwrite the newer run");
});
