// Product-boundary regression: the ordinary messenger journey must not expose infrastructure
// or finance configuration. Android safe-area values are supplied by the native shell because
// SDK 35+ edge-to-edge cannot be trusted to populate CSS env() on every OEM WebView.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, "..");
const clients = join(ui, "..");
const auth = readFileSync(join(ui, "src", "screens", "auth_screen.ts"), "utf8");
const app = readFileSync(join(ui, "src", "screens", "app.ts"), "utf8");
const main = readFileSync(join(clients, "web", "src", "main.ts"), "utf8");
const tokens = readFileSync(join(ui, "src", "tokens.css"), "utf8");
const bridge = readFileSync(join(clients, "mobile", "bridge", "index.ts"), "utf8");
const activity = readFileSync(
  join(clients, "mobile", "android", "app", "src", "main", "java", "app", "greenchat", "MainActivity.java"),
  "utf8",
);
const systemChrome = readFileSync(
  join(clients, "mobile", "android", "app", "src", "main", "java", "app", "greenchat", "SystemChromePlugin.kt"),
  "utf8",
);

test("ordinary auth has no server selector and the normal command palette does not advertise infrastructure", () => {
  assert.doesNotMatch(auth, /onChangeServer|gc-auth-server|server\.change/);
  assert.doesNotMatch(app, /onChangeServer/);
  assert.doesNotMatch(main, /id: "go-server"/);
});

test("sign-in does not automatically start display-currency or other finance onboarding", () => {
  assert.doesNotMatch(main, /maybeSuggestCurrency/);
  assert.doesNotMatch(main, /currencySuggestStarted|runCurrencySuggest|CURRENCY_SUGGESTED_KEY/);
});

test("Android 15 and 16 expose real system-bar insets to the shared V3 token layer", () => {
  assert.match(activity, /registerPlugin\(SystemChromePlugin\.class\)/);
  assert.match(systemChrome, /@CapacitorPlugin\(name = "SystemChrome"\)/);
  assert.match(systemChrome, /WindowInsetsCompat\.Type\.systemBars\(\)/);
  assert.match(systemChrome, /WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(bridge, /--gc-native-safe-top/);
  assert.match(bridge, /SystemChrome\.getInsets\(\)/);
  assert.match(tokens, /--gc-safe-top:\s*max\(env\(safe-area-inset-top, 0px\), var\(--gc-native-safe-top\)\)/);
  assert.match(tokens, /--gc-safe-bottom:\s*max\(env\(safe-area-inset-bottom, 0px\), var\(--gc-native-safe-bottom\)\)/);
});
