// clients/scripts/ux-audit.mjs — measurable UI audit of the built web client.
//
// Why this exists: "the interface looks bad" is an opinion, and opinions cannot be regression-tested.
// This script turns the four defect classes we actually shipped in the past into numbers that either
// pass or fail, on every hash route, in both colour schemes, on a 390x844 touch profile:
//
//   errors        — page errors and HTTP >= 400 raised while the route renders;
//   overflow      — horizontal scroll (layout wider than the viewport) — the classic phone-layout break;
//   smallTargets  — interactive elements below the 44x44 CSS-px minimum (Apple HIG / WCAG 2.5.5);
//   ghostHidden   — elements marked `hidden` that a later CSS layer forced back into layout;
//   lowContrast   — every rendered text node measured against its *painted* background, WCAG 1.4.3
//                   (4.5 normal, 3.0 for large or large-bold text).
//
// Measurement rules that stop false positives, learned from earlier runs:
//   * visually-hidden inputs (a 1x1 file input driven by a <label>) are not touch targets;
//   * an element inside a <label>/<button> is not an independent target either;
//   * gradient backgrounds report no solid background colour, so the audit samples the real painted
//     pixel via elementFromPoint ancestry and falls back to the gradient's own colour stops.
//
// The app holds a WebSocket open, so 'networkidle' never fires; the audit waits for the DOM and
// then settles for a fixed interval before measuring.
//
// Usage:  node clients/scripts/ux-audit.mjs --base http://127.0.0.1:8991 --out var/ux-audit/vNN \
//            [--user NAME --pass SECRET] [--routes /,/settings]
// Exit code is 0 unless --strict is given, in which case any finding fails the run (CI gate).

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = arg('base', 'http://127.0.0.1:8991');
const OUT = arg('out', 'var/ux-audit/latest');
const USER = arg('user', process.env.GC_UX_USER || '');
const PASS = arg('pass', process.env.GC_UX_PASS || '');
const ROUTES = arg('routes', '/,/calls,/wallet,/exchange,/cards,/settings,/connect,/import').split(',');
const SCHEMES = arg('schemes', 'light,dark').split(',');

mkdirSync(OUT, { recursive: true });

// Runs in the page. Kept as one string so it can be evaluated without a bundler.
const MEASURE = `(() => {
  const px = (v) => parseFloat(v) || 0;
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const parse = (c) => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }; };
  const blend = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));

  // Average the colour stops of a gradient: for a small text label the perceived background is
  // roughly the gradient across the label, and the audit must not silently skip gradient surfaces.
  const gradientColour = (image) => {
    const stops = String(image).match(/rgba?\\([^)]+\\)/g);
    if (!stops || !stops.length) return null;
    const parsed = stops.map(parse).filter(Boolean);
    if (!parsed.length) return null;
    return [0, 1, 2].map((i) => parsed.reduce((s, p) => s + p.rgb[i], 0) / parsed.length);
  };

  const backgroundOf = (el) => {
    let node = el, acc = null, alpha = 0;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const grad = cs.backgroundImage && cs.backgroundImage !== 'none' ? gradientColour(cs.backgroundImage) : null;
      const solid = parse(cs.backgroundColor);
      const layer = grad ? { rgb: grad, a: 1 } : solid;
      if (layer && layer.a > 0) {
        acc = acc === null ? layer.rgb : blend(acc, layer.rgb, alpha);
        alpha = layer.a;
        if (layer.a >= 0.99) return acc;
      }
      node = node.parentElement;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor);
    return acc !== null && alpha >= 0.99 ? acc : (body ? body.rgb : [255, 255, 255]);
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || px(cs.opacity) === 0) return false;
    // Content behind an open modal is marked inert: not interactive, not in the accessibility
    // tree, and deliberately dimmed. Measuring the greyed-out conversation behind the message menu
    // reported a 1.38:1 day separator, which is a property of the scrim, not a readability defect.
    // Inert content is only skipped when something really is modal on top of it.
    if (el.closest('[inert]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // A 1x1 clipped input is a screen-reader affordance, not a target: the user taps its <label>.
  const screenReaderOnly = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) return false;
    const cs = getComputedStyle(el);
    return cs.clip !== 'auto' || cs.clipPath !== 'none' || cs.position === 'absolute' || el.classList.contains('gc-visually-hidden');
  };

  const lowContrast = [], smallTargets = [], seen = new Set();

  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length || !visible(el)) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    // WCAG 1.4.3 exempts incidental text. An avatar monogram is aria-hidden (assistive tech never
    // sees it) and the same name is rendered as real text right beside the disc, so the two letters
    // are decoration on a coloured shape, not information. Without this the audit permanently
    // demanded a muddy palette for every peer colour in the app.
    if (el.closest('[aria-hidden="true"]') && el.closest('.gc-avatar')) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = backgroundOf(el);
    const colour = fg.a >= 0.99 ? fg.rgb : blend(fg.rgb, bg, fg.a);
    const size = px(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const cr = ratio(colour, bg);
    if (cr < need) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const key = cls + '|' + Math.round(cr * 20);
      if (seen.has(key)) continue;
      seen.add(key);
      const box = el.getBoundingClientRect();
      // Document coordinates: a viewport-clipped screenshot cannot reach an element below the fold,
      // and cropping outside the viewport silently returned white — which scored a perfect-looking
      // ratio of 1.00 on avatars that are in fact fine.
      const docBox = { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height };
      lowContrast.push({ text: text.slice(0, 24), ratio: Math.round(cr * 100) / 100, need, size, tag: el.tagName.toLowerCase(), cls,
        fg: colour.map(Math.round),
        box: { x: Math.round(docBox.x), y: Math.round(docBox.y), width: Math.round(docBox.width), height: Math.round(docBox.height) } });
    }
  }

  const TAPPABLE = 'a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="switch"],[tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(TAPPABLE)) {
    if (!visible(el) || screenReaderOnly(el)) continue;
    if (el.closest('label') && el.closest('label') !== el) continue;
    if (el.parentElement && el.parentElement.closest('button,[role="button"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 44 && r.height >= 44) continue;
    // A visually small control can still be comfortable if it owns a padded hit area. What matters
    // is where a finger actually lands, so the corners of a 44x44 box centred on the control are
    // probed with elementFromPoint: if they all resolve back to this control, the target is fine
    // regardless of how small its painted box is. Dense inline chips (reactions) live here.
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2, half = 21;
    const probes = [[cx - half, cy - half], [cx + half, cy - half], [cx - half, cy + half], [cx + half, cy + half]];
    const inside = probes.every(([x, y]) => {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit) || hit.closest?.(TAPPABLE) === el);
    });
    if (inside) continue;
    // WCAG 2.2 SC 2.5.8 (Target Size, Minimum, AA) states the real floor: 24x24 CSS px, and a smaller
    // painted control still passes when no neighbouring target's 24 px circle overlaps it. Dense
    // inline chips — reactions under a bubble — are exactly the case the criterion was written for,
    // so they are accepted at 24 px with spacing instead of being forced to Apple's 44 px comfort size.
    if (r.width >= 24 && r.height >= 24) {
      const box24 = (b) => ({ x: b.x + b.width / 2 - 12, y: b.y + b.height / 2 - 12, w: 24, h: 24 });
      const mine = box24(r);
      const crowded = [...document.querySelectorAll(TAPPABLE)].some((other) => {
        if (other === el || el.contains(other) || other.contains(el)) return false;
        const o = other.getBoundingClientRect();
        if (o.width < 1 || o.height < 1) return false;
        const ob = box24(o);
        return mine.x < ob.x + ob.w && ob.x < mine.x + mine.w && mine.y < ob.y + ob.h && ob.y < mine.y + mine.h;
      });
      if (!crowded) continue;
    }
    const cls = typeof el.className === 'string' ? el.className : '';
    smallTargets.push({ tag: el.tagName.toLowerCase(), cls, w: Math.round(r.width), h: Math.round(r.height), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) });
  }

  // A hidden element that still occupies layout is invisible to every other check here: it has no
  // text to contrast and no hit target, yet the user sees an empty band. Found exactly that twice
  // (pinned bar, wallet action), so the rule is now measured on every route.
  const ghostHidden = [];
  for (const el of document.querySelectorAll('[hidden]')) {
    if (el.getAttribute('hidden') === 'until-found') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    ghostHidden.push({ tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '',
      display: cs.display, w: Math.round(r.width), h: Math.round(r.height) });
  }

  return {
    lowContrast,
    smallTargets,
    ghostHidden,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1
      ? [{ scrollWidth: document.documentElement.scrollWidth, inner: window.innerWidth }]
      : [],
  };
})()`;


// Computed styles cannot describe a painted surface: `color-mix()` with a `transparent` stop, a
// radial+linear gradient stack or a translucent panel all resolve to values that no arithmetic can
// turn into "the colour behind this glyph". Averaging the stops reported .gc-finance-eyebrow at 1.56
// while the pixel it is actually drawn on is #fefefe — a true ratio of 6.46. So every candidate is
// re-measured against the rendered pixels: crop the element, take the dominant colour of the crop as
// the background (text covers a minority of a label's area), and score the computed text colour
// against it. Only findings that survive this pass are reported.
// Scoring a crop by its most frequent colour is wrong for anything painted with a gradient: a 54 px
// circular avatar has ~2 300 unique gradient pixels and ~600 identical white corner pixels, so the
// "dominant" colour came out white and every avatar scored a nonsense 1.00. Instead the crop is
// scored per pixel: the contrast of the known text colour against each pixel, glyph pixels dropped
// (anything below 1.15 is the glyph itself or its antialiasing), then the 10th percentile of what
// remains — the worst realistic background the glyph sits on. If almost every pixel is glyph-like the
// element genuinely blends into its background, and that is reported rather than hidden.
const SAMPLE = `async (b64, regions, dpr, fgs) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const cx = cv.getContext('2d');
  cx.drawImage(bmp, 0, 0);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  return regions.map((r, idx) => {
    const x = Math.max(0, Math.round(r.x * dpr));
    const y = Math.max(0, Math.round(r.y * dpr));
    const w = Math.min(bmp.width - x, Math.round(r.width * dpr));
    const h = Math.min(bmp.height - y, Math.round(r.height * dpr));
    if (w < 2 || h < 2) return null;
    const d = cx.getImageData(x, y, w, h).data;
    const fg = fgs[idx];
    const lf = lum(fg[0], fg[1], fg[2]);
    const ratios = [];
    let glyphish = 0, total = 0;
    for (let i = 0; i < d.length; i += 4) {
      total++;
      const lb = lum(d[i], d[i + 1], d[i + 2]);
      const cr = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
      if (cr < 1.15) { glyphish++; continue; }
      ratios.push(cr);
    }
    if (!ratios.length) return { ratio: 1, blended: true, coverage: 1 };
    ratios.sort((a, b) => a - b);
    const p10 = ratios[Math.floor(ratios.length * 0.1)];
    return { ratio: Math.round(p10 * 100) / 100, blended: false, coverage: Math.round((glyphish / total) * 100) / 100 };
  });
}`;

const contrast = (a, b) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, bl]) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

// Computed styles cannot describe a painted surface: `color-mix()` with a `transparent` stop, a
// radial+linear gradient stack or a translucent panel all resolve to values no arithmetic can turn
// into "the colour behind this glyph". Averaging the stops reported .gc-finance-eyebrow at 1.56 while
// the pixel it is drawn on is #fefefe — a true ratio of 6.46. So candidates are re-measured against
// the rendered image: one full-page screenshot per route, each candidate cropped from it, and the
// dominant colour of the crop taken as the background (text covers a minority of a label's area).
// Only findings that survive this pass are reported.
async function verifyAgainstPixels(page, candidates) {
  const scored = candidates.slice(0, 25).filter((c) => c.box && c.fg && c.box.width >= 2 && c.box.height >= 2);
  const passthrough = candidates.slice(0, 25).filter((c) => !scored.includes(c)).map(({ box, fg, ...rest }) => rest);
  if (!scored.length) return passthrough;
  let samples;
  try {
    const shot = await page.screenshot({ fullPage: true });
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    samples = await page.evaluate(
      `(${SAMPLE})("${shot.toString('base64')}", ${JSON.stringify(scored.map((c) => c.box))}, ${dpr}, ${JSON.stringify(scored.map((c) => c.fg))})`,
    );
  } catch {
    return [...passthrough, ...scored.map(({ box, fg, ...rest }) => ({ ...rest, note: 'pixel check unavailable' }))];
  }
  const confirmed = [...passthrough];
  scored.forEach((c, i) => {
    const { box, fg, ...rest } = c;
    const sample = samples[i];
    if (!sample) { confirmed.push(rest); return; }
    if (sample.ratio < c.need) {
      confirmed.push({ ...rest, ratio: sample.ratio, measuredOn: 'pixels', glyphCoverage: sample.coverage,
        ...(sample.blended ? { note: 'text blends into its background' } : {}) });
    }
  });
  return confirmed;
}

const report = {};

for (const scheme of SCHEMES) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    locale: 'ru-RU', isMobile: true, hasTouch: true, colorScheme: scheme,
  });
  const page = await ctx.newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()} ${new URL(r.url()).pathname}`); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  if (USER && PASS) {
    // Sign in through the API and seed the token the shell expects, so routes render real data
    // instead of the signed-out placeholder.
    const token = await page.evaluate(async ([user, pass]) => {
      const r = await fetch('/v1/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const j = await r.json();
      return j?.ok ? j.result : null;
    }, [USER, PASS]);
    if (token) {
      // The shell persists only { refresh, user } under gc.session — the access token is deliberately
      // memory-only (session_storage.ts), so the audit must reproduce that exact shape or the shell
      // discards it as corrupt and renders the signed-out screen.
      await page.evaluate((t) => {
        localStorage.setItem('gc.session', JSON.stringify({ refresh: t.refresh_token, user: t.user }));
      }, token);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
    } else {
      console.error('ux-audit: login failed, auditing the signed-out shell');
    }
  }

  for (const route of ROUTES) {
    errors = [];
    await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    const measured = await page.evaluate(MEASURE);
    measured.lowContrast = await verifyAgainstPixels(page, measured.lowContrast);
    const name = route === '/' ? 'home' : route.replace(/\//g, '');
    await page.screenshot({ path: `${OUT}/${scheme}-${name}.png` });
    report[`${scheme}${route}`] = { ...measured, errors: [...new Set(errors)] };
  }

  // ---- transient surfaces ------------------------------------------------------------------
  // Routes only ever render the resting state of a screen. Everything a finger actually reaches for
  // inside a conversation — the emoji panel, the attachment tray, the message menu, in-chat search —
  // is mounted on demand and was therefore never measured: the emoji grid shipped 41 px cells and
  // 36 px category tabs while the route audit reported "clean". These states are audited explicitly.
  const surfaces = [
    ['emoji', '.gc-composer-emoji, .gc-emoji-btn, button[title*="модзи"]'],
    ['attach', '.gc-composer-attach, button[title*="ложени"]'],
    ['chatsearch', '.gc-feed-header .gc-icon-btn[title*="оиск"]'],
  ];
  errors = [];

  // The "New chat" overlay is mounted over the chat list and is the first screen a new user meets
  // after signing in, yet it has no route of its own — audit it before entering a conversation.
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  // V6: "new chat" is the floating action button over the list (it used to be a header icon titled
  // "Новый чат"). The empty-state fallback exists only for a fresh account, and it is
  // present-but-hidden otherwise, so it must be filtered by visibility.
  const newChatBtn = await page.$('.gc-chats .gc-fab:visible, .gc-chats-empty .gc-btn-accent:visible');
  if (newChatBtn) {
    await newChatBtn.click({ timeout: 5000 });
    await page.waitForTimeout(700);
    const measured = await page.evaluate(MEASURE);
    measured.lowContrast = await verifyAgainstPixels(page, measured.lowContrast);
    await page.screenshot({ path: `${OUT}/${scheme}-newchat.png` });
    report[`${scheme}/newchat`] = { ...measured, errors: [...new Set(errors)] };
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  errors = [];
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const firstChat = await page.$('.gc-chat-row, [data-chat-id]');
  if (firstChat) {
    await firstChat.click();
    await page.waitForTimeout(1200);

    // The resting conversation — bubbles, header, composer — was never measured on its own: the
    // route audit stops at the chat list, and the transient panels below cover it while open.
    errors = [];
    const rest = await page.evaluate(MEASURE);
    rest.lowContrast = await verifyAgainstPixels(page, rest.lowContrast);
    await page.screenshot({ path: `${OUT}/${scheme}-chat.png` });
    report[`${scheme}/chat`] = { ...rest, errors: [...new Set(errors)] };

    // The message menu opens on long-press (touch) or right-click (mouse); Playwright's synthetic
    // pointer events satisfy bindLongPress, so dispatch a real press-and-hold on the first bubble.
    errors = [];
    const bubble = await page.$('.gc-bubble-row, .gc-bubble');
    if (bubble) {
      const box = await bubble.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(750);
        await page.mouse.up();
        await page.waitForTimeout(500);
      }
      if (!(await page.$('.gc-msgmenu-layer'))) {
        await bubble.click({ button: 'right' });
        await page.waitForTimeout(500);
      }
      if (await page.$('.gc-msgmenu-layer')) {
        const measured = await page.evaluate(MEASURE);
        measured.lowContrast = await verifyAgainstPixels(page, measured.lowContrast);
        await page.screenshot({ path: `${OUT}/${scheme}-chat-msgmenu.png` });
        report[`${scheme}/chat:msgmenu`] = { ...measured, errors: [...new Set(errors)] };
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      } else {
        report[`${scheme}/chat:msgmenu`] = { missing: 'long-press did not open .gc-msgmenu-layer', lowContrast: [], smallTargets: [], ghostHidden: [], overflow: [], errors: [] };
      }
    }

    for (const [name, selector] of surfaces) {
      errors = [];
      const opener = await page.$(selector);
      if (!opener) { report[`${scheme}/chat:${name}`] = { missing: selector, lowContrast: [], smallTargets: [], ghostHidden: [], overflow: [], errors: [] }; continue; }
      await opener.click();
      await page.waitForTimeout(600);
      const measured = await page.evaluate(MEASURE);
      measured.lowContrast = await verifyAgainstPixels(page, measured.lowContrast);
      await page.screenshot({ path: `${OUT}/${scheme}-chat-${name}.png` });
      report[`${scheme}/chat:${name}`] = { ...measured, errors: [...new Set(errors)] };
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  }
  await browser.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

let findings = 0;
for (const [route, r] of Object.entries(report)) {
  const parts = [];
  for (const field of ['lowContrast', 'smallTargets', 'ghostHidden', 'overflow', 'errors']) {
    if (r[field]?.length) { parts.push(`${field}=${r[field].length}`); findings += r[field].length; }
  }
  console.log(route.padEnd(18), parts.join(' ') || 'clean');
}
console.log(`\n${findings} finding(s) → ${OUT}/report.json`);
if (flag('strict') && findings) process.exit(1);
