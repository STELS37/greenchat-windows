// Guard for the icon registry. Two defect classes shipped from here before:
//   * a transport control drawn as a bare text character ("▶", "❚❚", "✕") because the registry had
//     no filled-glyph support at all;
//   * an icon whose only geometry was a zero-length stroked segment ("M5 12h.01" x3 for "more"),
//     which renders as a 1.8 px speck next to 24 px outline glyphs.
// Both are invisible to type-checking, so every registered name is rendered here and asserted to
// produce real drawable geometry with a coherent fill/stroke pairing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, type StubNode } from "./dom_stub.ts";

installDomStub();
const { icon, ICON_NAMES } = await import("../src/icons.ts");

const DRAWABLE = new Set(["path", "circle", "rect", "polyline"]);

test("every registered icon renders drawable geometry", () => {
  assert.ok(ICON_NAMES.length > 0, "registry must not be empty");
  for (const name of ICON_NAMES) {
    const svg = icon(name) as unknown as StubNode;
    const shapes = svg.children.filter((c) => DRAWABLE.has(c.tag));
    assert.ok(shapes.length > 0, `icon "${name}" renders no shape`);
    assert.equal(svg.attrs["viewBox"], "0 0 24 24", `icon "${name}" lost its viewBox`);
  }
});

test("a filled icon paints with fill and never with stroke, and vice versa", () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name) as unknown as StubNode;
    const fill = svg.attrs["fill"];
    const stroke = svg.attrs["stroke"];
    // Exactly one of the two paint sources is active; a glyph with neither is invisible and a glyph
    // with both double-draws its outline.
    const filled = fill === "currentColor";
    assert.equal(filled ? stroke : fill, "none", `icon "${name}" paints with both fill and stroke`);
    assert.equal(filled ? fill : stroke, "currentColor", `icon "${name}" has no paint source`);
  }
});

test("stroked icons carry no zero-length path segments", () => {
  // "h.01" / "v.01" degenerate segments depend on stroke-linecap to be visible at all and always
  // render at stroke width; a dot must be a real circle so it scales with the glyph.
  for (const name of ICON_NAMES) {
    const svg = icon(name) as unknown as StubNode;
    for (const shape of svg.children) {
      if (shape.tag !== "path") continue;
      const d = shape.attrs["d"] ?? "";
      assert.ok(!/[hv]\s*\.0\d/i.test(d), `icon "${name}" draws a dot as a zero-length segment: ${d}`);
    }
  }
});

test("the accessible wrapper hides the glyph from assistive tech", () => {
  const svg = icon("send") as unknown as StubNode;
  assert.equal(svg.attrs["aria-hidden"], "true");
  assert.equal(svg.attrs["focusable"], "false");
  assert.equal(svg.attrs["class"], "gc-icon");
  const custom = icon("send", "gc-icon gc-voice-glyph") as unknown as StubNode;
  assert.equal(custom.attrs["class"], "gc-icon gc-voice-glyph");
});

test("attachment controls use one canonical diagonal paperclip", () => {
  const pathData = (name: "paperclip" | "attach"): string => {
    const svg = icon(name) as unknown as StubNode;
    const path = svg.children.find((child) => child.tag === "path");
    assert.ok(path, `icon "${name}" must contain a path`);
    return path.attrs["d"] ?? "";
  };

  const canonical = "M13.234 20.252 21 12.3A6 6 0 0 0 12.51 3.81l-8.235 8.235a4 4 0 0 0 5.657 5.657l7.52-7.52a2 2 0 0 0-2.83-2.828l-7.52 7.52";
  assert.equal(pathData("attach"), canonical, "the composer icon must remain a recognisable diagonal open paperclip");
  assert.equal(pathData("paperclip"), canonical, "generic and composer attachment glyphs must not diverge");
  assert.doesNotMatch(canonical, /^M12 21V7/, "the former upright three-loop glyph looked like a chain, not a paperclip");
});
