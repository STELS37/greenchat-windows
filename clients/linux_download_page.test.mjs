import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const build = readFileSync(join(root, "build.mjs"), "utf8");
const templates = new Map([
  ["ru", readFileSync(join(root, "web", "index.html"), "utf8")],
  ["en", readFileSync(join(root, "web", "public", "en", "index.html"), "utf8")],
]);

function count(source, token) {
  return source.split(token).length - 1;
}

test("release templates advertise AppImage, DEB and RPM inside the Linux card", () => {
  for (const [locale, html] of templates) {
    const card = html.match(/<article class="platform-card platform-featured"[^>]*>[\s\S]*?<h3>Linux<\/h3>[\s\S]*?<\/article>/)?.[0];
    assert.ok(card, `${locale}: Linux card missing`);
    assert.match(card, /AppImage \/ DEB \/ RPM/);
    for (const token of [
      "__GC_RELEASE_LINUX_APPIMAGE_URL__",
      "__GC_RELEASE_LINUX_DEB_URL__",
      "__GC_RELEASE_LINUX_RPM_URL__",
    ]) assert.ok(card.includes(token), `${locale}: ${token} must stay inside the Linux card`);
    assert.equal(count(card, "GC_RELEASE_LINUX_RPM_START"), 1, `${locale}: RPM card start marker`);
    assert.equal(count(card, "GC_RELEASE_LINUX_RPM_END"), 1, `${locale}: RPM card end marker`);
  }
});

test("release templates publish all Linux checksums", () => {
  for (const [locale, html] of templates) {
    const checksum = html.match(/<div class="checksum-list">[\s\S]*?<\/div>/)?.[0];
    assert.ok(checksum, `${locale}: checksum list missing`);
    for (const token of [
      "__GC_RELEASE_LINUX_APPIMAGE_SHA256__",
      "__GC_RELEASE_LINUX_DEB_SHA256__",
      "__GC_RELEASE_LINUX_RPM_SHA256__",
    ]) assert.ok(checksum.includes(token), `${locale}: ${token} missing from checksum list`);
    assert.equal(count(checksum, "GC_RELEASE_LINUX_RPM_START"), 1, `${locale}: RPM checksum start marker`);
    assert.equal(count(checksum, "GC_RELEASE_LINUX_RPM_END"), 1, `${locale}: RPM checksum end marker`);
  }
});

test("web builder substitutes RPM metadata and removes optional blocks when RPM is absent", () => {
  assert.match(build, /const linuxRpm = downloads\.platforms\.linux\.packages\.rpm/);
  for (const token of [
    "__GC_RELEASE_LINUX_RPM_SIZE__",
    "__GC_RELEASE_LINUX_RPM_URL__",
    "__GC_RELEASE_LINUX_RPM_SHA256__",
  ]) assert.ok(build.includes(token), `${token} replacement missing`);
  assert.match(build, /linuxRpm[\s\S]*html\.replace\(rpmBlock, ""\)/);
  assert.match(build, /replaceAll\("<!-- GC_RELEASE_LINUX_RPM_START -->", ""\)/);
  assert.match(build, /replaceAll\("<!-- GC_RELEASE_LINUX_RPM_END -->", ""\)/);
});
