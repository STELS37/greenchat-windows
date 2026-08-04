// T-124 follow-up: publishable HTML editions of the legal package.
//
// The authoritative texts live as markdown under docs/legal/ and are served to clients as JSON by
// GET /v1/legal/:doc. A JSON body is fine for the app, but a store review (Google Play demands a
// public, human-readable privacy policy URL) and an ordinary visitor both need a real web page.
// Rather than duplicating the text, this tool renders the SAME markdown files into static pages
// under clients/web/public/legal/<doc>/index.html, which the web build copies into the dist root and
// the native shells package as assets. Pages use only a local, versioned-with-source stylesheet and
// relative navigation. The independent mirror copies that stylesheet too, so it remains usable during
// a product-server outage without weakening the production Content-Security-Policy with inline CSS.
//
// Usage:
//   node scripts/build-legal-pages.mjs           -> write the pages
//   node scripts/build-legal-pages.mjs --check   -> verify committed pages match the markdown
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientsDir = resolve(here, "..");
const repoRoot = resolve(clientsDir, "..");
export const LEGAL_SOURCE_DIR = join(repoRoot, "docs", "legal");
export const LEGAL_OUT_DIR = join(clientsDir, "web", "public", "legal");

// The published set. `slug` is the URL segment (/legal/<slug>/) and matches the :doc param of
// GET /v1/legal/:doc, so a link can be moved between the two surfaces without renaming anything.
export const LEGAL_DOCS = [
  {
    slug: "privacy",
    file: "privacy.md",
    title: "Политика конфиденциальности Green Chat",
    description:
      "Полный текст политики конфиденциальности Green Chat: какие данные обрабатывает сервис, что видит сервер и как управлять своими данными.",
  },
  {
    slug: "tos",
    file: "tos.md",
    title: "Условия использования Green Chat",
    description:
      "Полный текст условий использования мессенджера Green Chat: правила доступа, обязанности пользователя и границы ответственности оператора.",
  },
];

const SUPPORT_EMAIL = "greenchat@globalsystem.cc";

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Only links the legal texts actually use are accepted. A sibling markdown file becomes the sibling
// published page (relative, so a subdirectory mirror keeps working); mail/http(s) targets pass
// through; anything else is rendered as plain text rather than guessed at.
function resolveLinkHref(target) {
  const md = /^([a-z0-9_-]+)\.md(#.*)?$/i.exec(target);
  if (md) {
    const slug = md[1].toLowerCase();
    if (LEGAL_DOCS.some((d) => d.slug === slug)) return `../${slug}/${md[2] ?? ""}`;
  }
  if (/^(https?:\/\/|mailto:)/i.test(target)) return target;
  return null;
}

// Inline markdown to HTML. Code spans are extracted first so emphasis and link syntax inside them
// stay literal; everything is HTML-escaped before any tag is introduced, so document text can never
// inject markup.
function renderInline(raw) {
  const codes = [];
  let text = raw.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `@@GCCODE${codes.length - 1}@@`;
  });
  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_whole, label, target) => {
    const href = resolveLinkHref(target);
    if (!href) return label;
    const external = /^https?:/i.test(href);
    const rel = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return '<a href="' + escapeHtml(href) + '"' + rel + '>' + label + "</a>";
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/@@GCCODE(\d+)@@/g, (_m, i) => "<code>" + escapeHtml(codes[Number(i)]) + "</code>");
  return text;
}

// Block-level markdown to HTML. The legal documents use a deliberately small subset: ATX headings,
// dash bullet lists with hanging-indent continuation lines, and plain paragraphs. Anything outside
// that subset means the text grew a construct nobody reviewed for publication, so it throws instead
// of silently emitting raw markdown onto a public page.
export function renderLegalMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push("<p>" + renderInline(paragraph.join(" ")) + "</p>");
    paragraph = [];
  };
  const flushList = () => {
    if (list === null) return;
    const items = list.map((item) => "<li>" + renderInline(item.join(" ")) + "</li>").join("");
    out.push("<ul>" + items + "</ul>");
    list = null;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 6);
      out.push("<h" + level + ">" + renderInline(heading[2].trim()) + "</h" + level + ">");
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      // thematic break: both documents use it to separate the binding Russian text from the
      // non-binding English summary, so it must render as a rule, not as a paragraph of dashes
      flushParagraph();
      flushList();
      out.push("<hr />");
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (list === null) list = [];
      list.push([bullet[1].trim()]);
      continue;
    }
    if (/^\s/.test(line) && list !== null) {
      list[list.length - 1].push(line.trim());
      continue;
    }
    if (/^(```|\||>)/.test(line.trim()) || /^\d+\.\s/.test(line.trim())) {
      throw new Error("unsupported markdown construct in legal text: " + line.trim().slice(0, 60));
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return out.join("\n      ");
}

// Public pages deliberately use local CSS rather than inline style: production serves a strict
// style-src 'self' CSP, while the static mirror copies the same dependency-free file.

export function renderLegalPage(doc, markdown) {
  const body = renderLegalMarkdown(markdown);
  const other = LEGAL_DOCS.find((d) => d.slug !== doc.slug);
  const otherLabel = other.title.replace(" Green Chat", "");
  return [
    "<!doctype html>",
    '<html lang="ru">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <title>" + escapeHtml(doc.title) + "</title>",
    '    <meta name="description" content="' + escapeHtml(doc.description) + '" />',
    '    <meta name="robots" content="index,follow" />',
    '    <link rel="canonical" href="https://greenchat.globalsystem.cc/legal/' + doc.slug + '/" />',
    '    <link rel="stylesheet" href="../../public-page.css" />',
    "  </head>",
    "  <body>",
    "    <main>",
    '      <nav class="doc-nav" aria-label="Документы Green Chat">',
    '        <a href="../../">Green Chat</a>',
    '        <a href="../' + other.slug + '/">' + escapeHtml(otherLabel) + "</a>",
    "      </nav>",
    "      <article>",
    "      " + body,
    "      </article>",
    "      <footer>",
    '        Вопросы по документам: <a href="mailto:' + SUPPORT_EMAIL + '">' + SUPPORT_EMAIL + "</a>.",
    "        Страница собрана из исходного текста <code>docs/legal/" + doc.file + "</code>;",
    "        то же содержимое отдаёт программный интерфейс <code>GET /v1/legal/" + doc.slug + "</code>.",
    "      </footer>",
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

export async function buildLegalPages() {
  const pages = [];
  for (const doc of LEGAL_DOCS) {
    const markdown = await readFile(join(LEGAL_SOURCE_DIR, doc.file), "utf8");
    pages.push({ doc, html: renderLegalPage(doc, markdown) });
  }
  return pages;
}

async function main() {
  const check = process.argv.includes("--check");
  const pages = await buildLegalPages();
  const stale = [];
  for (const page of pages) {
    const outFile = join(LEGAL_OUT_DIR, page.doc.slug, "index.html");
    if (check) {
      let current = null;
      try {
        current = await readFile(outFile, "utf8");
      } catch {
        current = null;
      }
      if (current !== page.html) stale.push("legal/" + page.doc.slug + "/index.html");
      continue;
    }
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, page.html, "utf8");
    process.stdout.write("wrote legal/" + page.doc.slug + "/index.html (" + page.html.length + " bytes)\n");
  }
  if (check && stale.length > 0) {
    process.stderr.write("legal pages are stale: " + stale.join(", ") + "\n");
    process.stderr.write("run: node clients/scripts/build-legal-pages.mjs\n");
    process.exitCode = 1;
    return;
  }
  if (check) process.stdout.write("legal pages match docs/legal/*.md\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
