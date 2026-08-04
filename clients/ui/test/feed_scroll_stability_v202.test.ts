// Regression for the report from 2026-08-04: typing or receiving a message could make the mounted
// conversation jump to the top. The browser/IME scroll is synthetic, so it must not clear tail intent;
// a real wheel/touch/key gesture still owns the reader's history position.

import test from "node:test";
import assert from "node:assert/strict";

import {
  installFeedScrollStability,
  type FeedScrollStabilityEnv,
} from "../src/screens/feed_scroll_stability.ts";
import { dispatchDocument, installDomStub, type StubNode } from "./dom_stub.ts";

installDomStub();

class StabilityHarness {
  private clock = 0;
  private nextFrame = 1;
  private readonly frames = new Map<number, () => void>();
  private mutationCallback: (() => void) | null = null;
  private resizeCallback: (() => void) | null = null;

  readonly env: FeedScrollStabilityEnv = {
    now: () => this.clock,
    requestFrame: (callback) => {
      const id = this.nextFrame++;
      this.frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => { this.frames.delete(id); },
    createMutationObserver: (callback) => {
      this.mutationCallback = callback;
      return { observe() {}, disconnect: () => { this.mutationCallback = null; } };
    },
    createResizeObserver: (callback) => {
      this.resizeCallback = callback;
      return { observe() {}, disconnect: () => { this.resizeCallback = null; } };
    },
  };

  flushFrames(): void {
    let rounds = 0;
    while (this.frames.size > 0) {
      assert.ok(rounds++ < 20, "scroll stability scheduled an endless frame loop");
      const batch = [...this.frames.values()];
      this.frames.clear();
      for (const callback of batch) callback();
    }
  }

  mutate(): void { this.mutationCallback?.(); }
  resize(): void { this.resizeCallback?.(); }
  advance(ms: number): void { this.clock += ms; }
}

function fixture(): {
  root: StubNode;
  list: StubNode;
  input: StubNode;
  harness: StabilityHarness;
  controller: ReturnType<typeof installFeedScrollStability>;
} {
  const root = document.createElement("section") as unknown as StubNode;
  const list = document.createElement("div") as unknown as StubNode;
  const input = document.createElement("textarea") as unknown as StubNode;
  list.setAttribute("class", "gc-feed-list");
  input.setAttribute("class", "gc-composer-input");
  root.append(list, input);
  list.clientHeight = 200;
  list.scrollHeight = 1_000;
  list.scrollTop = 800;
  const harness = new StabilityHarness();
  const controller = installFeedScrollStability(root as unknown as HTMLElement, harness.env);
  harness.flushFrames();
  return { root, list, input, harness, controller };
}

test("a browser or IME stable scroll cannot throw a tail-pinned conversation to the top", (t) => {
  const { list, harness, controller } = fixture();
  t.after(() => controller.destroy());

  // This is the exact platform event shape that caused the bug: offset changed, geometry did not,
  // and no wheel/pointer/key event preceded it. The old feed handler read it as reader intent.
  list.scrollTop = 0;
  list.dispatch("scroll");
  harness.flushFrames();

  assert.equal(list.scrollTop, 800, "synthetic focused-element scrolling is healed to the live tail");
});

test("an incoming-message mutation heals the synthetic offset against the new content height", (t) => {
  const { list, harness, controller } = fixture();
  t.after(() => controller.destroy());

  list.scrollTop = 0;
  list.dispatch("scroll");
  list.scrollHeight = 1_100;
  harness.mutate();
  harness.flushFrames();

  assert.equal(list.scrollTop, 900);
  assert.equal(list.scrollHeight - list.scrollTop - list.clientHeight, 0);
});

test("a real wheel or touch gesture keeps the reader in history when a message arrives", (t) => {
  const { list, harness, controller } = fixture();
  t.after(() => controller.destroy());

  list.dispatch("wheel");
  list.scrollTop = 420;
  list.dispatch("scroll");
  harness.advance(2_000);
  list.scrollHeight = 1_100;
  harness.mutate();
  harness.resize();
  harness.flushFrames();

  assert.equal(list.scrollTop, 420, "incoming messages must not yank a deliberate history reader");
});

test("typing re-pins the live tail but never yanks a reader who explicitly scrolled up", (t) => {
  const first = fixture();
  t.after(() => first.controller.destroy());
  first.list.scrollHeight = 1_100;
  first.input.dispatch("input");
  first.harness.flushFrames();
  assert.equal(first.list.scrollTop, 900, "composer growth keeps the latest bubble above the composer");

  const second = fixture();
  t.after(() => second.controller.destroy());
  second.list.dispatch("pointerdown");
  second.list.scrollTop = 500;
  second.list.dispatch("scroll");
  dispatchDocument("pointerup");
  second.harness.advance(2_000);
  second.input.dispatch("input");
  second.harness.resize();
  second.harness.flushFrames();
  assert.equal(second.list.scrollTop, 500);
});

test("an explicit deep-link navigation is not undone by the tail guard", (t) => {
  const { list, harness, controller } = fixture();
  t.after(() => controller.destroy());

  controller.allowNavigation(() => {
    list.scrollTop = 250;
    list.dispatch("scroll");
  });
  list.scrollHeight = 1_100;
  harness.resize();
  harness.flushFrames();

  assert.equal(list.scrollTop, 250);
});
