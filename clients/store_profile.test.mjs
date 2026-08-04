import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  filterStoreProfileSource,
  parseDistributionChannel,
  parseStoreProfile,
  parseWebSourceMaps,
  stripMessengerExcluded,
} from "./store_profile.mjs";

test("store profile is explicit and rejects unknown release surfaces", () => {
  assert.equal(parseStoreProfile(undefined), "development");
  assert.equal(parseStoreProfile(""), "development");
  assert.equal(parseStoreProfile("messenger"), "messenger");
  assert.throws(() => parseStoreProfile("payments"), /GC_STORE_PROFILE/);
});

test("web source maps are explicit so a public deploy can strip them", () => {
  assert.equal(parseWebSourceMaps(undefined), "external");
  assert.equal(parseWebSourceMaps(""), "external");
  assert.equal(parseWebSourceMaps("external"), "external");
  assert.equal(parseWebSourceMaps("none"), "none");
  assert.equal(parseWebSourceMaps(" NONE "), "none");
  assert.throws(() => parseWebSourceMaps("0"), /GC_WEB_SOURCEMAPS/);
  assert.throws(() => parseWebSourceMaps("inline"), /GC_WEB_SOURCEMAPS/);
});

test("messenger distribution channel is explicit and profile-bound", () => {
  assert.equal(
    parseDistributionChannel(undefined, "development"),
    "development",
  );
  assert.equal(
    parseDistributionChannel("messenger-direct-apk", "messenger"),
    "messenger-direct-apk",
  );
  assert.equal(
    parseDistributionChannel("messenger-store-managed", "messenger"),
    "messenger-store-managed",
  );
  assert.throws(
    () => parseDistributionChannel(undefined, "messenger"),
    /GC_DISTRIBUTION_CHANNEL.*explicit/i,
  );
  assert.throws(
    () => parseDistributionChannel("messenger-direct-apk", "development"),
    /development/i,
  );
  assert.throws(
    () => parseDistributionChannel("play", "messenger"),
    /GC_DISTRIBUTION_CHANNEL/i,
  );
});

test("messenger source filter removes complete marked blocks and fails closed on malformed markers", () => {
  const source = [
    "const safe = true;",
    "/* GC_MESSENGER_EXCLUDE_START */",
    "const forbidden = 'gcpay';",
    "/* GC_MESSENGER_EXCLUDE_END */",
    "export { safe };",
  ].join("\n");
  const stripped = stripMessengerExcluded(source, "fixture.ts");
  assert.match(stripped, /const safe = true/);
  assert.match(stripped, /export \{ safe \}/);
  assert.doesNotMatch(stripped, /gcpay|GC_MESSENGER_EXCLUDE/);
  assert.throws(
    () =>
      stripMessengerExcluded(
        "/* GC_MESSENGER_EXCLUDE_START */\nsecret",
        "broken.ts",
      ),
    /unclosed messenger exclusion/i,
  );
  assert.throws(
    () => stripMessengerExcluded("/* GC_MESSENGER_EXCLUDE_END */", "broken.ts"),
    /unexpected messenger exclusion/i,
  );
});

test("direct APK keeps only its update channel while store-managed strips it", () => {
  const source = [
    "const safe = true;",
    "/* GC_MESSENGER_EXCLUDE_START */",
    "const finance = 'gcpay';",
    "/* GC_MESSENGER_EXCLUDE_END */",
    "/* GC_MESSENGER_DIRECT_APK_ONLY_START */",
    "const updateEndpoint = '/v1/client/updates/android/universal';",
    "/* GC_MESSENGER_DIRECT_APK_ONLY_END */",
    "export { safe };",
  ].join("\n");

  const direct = filterStoreProfileSource(
    source,
    "messenger-direct-apk",
    "fixture.ts",
  );
  assert.match(direct, /updateEndpoint/);
  assert.doesNotMatch(direct, /finance|gcpay|GC_MESSENGER_/);

  const storeManaged = filterStoreProfileSource(
    source,
    "messenger-store-managed",
    "fixture.ts",
  );
  assert.doesNotMatch(
    storeManaged,
    /updateEndpoint|finance|gcpay|GC_MESSENGER_/,
  );
  assert.match(storeManaged, /const safe = true/);

  assert.throws(
    () =>
      filterStoreProfileSource(
        "/* GC_MESSENGER_DIRECT_APK_ONLY_START */\nconst update = true;",
        "messenger-direct-apk",
        "broken.ts",
      ),
    /unclosed.*direct APK/i,
  );
});

// B-P0-4 (owner directive 2026-07-31), measured on the signed direct APK of 01f9cc4d: the bundle
// still contained `window.__gcRuntimeConfig={features:{payments:!1}}` behind a runtime channel flag,
// so `verify-messenger-artifacts.mjs` reported `missing-payments_runtime_contract` for the superapp
// artifact. Behaviour was correct (the flag is false there), but the finance contour is an
// artifact-level contract, not a runtime flag.
// D-009 (owner directive 2026-08-02) removed the reason for this marker to exist: no channel gets
// LESS than the direct APK any more. The parser keeps handling it — fail-closed behaviour on
// malformed markers is worth keeping — but the marker is now pinned as UNUSED machinery, so the
// edition split cannot come back through it silently.
test("the direct-APK exclusion marker parses fail-closed and no shipped source uses it", () => {
  const source = [
    "const safe = true;",
    "// GC_MESSENGER_DIRECT_APK_EXCLUDE_START",
    "if (SUPPRESSED) config = { features: { payments: false } };",
    "// GC_MESSENGER_DIRECT_APK_EXCLUDE_END",
    "export { safe };",
  ].join("\n");

  const direct = filterStoreProfileSource(
    source,
    "messenger-direct-apk",
    "fixture.ts",
  );
  assert.doesNotMatch(direct, /payments: false|SUPPRESSED|GC_MESSENGER_/);
  assert.match(direct, /const safe = true/);

  for (const channel of ["messenger-store-managed", "messenger-test-apk"]) {
    const stripped = filterStoreProfileSource(source, channel, "fixture.ts");
    assert.match(
      stripped,
      /payments: false/,
      `${channel}: the marker must still remove the block from the direct APK only`,
    );
    assert.doesNotMatch(stripped, /GC_MESSENGER_/);
  }

  assert.throws(
    () =>
      filterStoreProfileSource(
        "// GC_MESSENGER_DIRECT_APK_EXCLUDE_START\nconst x = 1;",
        "messenger-direct-apk",
        "broken.ts",
      ),
    /unclosed.*direct APK exclusion/i,
  );
  assert.throws(
    () =>
      filterStoreProfileSource(
        "// GC_MESSENGER_DIRECT_APK_EXCLUDE_END",
        "messenger-store-managed",
        "broken.ts",
      ),
    /unexpected messenger direct APK exclusion end/i,
  );

  // The rule that actually protects D-009: the marker is machinery nobody may aim at a channel.
  // A fixture proves the parser works; this sweep proves nothing shipped is behind it.
  const swept = [];
  for (const root of ["core/src", "ui/src", "web/src", "mobile/bridge"]) {
    for (const entry of readdirSync(root, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/\.(?:ts|mts|mjs|js)$/.test(entry.name)) continue;
      if (entry.name.includes(".test.")) continue;
      const path = join(entry.parentPath ?? entry.path, entry.name);
      assert.doesNotMatch(
        readFileSync(path, "utf8"),
        /GC_MESSENGER_DIRECT_APK_EXCLUDE/,
        `${path}: D-009 forbids excluding shipped code from the canonical edition`,
      );
      swept.push(path);
    }
  }
  assert.ok(swept.length > 50, `the sweep must see real files, saw ${swept.length}`);
});

// The rule is only worth having if it holds on the real file that ships, not just on a fixture.
// D-009 (owner directive 2026-08-02, supersedes the chats-only half of D-008): one canonical edition
// carries everything, and the Play channel is tested on the real store build. The only differences
// that survive are the two the outside world forces: Play policy forbids an app distributed through
// Play from updating itself (T-413), and Firebase resources are bound to the direct APK identity.
// So no channel may suppress the finance contour any more.
test("real web entry: no edition suppresses the finance contour", () => {
  const source = readFileSync("web/src/main.ts", "utf8");
  for (const channel of [
    "messenger-direct-apk",
    "messenger-store-managed",
    "messenger-test-apk",
  ]) {
    const built = stripComments(
      filterStoreProfileSource(source, channel, "main.ts"),
    );
    assert.doesNotMatch(
      built,
      /features:\s*\{\s*payments:\s*false\s*\}/,
      `${channel} must not contain the finance suppression`,
    );
  }
});

test("real direct source graph retains T-413 while store-managed has no self-update surface", () => {
  const cases = [
    ["core/src/index.ts", /fetchUpdateStatus/],
    ["ui/src/index.ts", /presentUpdateStatus/],
    ["web/src/main.ts", /\/v1\/client\/updates|fetchUpdateStatus/],
    ["ui/src/locales/en.ts", /Update required/],
    ["ui/src/locales/ru.ts", /Нужно обновить приложение/],
    ["web/src/styles.css", /gc-update-force/],
  ];
  for (const [path, directCapability] of cases) {
    const source = readFileSync(path, "utf8");
    const direct = filterStoreProfileSource(
      source,
      "messenger-direct-apk",
      path,
    );
    const storeManaged = filterStoreProfileSource(
      source,
      "messenger-store-managed",
      path,
    );
    assert.match(
      direct,
      directCapability,
      `${path} must retain direct updates`,
    );
    assert.doesNotMatch(
      storeManaged,
      directCapability,
      `${path} must strip store-managed self-update`,
    );
  }

  // D-009: the finance deep link is no longer an edition marker — every channel resolves gcpay://
  // invoices, because every channel now ships the same superapp.
  const deepLinks = readFileSync("mobile/bridge/deeplink.ts", "utf8");
  for (const channel of [
    "messenger-direct-apk",
    "messenger-store-managed",
    "messenger-test-apk",
  ]) {
    assert.match(
      filterStoreProfileSource(deepLinks, channel, "deeplink.ts"),
      /gcpay/,
      `${channel} must resolve gcpay:// invoices`,
    );
  }
});

// D-009 (owner directive 2026-08-02): every channel ships the same shell. The gate stays, but it now
// fails the build when ANY channel loses a superapp destination, which is the amputation the owner
// ended: the Play edition must be testable on the real store channel with all features present.
test("every channel keeps the full superapp shell", () => {
  // V161: the guard is about DESTINATIONS SURVIVING A CHANNEL FILTER, not about which slot they sit
  // in. «Биржа» moved out of the five-slot tab bar (the wallet already opens it twice over) into the
  // «Ещё» hub, so app.ts no longer contains `section: "exchange"` — it contains the hub entry's
  // `route: "/exchange"`, which is what "the exchange still exists on this channel" actually means.
  // «Контакты» took the freed slot and joins the guarded set, so no channel may amputate it either.
  const shellSurfaces = [
    ["ui/src/router.ts", [/"\/wallet"/, /"\/exchange"/, /"\/calls"/, /"\/contacts"/]],
    [
      "ui/src/screens/app.ts",
      [/section: "wallet"/, /route: "\/exchange"/, /section: "calls"/, /section: "contacts"/],
    ],
  ];
  for (const [path, patterns] of shellSurfaces) {
    const source = readFileSync(path, "utf8");
    for (const channel of [
      "messenger-direct-apk",
      "messenger-store-managed",
      "messenger-test-apk",
    ]) {
      const built = filterStoreProfileSource(source, channel, path);
      for (const pattern of patterns) {
        assert.match(
          built,
          pattern,
          `${path}: ${channel} must keep ${pattern}`,
        );
      }
    }
  }
});

// V104: the shell test above only ever looked at the ROUTES (router.ts, app.ts). The store build was
// measured on device (signed AAB 8f3e8dbd) still drawing a handset and a camera in every dialog header
// and still answering inbound rings, because those come from the `calls` port and the body-level call
// overlay wired in web/src/main.ts, which no gate covered. With `call.*` stripped from the dictionary
// the surviving surfaces rendered raw keys. The composition root is now part of the contract.
test("every channel wires the calling subsystem at its composition root", () => {
  const path = "web/src/main.ts";
  const source = readFileSync(path, "utf8");
  const callSurfaces = [
    /\bCallController\b/,
    /\bcreateCallOverlay\b/,
    /\bcreateBrowserCallMedia\b/,
    /\bIceServer\b/,
    /callController\.place\(/,
    /\/v1\/calls\/config/,
  ];
  for (const channel of [
    "messenger-direct-apk",
    "messenger-store-managed",
    "messenger-test-apk",
  ]) {
    const built = filterStoreProfileSource(source, channel, path);
    for (const pattern of patternsWithPort(callSurfaces)) {
      assert.match(built, pattern, `${path}: ${channel} must keep ${pattern}`);
    }
  }
});

// V104 measured the opposite failure (a store bundle that still drew call buttons after the port was
// stripped), so the port itself stays part of the contract — now as something every channel must pass.
function patternsWithPort(surfaces) {
  return [...surfaces, /calls:\s*\{/];
}

test("public help and account-deletion routes are packaged client assets", () => {
  for (const route of ["help", "account-deletion"]) {
    const html = readFileSync(
      join("web", "public", route, "index.html"),
      "utf8",
    );
    assert.match(html, /Green Chat/);
    assert.match(html, /mailto:/);
  }
  const deletion = readFileSync(
    join("web", "public", "account-deletion", "index.html"),
    "utf8",
  );
  assert.match(deletion, /Settings|Настройки/);
  assert.match(deletion, /delete|удал/i);
});

// B-P0-4: every gate above reads ROUTES and COMPOSITION ROOTS, so a money string that lives only in
// the dictionary passed all of them. Measured on the signed store AAB of 44bc9def and 4843c431:
// `payment PIN` was found by a plain search inside base/assets/public/assets/app.*.js, and
// verify-messenger-artifacts reported the AAB content violation `finance-surface`. The Play edition
// carries no wallet, no exchange and no envelopes, so it must not carry their texts either. The
// dictionary is now part of the contract, and `errors.TWOFA_REQUIRED` is the deliberate exception:
// server/src/modules/auth.ts raises it on two-factor sign-in, which the chats-only edition supports.
test("every channel keeps the money-contour dictionary", () => {
  // D-009: what B-P0-4 measured as a leak (money strings inside the store bundle) is now the required
  // state — the Play edition ships the same wallet, exchange, cards and invoice surfaces, so it must
  // ship their texts too or the surviving screens would render raw keys.
  const required = [
    ["finance-surface", /"finance\.paymentPin"/],
    ["wallet", /"finance\.wallet/],
    ["exchange", /"finance\.exchange/],
    ["calls", /"call\./],
    ["money-errors", /errors\.PIN_REQUIRED/],
    ["twofa", /errors\.TWOFA_REQUIRED/],
  ];
  for (const path of ["ui/src/locales/ru.ts", "ui/src/locales/en.ts"]) {
    const source = readFileSync(path, "utf8");
    for (const channel of [
      "messenger-direct-apk",
      "messenger-store-managed",
      "messenger-test-apk",
    ]) {
      const dictionary = stripComments(
        filterStoreProfileSource(source, channel, path),
      );
      for (const [id, pattern] of required) {
        assert.match(
          dictionary,
          pattern,
          `${path}: ${channel} must keep ${id}`,
        );
      }
    }
  }
});

// Comments never reach a bundle (esbuild drops them), so a rule that scans source text would fail on
// the very comment that documents the rule. The gate measures what ships, not what is written about it.
function stripComments(source) {
  return source.replace(/^[ \t]*\/\/.*$/gm, "");
}
