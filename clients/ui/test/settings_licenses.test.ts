import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clients = resolve(here, "../..");
const settings = readFileSync(resolve(clients, "ui/src/screens/settings_screen.ts"), "utf8");
const ru = readFileSync(resolve(clients, "ui/src/locales/ru.ts"), "utf8");
const en = readFileSync(resolve(clients, "ui/src/locales/en.ts"), "utf8");
const legalRoot = resolve(clients, "web/public/legal/open-source");

test("Settings exposes a prominent open-source licenses tab with no-warranty and source access", () => {
  assert.match(settings, /type Tab =[\s\S]*"licenses"/);
  // The settings index is a vertical section list (icon + label + chevron), so the row factory
  // takes a glyph as well. What matters for the AGPL/GPL obligation is unchanged: the licenses
  // row is built from the shared factory and is unconditionally part of the navigation list.
  assert.match(settings, /tabBtn\("licenses", "settings\.tabLicenses", "[a-z-]+"\)/);
  assert.match(settings, /const tabList = \[[\s\S]*?\n {4}licensesTab,\n {2}\]/);
  assert.match(settings, /href: "\/legal\/open-source\/"/);
  assert.match(settings, /settings\.licensesNoWarranty/);
  assert.match(settings, /settings\.licensesCopyleft/);
  assert.match(ru, /"settings\.tabLicenses": "Лицензии"/);
  assert.match(en, /"settings\.tabLicenses": "Licenses"/);
});

test("the distributable web/mobile bundle carries GreenChat AGPL and third-party GPL notices", () => {
  const page = readFileSync(resolve(legalRoot, "index.html"), "utf8");
  const sourceStatus = readFileSync(resolve(legalRoot, "source-status.js"), "utf8");
  const agpl = readFileSync(resolve(legalRoot, "greenchat-AGPL-3.0.txt"), "utf8");
  const gpl = readFileSync(resolve(legalRoot, "sing-box-GPL-3.0-or-later.txt"), "utf8");
  const notice = readFileSync(resolve(legalRoot, "sing-box-NOTICE.txt"), "utf8");
  assert.match(page, /src="source-status\.js"/);
  assert.match(sourceStatus, /downloads\.json/);
  assert.match(sourceStatus, /supplemental_artifacts/);
  assert.match(sourceStatus, /row\?\.kind === "corresponding_source"/);
  assert.match(sourceStatus, /row\?\.for_artifact === android\?\.artifact_filename/);
  assert.doesNotMatch(sourceStatus, /platforms\?\.android\?\.source/);
  assert.match(page, /Corresponding Source/i);
  assert.match(page, /no warranty/i);
  assert.match(agpl, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(gpl, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(notice, /experimental\/libbox/);
});
