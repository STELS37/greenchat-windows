// Regression guard: source builders validate untrusted folder/ZIP input before ImportModel.run().
// A synchronous builder failure must be routed through the model's ordinary error state instead of
// escaping to the global crash reporter while the import screen stays idle.
import test from "node:test";
import assert from "node:assert/strict";

import { createImportModel, type ImportPorts, type ImportSource } from "../src/screens/import_model.ts";
import { importSourceOrFailure } from "../src/screens/import_screen.ts";

const ports: ImportPorts = {
  async parse() {
    return { parsed: {}, title: "unused", messageCount: 0, mediaCount: 0 };
  },
  async drive() {
    return { chatId: 1, messageCount: 0, fileCount: 0, summary: "unused" };
  },
  newImportId() {
    return "import-source-error-test";
  },
};

test("a valid import source is preserved unchanged", () => {
  const source: ImportSource = {
    async readManifest() { return "{}"; },
    async readMedia() { return null; },
  };
  assert.equal(importSourceOrFailure(() => source), source);
});

test("a synchronous source-builder failure becomes a rejecting ImportSource", async () => {
  const cause = new Error("invalid ZIP central directory");
  const source = importSourceOrFailure(() => { throw cause; });

  await assert.rejects(source.readManifest(), (error: unknown) => error === cause);
  assert.equal(await source.readMedia("anything"), null);
});

test("the wrapped builder failure lands in ImportModel's recoverable error state", async () => {
  const model = createImportModel(ports);
  await model.run(importSourceOrFailure(() => { throw new Error("not a ZIP archive"); }));

  const state = model.getState();
  assert.equal(state.status, "error");
  if (state.status === "error") assert.equal(state.message, "not a ZIP archive");
});
