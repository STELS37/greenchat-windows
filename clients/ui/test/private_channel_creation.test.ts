import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newChatText } from "../src/screens/new_chat_strings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const creationForm = readFileSync(resolve(here, "../src/screens/new_chat_creation_form.ts"), "utf8");
const chatList = readFileSync(resolve(here, "../src/screens/chat_list_screen.ts"), "utf8");

test("private-channel creation explicitly requests approval mode end-to-end", () => {
  // The form is lazy-loaded from the overlay; the approval-mode decision moved with it.
  assert.match(creationForm, /joinMode:\s*publicChannel\s*\?\s*"open"\s*:\s*"approve"/);
  assert.match(chatList, /join_mode:\s*joinMode/);
  assert.match(newChatText("ru", "privateHint"), /заявк/i);
  assert.match(newChatText("ru", "privateHint"), /администратор/i);
  assert.match(newChatText("en", "privateHint"), /approves or declines/i);
});
