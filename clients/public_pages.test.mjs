// Store-facing and public-support pages. These checks run without a server: they prevent publishing
// a page that production CSP cannot render, a crawler endpoint that falls into the SPA shell, or a
// contact/deletion route that points outside the operator-controlled domain.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENTS = dirname(fileURLToPath(import.meta.url));
const REPO = join(CLIENTS, "..");
const PUBLIC = join(CLIENTS, "web", "public");
const PAGE_FILES = [
  join(CLIENTS, "web", "index.html"),
  join(PUBLIC, "en", "index.html"),
  join(PUBLIC, "welcome", "index.html"),
  join(PUBLIC, "help", "index.html"),
  join(PUBLIC, "account-deletion", "index.html"),
  join(PUBLIC, "legal", "privacy", "index.html"),
  join(PUBLIC, "legal", "tos", "index.html"),
  join(PUBLIC, "legal", "open-source", "index.html"),
];

// Google Play requires a public, human-readable privacy policy URL, and the same page must be
// reachable from the app itself. Both are static assets under web/public, so every distribution
// channel ships them without a server round-trip.
test("published legal pages are packaged client assets, not a JSON endpoint", () => {
  for (const slug of ["privacy", "tos"]) {
    const html = readFileSync(join(PUBLIC, "legal", slug, "index.html"), "utf8");
    assert.match(html, /<h1>/);
    assert.match(html, /Green Chat/);
    assert.doesNotMatch(html, /^\s*\{"ok":/);
  }
  for (const page of PAGE_FILES.slice(0, 7)) {
    const html = readFileSync(page, "utf8");
    assert.doesNotMatch(
      html,
      /href="\/v1\/legal\/(tos|privacy)"/,
      page + ": human-facing links must point at the rendered page, not the JSON API",
    );
  }
});

// Production's style-src/script-src policy permits local files but deliberately rejects inline code.
// A page with <style> or an inline script therefore appears unstyled or non-functional even though it
// returns HTTP 200. Pin all public support/legal surfaces to local dependencies.
test("public support and legal pages comply with the production CSP", () => {
  const cspPages = PAGE_FILES.slice(3);
  for (const page of cspPages) {
    const html = readFileSync(page, "utf8");
    assert.doesNotMatch(html, /<style(?:\s|>)/i, page + ": inline CSS is blocked by production CSP");
    for (const script of html.matchAll(/<script\b([^>]*)>/gi)) {
      assert.match(script[1], /\bsrc="[^"]+"/i, page + ": inline script is blocked by production CSP");
    }
    assert.match(html, /<link[^>]+rel="stylesheet"[^>]+public-page\.css/i, page + ": shared local CSS missing");
  }
  assert.ok(existsSync(join(PUBLIC, "public-page.css")), "shared public-page.css must be packaged");
  assert.ok(
    existsSync(join(PUBLIC, "legal", "open-source", "source-status.js")),
    "open-source status module must be packaged",
  );
});

// A support address printed on a public page is a promise that mail sent there reaches the operator.
test("public pages only advertise contact addresses on operator-controlled domains", () => {
  const OWNED = new Set(["globalsystem.cc"]);
  let seen = 0;
  for (const page of PAGE_FILES) {
    const html = readFileSync(page, "utf8");
    for (const match of html.matchAll(/mailto:([^"'\s>]+)/g)) {
      const domain = match[1].split("@")[1]?.toLowerCase();
      seen += 1;
      assert.ok(
        domain && OWNED.has(domain),
        page + ": contact address " + match[1] + " is not on a domain we control",
      );
    }
  }
  assert.ok(seen > 0, "public pages must publish at least one contact address");
});

// Missing crawler files used to be swallowed by the SPA fallback and returned the landing HTML with
// a misleading 200. Static source files make their MIME type and content deterministic after build.
test("robots.txt and sitemap.xml are real crawler resources", () => {
  const robots = readFileSync(join(PUBLIC, "robots.txt"), "utf8");
  const sitemap = readFileSync(join(PUBLIC, "sitemap.xml"), "utf8");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/greenchat\.globalsystem\.cc\/sitemap\.xml$/m);
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  for (const path of ["/", "/en/", "/help/", "/account-deletion/", "/legal/privacy/", "/legal/tos/", "/legal/open-source/"]) {
    assert.match(sitemap, new RegExp(`<loc>https://greenchat\\.globalsystem\\.cc${path.replaceAll("/", "\\/")}<\\/loc>`));
  }
  assert.doesNotMatch(robots, /<!doctype html>/i);
  assert.doesNotMatch(sitemap, /<!doctype html>/i);
});

// Search engines must consolidate helper/legal URLs instead of indexing slash/query variants as
// separate documents. Canonicals are absolute so mirrors and packaged clients still point to prod.
test("indexable support and legal pages publish absolute canonical URLs", () => {
  for (const page of PAGE_FILES.slice(3)) {
    const html = readFileSync(page, "utf8");
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/greenchat\.globalsystem\.cc\/[^"]*" \/>/,
      page + ": absolute canonical URL missing",
    );
  }
});

// The public origin accepts credentials and hosts the web client, so browsers must not be allowed to
// downgrade subsequent visits to plaintext HTTP. Keep the policy host-only: sibling subdomains are
// independent services and must opt in separately.
test("production nginx enables host-scoped HSTS", () => {
  const nginx = readFileSync(join(REPO, "infra", "nginx", "greenchat-globalsystem"), "utf8");
  assert.match(
    nginx,
    /add_header Strict-Transport-Security "max-age=31536000" always;/,
  );
  assert.doesNotMatch(nginx, /Strict-Transport-Security[^\n]*includeSubDomains/i);
});
