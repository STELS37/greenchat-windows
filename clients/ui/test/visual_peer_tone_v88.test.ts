// clients/ui/test/visual_peer_tone_v88.test.ts — V88: a peer's colour must survive onto the call screen.
//
// Evidence that produced this layer (2026-07-30, stand 127.0.0.1:8992, 390x844): the call screen wrote
// `class="gc-callscreen-avatar gc-avatar-tone-1"`, and `gc-avatar-tone-` matched ZERO rules in
// clients/web/src/redesign.css and clients/web/src/styles.css combined. The 116px disc therefore fell
// back to `rgba(255,255,255,.16)` — a translucent white circle on the green call gradient. The screen
// that is entirely about one person was the only screen where that person had no colour.
//
// Two rules are guarded here, both structural rather than pixel-level:
//   1. peer colour is carried by the `data-tone` ATTRIBUTE — the single mechanism the palette paints;
//   2. a class-shaped tone name (`gc-avatar-tone-*`) is banned outright, because it fails silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { avatarTone } from "../src/screens/message_menu.ts";
import { peerToneSeed } from "../src/screens/call_overlay.ts";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const redesign = read("../../web/src/redesign.css");
const legacy = read("../../web/src/styles.css");

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
};
const srcRoot = new URL("../src", import.meta.url).pathname;

// Prose may name the banned pattern — that is how the reason survives. Only live code is judged.
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("V88: no component invents a tone CLASS — that name paints nothing", () => {
  const offenders = walk(srcRoot).filter((f) => /gc-avatar-tone-/.test(code(readFileSync(f, "utf8"))));
  assert.deepEqual(
    offenders,
    [],
    "gc-avatar-tone-* has no rule in either stylesheet; a peer tone is an attribute, not a class",
  );
  assert.equal(/gc-avatar-tone-/.test(code(redesign) + code(legacy)), false, "and no stylesheet may resurrect it");
});

test("V88: the call screen disc carries the peer tone", () => {
  const overlay = readFileSync(join(srcRoot, "screens/call_overlay.ts"), "utf8");
  const disc = /gc-callscreen-avatar"[^)]*?"data-tone":\s*String\(avatarTone\(/s.test(overlay);
  assert.ok(disc, "the call avatar must be built with data-tone=avatarTone(peer)");
});

test("V88: one person is ONE colour — the call screen seeds the tone the way every list does", () => {
  // Measured before the fix (m_calltone_v88.mjs): the same peer was tone 6 in the call log and tone 1
  // on the call screen, because the screen hashed the peer *id* while every list hashes the displayed
  // name. Two colours for one person is worse than no colour: it reads as two different people.
  const peer = { id: "u_7f3ac0", name: "Пётр Смирнов" };
  assert.equal(avatarTone(peerToneSeed(peer, "?")), avatarTone(peer.name), "call screen must match the list");
  assert.notEqual(avatarTone(peer.id), avatarTone(peer.name), "the ids and names really do hash apart — hence the bug");

  // A caller we cannot name still gets a stable colour rather than everyone sharing one disc.
  assert.equal(peerToneSeed({ id: "u_9", name: "   " }, "fallback"), "u_9");
  assert.equal(peerToneSeed(null, "Неизвестный"), "Неизвестный");
});

test("V88: the palette is a class-agnostic token, and the call disc opts in to painting it", () => {
  // The eight declarations set a variable only — harmless on any element, reusable by any component.
  const declared = [...redesign.matchAll(/(?:^|\n)\[data-tone="(\d)"\]\s*\{\s*--gc-tone-bg:/g)].map((m) => Number(m[1]));
  assert.deepEqual(declared, [0, 1, 2, 3, 4, 5, 6, 7], "exactly eight tone tokens, declared once");

  const paints = /\.gc-callscreen-avatar\[data-tone\]\s*\{[^}]*background:\s*var\(--gc-tone-bg/s.test(redesign);
  assert.ok(paints, "the call disc must actually paint the token, not merely receive it");

  // The disc is a lifted object on the call screen: the shared reset drops box-shadow, so the call
  // rule has to restate it or the avatar goes flat the moment a tone appears.
  const lifted = /\.gc-callscreen-avatar\[data-tone\]\s*\{[^}]*box-shadow:\s*0 22px 60px/s.test(redesign);
  assert.ok(lifted, "a toned call disc must keep its elevation");
});
