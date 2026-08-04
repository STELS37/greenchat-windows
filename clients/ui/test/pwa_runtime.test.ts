import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(here, "..", "src", "pwa.ts")).href;

for (const count of [5, 0]) {
  test(`browser PWA badging: async ${count > 0 ? "set" : "clear"} rejection is never unhandled`, () => {
    const script = `
      import { browserPwaEnv } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          setAppBadge() { return Promise.reject(new Error("set badge rejected")); },
          clearAppBadge() { return Promise.reject(new Error("clear badge rejected")); },
        },
      });
      browserPwaEnv().setBadge(${count});
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log("clean-exit");
    `;
    const child = spawnSync(
      process.execPath,
      ["--unhandled-rejections=strict", "--experimental-strip-types", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, `Badging API rejection must be absorbed:\n${child.stderr}`);
    assert.match(child.stdout, /clean-exit/);
  });
}

test("browser PWA explicitly checks for updates and absorbs update() failures", () => {
  const script = `
    import { browserPwaEnv } from ${JSON.stringify(moduleUrl)};
    let updates = 0;
    const listeners = new Map();
    const registration = {
      waiting: null,
      installing: null,
      addEventListener() {},
      update() { updates += 1; return Promise.reject(new Error("offline")); },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          controller: {},
          register: async () => registration,
          addEventListener() {},
        },
      },
    });
    globalThis.addEventListener = (name, cb) => listeners.set(name, cb);
    globalThis.setInterval = (cb) => { listeners.set("interval", cb); return 1; };
    await browserPwaEnv().registerSW("/sw.js");
    listeners.get("online")?.();
    listeners.get("interval")?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (updates !== 3) throw new Error("expected 3 explicit update checks, got " + updates);
    console.log("clean-exit");
  `;
  const child = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "--experimental-strip-types", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, `SW update rejection must be absorbed:\n${child.stderr}`);
  assert.match(child.stdout, /clean-exit/);
});
