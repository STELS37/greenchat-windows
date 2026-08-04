import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./desktop/check.sh", import.meta.url), "utf8");

test("desktop gate requires rustup stable and never falls back to system cargo", () => {
  assert.match(script, /\[ ! -x "\$RUSTUP" \]/);
  assert.match(script, /"\$RUSTUP" run stable rustc --version/);
  assert.match(script, /"\$RUSTUP" run stable cargo check --quiet/);
  assert.match(script, /"\$RUSTUP" run stable cargo test --quiet/);
  assert.doesNotMatch(script, /(?:^|\n)\s*cargo (?:check|test|--version)/);
  assert.doesNotMatch(script, /export PATH=.*\.cargo\/bin/);
});
