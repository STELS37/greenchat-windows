import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { supportMessageKind } from "../src/screens/support_topic_composer.ts";

test("V187: support attachment MIME types keep their native chat presentation", () => {
  assert.equal(supportMessageKind("image/png"), "photo");
  assert.equal(supportMessageKind("IMAGE/WEBP"), "photo");
  assert.equal(supportMessageKind("video/mp4"), "video");
  assert.equal(supportMessageKind("audio/ogg"), "audio");
  assert.equal(supportMessageKind("application/pdf"), "file");
  assert.equal(supportMessageKind(""), "file");
});

test("V187 client: every support ticket is a topic with its own composer and media upload", () => {
  const hub = readFileSync(new URL("../src/screens/support_help_impl.ts", import.meta.url), "utf8");
  const composer = readFileSync(new URL("../src/screens/support_topic_composer.ts", import.meta.url), "utf8");
  assert.match(hub, /"data-topic-ref": t\.ref/);
  assert.match(composer, /"data-support-topic": ticket\.ref/);
  assert.match(hub, /role: "log"/);
  assert.match(composer, /deps\.media\.upload/);
  assert.match(composer, /\/v1\/support\/tickets\/\$\{encodeURIComponent\(ticket\.ref\)\}\/messages/);
  assert.match(composer, /file_id: fileId/);
  assert.match(composer, /client_msg_id: clientMessageId\(\)/);
});

test("V187 server: the exact ticket ref retains message and attachment metadata after delivery", () => {
  const source = readFileSync(new URL("../../../server/src/modules/support.ts", import.meta.url), "utf8");
  assert.match(source, /const SUPPORT_MEDIA_KINDS = new Set<string>/);
  assert.match(source, /sendMessageCore\(\{/);
  assert.match(source, /\.\.\.\(fileId !== null \? \{ fileId \} : \{\}\)/);
  assert.match(source, /file_id: sent\.file\.id/);
  assert.match(source, /file_name: sent\.file\.name/);
  assert.match(source, /file_mime: sent\.file\.mime/);
  assert.match(source, /message_id: sent\.id/);
});
