import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isIos,
  isIosSafari,
  isInstalled,
  shouldPromptIosInstall,
  parseShareParams,
  hasShare,
  shareToText,
  badgeCount,
} from "../src/pwa_model.ts";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const MAC_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15";

test("isIos: iPhone UA and iPadOS desktop-mode (Macintosh + touch)", () => {
  assert.equal(isIos(IPHONE), true);
  assert.equal(isIos(IPAD_DESKTOP, 5), true); // iPadOS masquerades as Mac but has touch
  assert.equal(isIos(MAC_DESKTOP, 0), false); // real Mac: no touch
  assert.equal(isIos(ANDROID), false);
});

test("isIosSafari: excludes WebKit-wrapped iOS browsers", () => {
  assert.equal(isIosSafari(IPHONE), true);
  assert.equal(isIosSafari(CHROME_IOS), false); // CriOS cannot A2HS a push PWA
  assert.equal(isIosSafari(ANDROID), false);
});

test("isInstalled: display-mode standalone or navigator.standalone", () => {
  assert.equal(isInstalled({ displayStandalone: true }), true);
  assert.equal(isInstalled({ displayStandalone: false, navigatorStandalone: true }), true);
  assert.equal(isInstalled({ displayStandalone: false }), false);
  assert.equal(isInstalled({ displayStandalone: false, navigatorStandalone: false }), false);
});

test("shouldPromptIosInstall: only iOS Safari, not installed, not dismissed", () => {
  const base = { ua: IPHONE, displayStandalone: false, dismissed: false };
  assert.equal(shouldPromptIosInstall(base), true);
  assert.equal(shouldPromptIosInstall({ ...base, dismissed: true }), false);
  assert.equal(shouldPromptIosInstall({ ...base, displayStandalone: true }), false);
  assert.equal(shouldPromptIosInstall({ ...base, navigatorStandalone: true }), false);
  assert.equal(shouldPromptIosInstall({ ...base, ua: CHROME_IOS }), false);
  assert.equal(shouldPromptIosInstall({ ...base, ua: ANDROID }), false);
  assert.equal(
    shouldPromptIosInstall({ ua: IPAD_DESKTOP, maxTouchPoints: 5, displayStandalone: false, dismissed: false }),
    true,
  );
});

test("parseShareParams: extracts non-blank title/text/url, tolerates leading ?", () => {
  assert.deepEqual(parseShareParams("?title=Hi&text=Body&url=https%3A%2F%2Fa.b"), {
    title: "Hi",
    text: "Body",
    url: "https://a.b",
  });
  assert.deepEqual(parseShareParams("title=Only"), { title: "Only" });
  assert.deepEqual(parseShareParams("?text=%20%20"), {}); // whitespace-only dropped
  assert.deepEqual(parseShareParams(""), {});
  assert.deepEqual(parseShareParams("?foo=bar"), {}); // unrelated params ignored
});

test("hasShare: true when any field present", () => {
  assert.equal(hasShare({ title: "x" }), true);
  assert.equal(hasShare({ url: "https://a" }), true);
  assert.equal(hasShare({}), false);
});

test("shareToText: joins title/text/url, drops url duplicated in text", () => {
  assert.equal(shareToText({ title: "T", text: "B", url: "https://a.b" }), "T\nB\nhttps://a.b");
  assert.equal(shareToText({ text: "see https://a.b now", url: "https://a.b" }), "see https://a.b now");
  assert.equal(shareToText({ url: "https://a.b" }), "https://a.b");
  assert.equal(shareToText({}), "");
});

test("badgeCount: floors positives, clamps invalid/negative to 0", () => {
  assert.equal(badgeCount(5), 5);
  assert.equal(badgeCount(5.9), 5);
  assert.equal(badgeCount(0), 0);
  assert.equal(badgeCount(-3), 0);
  assert.equal(badgeCount(Number.NaN), 0);
  assert.equal(badgeCount(Number.POSITIVE_INFINITY), 0);
});
