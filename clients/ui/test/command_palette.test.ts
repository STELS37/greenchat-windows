import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCommands } from "../src/command_palette.ts";
import type { Command } from "../src/command_palette.ts";

const noop = (): void => {};
const cmds: Command[] = [
  { id: "settings", title: "Open Settings", keywords: ["preferences"], run: noop },
  { id: "new", title: "New Chat", run: noop },
  { id: "theme", title: "Toggle Theme", keywords: ["dark", "light"], run: noop },
  { id: "search", title: "Search Messages", run: noop },
];
const ids = (list: Command[]): string[] => list.map((c) => c.id);

test("filterCommands: empty query returns all in original order", () => {
  assert.deepEqual(ids(filterCommands(cmds, "")), ["settings", "new", "theme", "search"]);
  assert.deepEqual(ids(filterCommands(cmds, "   ")), ["settings", "new", "theme", "search"]);
});

test("filterCommands: prefix match", () => {
  assert.deepEqual(ids(filterCommands(cmds, "new")), ["new"]);
});

test("filterCommands: word-boundary match inside the title", () => {
  assert.deepEqual(ids(filterCommands(cmds, "theme")), ["theme"]);
});

test("filterCommands: keyword-only match", () => {
  assert.deepEqual(ids(filterCommands(cmds, "dark")), ["theme"]);
});

test("filterCommands: ranks prefix above word-boundary, stable on ties", () => {
  // "s": "Search Messages" starts with s (80) beats "Open Settings" word-start (60).
  assert.deepEqual(ids(filterCommands(cmds, "s")), ["search", "settings"]);
});

test("filterCommands: no match yields an empty list", () => {
  assert.deepEqual(filterCommands(cmds, "zzz"), []);
});
