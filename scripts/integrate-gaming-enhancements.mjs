// SPDX-License-Identifier: AGPL-3.0-or-later
// Integrates the reviewed enhancement payload into the inspected public Windows export.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

const APP = "clients/ui/src/screens/app.ts";
const BASE_BLOB = "e0d6f0be15f8907e2efcde6bcf85d8beb4f9470e";
const payload = {
  "clients/ui/src/enhancements/interface_enhancements.ts": [
    "scripts/gaming-enhancements-payload/interface.1.b64",
    "scripts/gaming-enhancements-payload/interface.2.b64",
    "scripts/gaming-enhancements-payload/interface.3.b64",
  ],
  "clients/ui/src/enhancements/styles.css": [
    "scripts/gaming-enhancements-payload/styles.1.b64",
    "scripts/gaming-enhancements-payload/styles.2.b64",
  ],
};
const blobSha = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const once = (source, oldText, newText) => {
  const at = source.indexOf(oldText);
  if (at < 0 || source.indexOf(oldText, at + oldText.length) >= 0) throw new Error(`Expected exactly one anchor: ${oldText.slice(0, 96)}`);
  return source.slice(0, at) + newText + source.slice(at + oldText.length);
};
const exists = async (path) => {
  try { await stat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
};
async function decode(parts) {
  let encoded = "";
  for (const part of parts) encoded += (await readFile(part, "utf8")).trim();
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}
function transformApp(source) {
  if (source.includes('createInterfaceEnhancements') && source.includes('gameConnections?: GameConnectionsPort')) return source;
  if (blobSha(source) !== BASE_BLOB) throw new Error("STOP: app.ts differs from inspected export; reconcile instead of forcing");
  let text = source;
  text = once(text, 'import type { I18n } from "../i18n.ts";',
    'import "../enhancements/styles.css";\nimport { createInterfaceEnhancements } from "../enhancements/interface_enhancements.ts";\nimport type { GameConnectionsPort } from "../enhancements/connections.ts";\nimport type { I18n } from "../i18n.ts";');
  text = once(text, 'export interface AppDeps {\n',
    'export interface AppDeps {\n  // Optional, real server-auth adapter. Omit until the provider configuration is verified.\n  gameConnections?: GameConnectionsPort;\n');
  text = once(text, '  const { host, api, session, router, i18n, outbox, events } = deps;\n',
    '  const { host, api, session, router, i18n, outbox, events } = deps;\n' +
    '  let appStarted = false;\n  let appDestroyed = false;\n' +
    '  let stopRouteSubscription: (() => void) | null = null;\n' +
    '  let stopSessionSubscription: (() => void) | null = null;\n' +
    '  const interfaceEnhancements = createInterfaceEnhancements({\n' +
    '    host, locale: () => i18n.locale,\n' +
    '    ...(deps.gameConnections ? { connections: deps.gameConnections } : {}),\n  });\n');
  text = once(text, 'hub: { items: moreHubItems() },', 'hub: { items: [...moreHubItems(), interfaceEnhancements.hubItem()] },');
  text = once(text, '  const hardRoute = (): void => { currentKey = ""; route(); };',
    '  const hardRoute = (): void => {\n    if (appDestroyed) return;\n    interfaceEnhancements.closeOverlays();\n    currentKey = ""; route();\n  };');
  text = once(text, '  return {\n    start() {\n',
    '  return {\n    start() {\n      if (appStarted || appDestroyed) return;\n      appStarted = true;\n      interfaceEnhancements.start();\n');
  text = once(text, '      router.subscribe(() => route());',
    '      stopRouteSubscription = router.subscribe(() => {\n        interfaceEnhancements.closeOverlays();\n        route();\n      });');
  text = once(text, '      session.subscribe((user) => {', '      stopSessionSubscription = session.subscribe((user) => {');
  text = once(text, '    destroy() {\n      contourStopped = true;',
    '    destroy() {\n      if (appDestroyed) return;\n      appDestroyed = true;\n' +
    '      stopRouteSubscription?.();\n      stopRouteSubscription = null;\n' +
    '      stopSessionSubscription?.();\n      stopSessionSubscription = null;\n' +
    '      interfaceEnhancements.destroy();\n      contourStopped = true;');
  return text;
}

const app = await readFile(APP, "utf8");
const integrated = transformApp(app);
for (const [path, parts] of Object.entries(payload)) {
  const expected = await decode(parts);
  if (await exists(path)) {
    if (await readFile(path, "utf8") !== expected) throw new Error(`STOP: existing enhancement differs: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected, "utf8");
  }
}
if (integrated !== app) await writeFile(APP, integrated, "utf8");
console.log(JSON.stringify({ integrated: integrated !== app, generated: Object.keys(payload) }, null, 2));
