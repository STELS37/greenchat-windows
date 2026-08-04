// V191 — Help & Support must not inflate the messenger's first-load bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../src/screens/support_help.ts", import.meta.url), "utf8");
const hub = readFileSync(new URL("../src/screens/support_help_impl.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/screens/support_topic_composer.ts", import.meta.url), "utf8");

test("V191: the complete support hub is loaded only when the person opens it", () => {
  assert.match(shell, /import\("\.\/support_help_impl\.ts"\)/);
  assert.doesNotMatch(shell, /from "\.\/support_help_impl\.ts"/);
  assert.doesNotMatch(shell, /faqEntries|listSupportTickets|support_topic_composer/);
  assert.match(hub, /faqEntries/);
  assert.match(hub, /listSupportTickets/);
});

test("V191: support topic reply machinery is loaded only after an active ticket opens", () => {
  assert.match(hub, /import\("\.\/support_topic_composer\.ts"\)/);
  assert.doesNotMatch(hub, /from "\.\/support_topic_composer\.ts"/);
  assert.doesNotMatch(hub, /deps\.media\.upload/);
  assert.match(composer, /deps\.media\.upload/);
  assert.match(composer, /\/v1\/support\/tickets\/\$\{encodeURIComponent\(ticket\.ref\)\}\/messages/);
});

test("V191: late chunks cannot append after Back or destroy", () => {
  assert.match(shell, /if \(disposed\) return/);
  assert.match(hub, /const generation = \+\+viewGeneration/);
  assert.match(hub, /disposed \|\| generation !== viewGeneration/);
  assert.match(hub, /isDisposed: \(\) => disposed \|\| generation !== viewGeneration/);
});

test("V191: hidden upload input stays CSP-safe without an inline style", () => {
  assert.match(composer, /hidden: true/);
  assert.doesNotMatch(composer, /\.style\./);
});
