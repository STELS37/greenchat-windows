import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

test("V208: native avatar cache separates servers while reusing rotated signed URLs", () => {
  const native = source("../src/screens/avatar_native.ts");
  assert.match(native, /const blobs = new Map<string, Blob>\(\)/u);
  assert.match(native, /return `\$\{url\.origin\}\$\{url\.pathname\}#\$\{fileId\}`/u);
  assert.match(native, /const key = cacheKey\(fileId, src\)/u);
  assert.doesNotMatch(native, /blobs\.get\(fileId\)/u, "numeric IDs alone collide after switching servers");
});

test("V208: Contacts and every new-chat people picker use the real profile photo", () => {
  const contacts = source("../src/screens/contacts_screen.ts");
  const model = source("../src/screens/new_chat_model.ts");
  const overlay = source("../src/screens/new_chat_overlay.ts");
  const creation = source("../src/screens/new_chat_creation_form.ts");
  const chatList = source("../src/screens/chat_list_screen.ts");

  assert.match(contacts, /bindAvatarImage\(avatar, api, opts\.avatarFileId, opts\.title\)/u);
  assert.match(contacts, /avatarFileId: row\.avatar_file_id/u);
  assert.match(contacts, /avatarFileId: user\.avatar_file_id/u);
  assert.match(model, /avatarFileId\?: number/u);
  assert.match(model, /avatarFileId: u\.avatar_file_id/u);
  assert.match(overlay, /bindAvatarImage\(avatar, deps\.avatarApi, row\.avatarFileId \?\? null, row\.title\)/u);
  assert.match(creation, /bindAvatarImage\(avatar, deps\.avatarApi, row\.avatarFileId \?\? null, row\.title\)/u);
  assert.match(chatList, /avatarApi: api/u, "the chat-list entry point must pass the signed-media API into the picker");
});

test("V208: Calls and Bot Center render server photos instead of permanent initials", () => {
  const calls = source("../src/screens/calls_screen.ts");
  const bots = source("../src/screens/bots_screen.ts");

  assert.match(calls, /callAvatar\(chat\.title, chat\.photo_file_id, peopleAvatarBindings\)/u);
  assert.match(calls, /chatAvatarById = new Map\(chats\.map\(\(chat\) => \[chat\.id, chat\.photo_file_id\]\)\)/u);
  assert.match(calls, /callAvatar\(line\.title, chatAvatarById\.get\(item\.chat_id\), logAvatarBindings\)/u);
  assert.match(bots, /bindAvatarImage\(avatar, api, bot\.avatar_file_id, label\)/u);
  assert.match(bots, /botAvatar\(bot, true\)/u);
  assert.match(bots, /resetAvatarBindings\(\);\s*clear\(root\)/u, "repainting cannot leak object URLs or stale images");
});

test("V208: a decoded photo fills and crops the exact avatar disc on APK and EXE", () => {
  const css = source("../../web/src/redesign.css");
  assert.match(css, /:is\([^}]*\.gc-avatar[^}]*\.gc-bot-avatar[^}]*\)\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/su);
  assert.match(css, /\.gc-avatar-photo\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*border-radius:\s*inherit;[^}]*object-fit:\s*cover;/su);
});
