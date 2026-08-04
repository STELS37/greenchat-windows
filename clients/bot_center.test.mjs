import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBotCommands, formatBotCommands } from "./ui/src/screens/bots_screen.ts";
import { WEB_ROUTES } from "./ui/src/router.ts";

test("Bot Center command editor round-trips canonical commands", () => {
  const parsed = parseBotCommands("/start — Start the bot\n/help: Show help\nstatus - Current status");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.commands, [
    { command: "start", description: "Start the bot" },
    { command: "help", description: "Show help" },
    { command: "status", description: "Current status" },
  ]);
  assert.equal(
    formatBotCommands(parsed.commands),
    "/start — Start the bot\n/help — Show help\n/status — Current status",
  );
});

test("Bot Center command editor reports malformed and duplicate lines without dropping them silently", () => {
  const parsed = parseBotCommands("/start — First\n/start — Duplicate\nnot a command\n/help — ");
  assert.deepEqual(parsed.commands, [{ command: "start", description: "First" }]);
  assert.deepEqual(parsed.errors, [
    { line: 2, reason: "duplicate" },
    { line: 3, reason: "format" },
    { line: 4, reason: "format" },
  ]);
});

test("Bot Center is a canonical application route", () => {
  assert.ok(WEB_ROUTES.some((route) => route.name === "bots" && route.pattern === "/bots"));
});
