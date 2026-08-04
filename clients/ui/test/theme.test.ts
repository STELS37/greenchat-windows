import { test } from "node:test";
import assert from "node:assert/strict";
import { ThemeController, resolveTheme, clampFontScale } from "../src/theme.ts";
import type { ThemeEnv, ThemeState } from "../src/theme.ts";

test("resolveTheme: preference vs system", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("clampFontScale: bounds and NaN guard", () => {
  assert.equal(clampFontScale(0.5), 0.8);
  assert.equal(clampFontScale(2), 1.4);
  assert.equal(clampFontScale(1.1), 1.1);
  assert.equal(clampFontScale(Number.NaN), 1);
});

interface Harness {
  env: ThemeEnv;
  attrs: Record<string, string>;
  props: Record<string, string>;
  setDark(d: boolean): void;
  fireSystem(): void;
  getSaved(): Pick<ThemeState, "pref" | "density" | "fontScale"> | null;
}

type Saved = Pick<ThemeState, "pref" | "density" | "fontScale">;

function fakeThemeEnv(opts?: { dark?: boolean; saved?: Saved }): Harness {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  let dark = opts?.dark ?? false;
  let systemCb: (() => void) | null = null;
  let saved: Saved | null = opts?.saved ?? null;
  const env: ThemeEnv = {
    root: {
      setAttribute: (n, v) => { attrs[n] = v; },
      style: { setProperty: (n, v) => { props[n] = v; } },
    },
    prefersDark: () => dark,
    onSystemChange: (cb) => { systemCb = cb; return () => { systemCb = null; }; },
    load: () => saved,
    save: (s) => { saved = s; },
  };
  return {
    env, attrs, props,
    setDark: (d) => { dark = d; },
    fireSystem: () => systemCb?.(),
    getSaved: () => saved,
  };
}

test("ThemeController: apply writes root attributes", () => {
  const h = fakeThemeEnv({ dark: true });
  const c = new ThemeController(h.env);
  const st = c.apply();
  // Product default is "system": an OS in dark mode must be honoured without the user touching settings.
  assert.equal(st.pref, "system");
  assert.equal(st.effective, "dark");
  assert.equal(h.attrs["data-theme"], "dark");
  assert.equal(h.attrs["data-density"], "comfortable");
  assert.equal(h.props["--gc-font-scale"], "1");
});

test("ThemeController: setters resolve, clamp and persist", () => {
  const h = fakeThemeEnv({ dark: true });
  const c = new ThemeController(h.env);
  c.setPref("light");
  assert.equal(h.attrs["data-theme"], "light", "explicit light overrides dark system");
  assert.equal(h.getSaved()?.pref, "light");
  c.setDensity("compact");
  assert.equal(h.attrs["data-density"], "compact");
  c.setFontScale(9);
  assert.equal(h.props["--gc-font-scale"], "1.4", "font scale clamped to max");
  assert.equal(h.getSaved()?.fontScale, 1.4);
});

test("ThemeController: restores a saved preference on construction", () => {
  const h = fakeThemeEnv({ saved: { pref: "dark", density: "compact", fontScale: 1.2 } });
  const c = new ThemeController(h.env);
  const st = c.state;
  assert.equal(st.pref, "dark");
  assert.equal(st.density, "compact");
  assert.equal(st.fontScale, 1.2);
});

test("ThemeController: reapplies on a system change only when following system", () => {
  const h = fakeThemeEnv({ dark: false });
  const c = new ThemeController(h.env);
  c.apply();
  assert.equal(h.attrs["data-theme"], "light");
  h.setDark(true);
  h.fireSystem();
  assert.equal(h.attrs["data-theme"], "dark", "default pref=system follows the OS scheme");
  c.setPref("light");
  h.setDark(true);
  h.fireSystem();
  assert.equal(h.attrs["data-theme"], "light", "an explicit pref pins the theme against the OS");
  c.setPref("system");
  assert.equal(h.attrs["data-theme"], "dark", "pref=system resolves against the current OS scheme");
  h.setDark(false);
  h.fireSystem();
  assert.equal(h.attrs["data-theme"], "light", "system change repainted while pref=system");
});

test("ThemeController: subscribe fires on apply", () => {
  const h = fakeThemeEnv();
  const c = new ThemeController(h.env);
  let fired = 0;
  c.subscribe(() => { fired++; });
  c.apply();
  assert.equal(fired, 1);
});
