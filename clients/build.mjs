// T-401: web client build. esbuild bundles web/src/main.ts into a content-hashed JS + CSS pair, copies
// static public assets, and templates web/index.html with the real hashed asset URLs. Output → web/dist,
// which the server serves on GET / (index.html no-store; /assets/* immutable 1 year; SPA-fallback).
//
// This file is a dev-time build tool. It uses esbuild (a client dev-dependency) and never runs on the
// server — the server serves the already-built static output. Node's own APIs only; no server runtime dep.
import { build } from "esbuild";
import { readFile, writeFile, rename, rm, mkdir, cp, stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import { execFileSync } from "node:child_process";
import {
  collectStaticOutputs,
  outputDependency,
  WEB_SPLIT_OPTIONS,
} from "./build_helpers.mjs";
import {
  buildNativeUpdateManifest,
  canonicalJson,
  materializePublicDownloads,
} from "../scripts/lib/client-release.mjs";
import { resolveConfigSignaturePin } from "./config_signature_pin.mjs";
import {
  createWebBuildAttestation,
  npmPackageNameFromEsbuildInput,
  WEB_BUILD_ATTESTATION_FILE,
} from "./build_attestation.mjs";
import {
  messengerSourceFilterPlugin,
  parseDistributionChannel,
  parseStoreProfile,
  parseWebSourceMaps,
} from "./store_profile.mjs";
import { deriveMessengerReleaseIdentity } from "./release_identity.mjs";
import { assertBuildTargetsOutsideLiveTree } from "./live_tree_guard.mjs";
import { assertNoTelegramWebSecrets } from "./scripts/check-telegram-web-secrets.mjs";

import { productionGzip, productionGzipLength } from "./build_compression.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const webDir = join(root, "web");
// Production deploy builds into a private staging directory, then swaps it under the ops lock. Ordinary
// development/CI keeps the historical clients/web/dist location.
const outDir = resolve(process.env.GC_WEB_OUT_DIR?.trim() || join(webDir, "dist"));
const assetsDir = join(outDir, "assets");
const publicDir = join(webDir, "public");
const storeProfile = parseStoreProfile(process.env.GC_STORE_PROFILE);
const distributionChannel = parseDistributionChannel(
  process.env.GC_DISTRIBUTION_CHANNEL,
  storeProfile,
);
const messengerOnly = storeProfile === "messenger";
const webSourceMaps = parseWebSourceMaps(process.env.GC_WEB_SOURCEMAPS);
const sourceMapsEnabled = !messengerOnly && webSourceMaps === "external";
const profilePlugins = messengerOnly
  ? [
      messengerSourceFilterPlugin({
        roots: [root],
        distributionChannel,
      }),
    ]
  : [];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function distRelative(outputPath) {
  const rel = relative(outDir, resolve(root, outputPath)).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../")) {
    throw new Error(`build output is outside the configured web output directory: ${outputPath}`);
  }
  return rel;
}

function sourceBuildId() {
  const supplied = process.env.GC_BUILD_ID?.trim();
  if (messengerOnly) {
    return deriveMessengerReleaseIdentity({
      releaseRoot: root,
      suppliedBuildId: supplied,
      suppliedManifestSha256:
        process.env.GC_SOURCE_MANIFEST_SHA256?.trim(),
    }).buildId;
  }
  let id = supplied;
  if (!id) {
    try {
      id = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
      }).trim();
      if (dirty) id += "-dirty";
    } catch {
      id = "dev-local";
    }
  }
  if (!/^[A-Za-z0-9._-]{7,48}$/.test(id)) {
    throw new Error("GC_BUILD_ID must be 7..48 chars of A-Z, a-z, 0-9, dot, underscore or hyphen");
  }
  return id;
}

function formatMegabytes(bytes, locale) {
  const value = Number(bytes) / 1_000_000;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${number} ${locale.startsWith("ru") ? "МБ" : "MB"}`;
}

function renderReleaseTemplate(html, downloads, locale, pageName) {
  const android = downloads.platforms.android;
  const windows = downloads.platforms.windows;
  const windowsAvailable = windows.status === "available";
  const linuxAppImage = downloads.platforms.linux.packages.appimage;
  const linuxDeb = downloads.platforms.linux.packages.deb;
  const linuxRpm = downloads.platforms.linux.packages.rpm;
  const values = {
    __GC_RELEASE_VERSION__: downloads.current_version,
    __GC_RELEASE_ANDROID_SIZE__: formatMegabytes(android.size_bytes, locale),
    __GC_RELEASE_ANDROID_URL__: android.url,
    __GC_RELEASE_ANDROID_SHA256__: android.sha256,
    __GC_RELEASE_ANDROID_MIN_OS__: android.min_os,
    ...(windowsAvailable ? {
      __GC_RELEASE_WINDOWS_SIZE__: formatMegabytes(windows.size_bytes, locale),
      __GC_RELEASE_WINDOWS_URL__: windows.url,
      __GC_RELEASE_WINDOWS_SHA256__: windows.sha256,
      __GC_RELEASE_WINDOWS_MIN_OS__: windows.min_os,
      __GC_RELEASE_WINDOWS_SIGNATURE_NOTE__: windows.signed === true
        ? (locale.startsWith("ru")
          ? "Установщик подписан цифровой подписью издателя Green Chat."
          : "The installer carries the Green Chat publisher signature.")
        : (locale.startsWith("ru")
          ? "Beta-установщик пока без цифровой подписи издателя. Windows может показать предупреждение «Неизвестный издатель»."
          : "This beta installer is not yet publisher-signed. Windows may show an Unknown publisher warning."),
    } : {}),
    __GC_RELEASE_LINUX_APPIMAGE_SIZE__: formatMegabytes(linuxAppImage.size_bytes, locale),
    __GC_RELEASE_LINUX_APPIMAGE_URL__: linuxAppImage.url,
    __GC_RELEASE_LINUX_APPIMAGE_SHA256__: linuxAppImage.sha256,
    __GC_RELEASE_LINUX_DEB_SIZE__: formatMegabytes(linuxDeb.size_bytes, locale),
    __GC_RELEASE_LINUX_DEB_URL__: linuxDeb.url,
    __GC_RELEASE_LINUX_DEB_SHA256__: linuxDeb.sha256,
    ...(linuxRpm ? {
      __GC_RELEASE_LINUX_RPM_SIZE__: formatMegabytes(linuxRpm.size_bytes, locale),
      __GC_RELEASE_LINUX_RPM_URL__: linuxRpm.url,
      __GC_RELEASE_LINUX_RPM_SHA256__: linuxRpm.sha256,
    } : {}),
  };
  const rpmBlock = /<!-- GC_RELEASE_LINUX_RPM_START -->[\s\S]*?<!-- GC_RELEASE_LINUX_RPM_END -->/g;
  const windowsNativeBlock = /<!-- GC_RELEASE_WINDOWS_NATIVE_START -->[\s\S]*?<!-- GC_RELEASE_WINDOWS_NATIVE_END -->/g;
  const windowsWebBlock = /<!-- GC_RELEASE_WINDOWS_WEB_START -->[\s\S]*?<!-- GC_RELEASE_WINDOWS_WEB_END -->/g;
  let rendered = linuxRpm
    ? html
      .replaceAll("<!-- GC_RELEASE_LINUX_RPM_START -->", "")
      .replaceAll("<!-- GC_RELEASE_LINUX_RPM_END -->", "")
    : html.replace(rpmBlock, "");
  rendered = windowsAvailable
    ? rendered
      .replaceAll("<!-- GC_RELEASE_WINDOWS_NATIVE_START -->", "")
      .replaceAll("<!-- GC_RELEASE_WINDOWS_NATIVE_END -->", "")
      .replace(windowsWebBlock, "")
    : rendered
      .replace(windowsNativeBlock, "")
      .replaceAll("<!-- GC_RELEASE_WINDOWS_WEB_START -->", "")
      .replaceAll("<!-- GC_RELEASE_WINDOWS_WEB_END -->", "");
  for (const [token, value] of Object.entries(values)) rendered = rendered.replaceAll(token, String(value));
  const unresolved = [...new Set(rendered.match(/__GC_RELEASE_[A-Z0-9_]+__/g) ?? [])];
  if (unresolved.length > 0) throw new Error(`${pageName} has unresolved release variables: ${unresolved.join(", ")}`);
  return rendered;
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp.${process.pid}`;
  await writeFile(temp, canonicalJson(value), "utf8");
  await rename(temp, file);
}

async function resolvePublicReleaseMetadata() {
  const repoRoot = resolve(root, "..");
  // A messenger-only build is a private store input, not a publication action. Its defaults therefore
  // read from and write to clients/** only; production's repo-level var/updates path remains unchanged
  // for the ordinary web/deploy profile.
  const updatesDir = resolve(
    process.env.GC_UPDATES_DIR?.trim() ||
      (messengerOnly
        ? join(root, ".messenger-release-inputs")
        : join(repoRoot, "var", "updates")),
  );
  const requireArtifacts = process.env.GC_REQUIRE_RELEASE_ARTIFACTS === "1";
  const catalogFile = process.env.GC_CLIENT_RELEASE_CATALOG?.trim() || undefined;
  const catalogSha256 = process.env.GC_CLIENT_RELEASE_CATALOG_SHA256?.trim() || undefined;
  if ((catalogFile && !catalogSha256) || (!catalogFile && catalogSha256)) {
    throw new Error("GC_CLIENT_RELEASE_CATALOG and GC_CLIENT_RELEASE_CATALOG_SHA256 must be supplied together");
  }
  const manifestOut = resolve(
    process.env.GC_UPDATE_MANIFEST_OUT?.trim() ||
      (messengerOnly
        ? join(outDir, "native-update-manifest.json")
        : join(updatesDir, "manifest.json")),
  );
  // T-461: fail before the first destructive write if this build would overwrite what the live
  // production service is serving right now (see live_tree_guard.mjs). deploy.sh stages both paths.
  await assertBuildTargetsOutsideLiveTree({
    targets: [
      { label: "web output directory", path: outDir },
      { label: "update manifest", path: manifestOut },
    ],
  });

  const downloads = await materializePublicDownloads({
    repoRoot,
    updatesDir,
    requireArtifacts,
    catalogFile,
    catalogSha256,
  });

  for (const page of [join(webDir, "index.html"), join(publicDir, "en", "index.html")]) {
    const html = await readFile(page, "utf8");
    if (
      !html.includes("__GC_RELEASE_VERSION__") ||
      !html.includes("__GC_RELEASE_ANDROID_SIZE__") ||
      !html.includes("GC_RELEASE_WINDOWS_NATIVE_START")
    ) {
      throw new Error(`${page} must use build-time release variables instead of hardcoded version/size text`);
    }
  }

  return {
    version: downloads.current_version,
    downloads,
    updatesDir,
    manifestOut,
    updateManifest: buildNativeUpdateManifest(downloads),
  };
}

async function main() {
  const release = await resolvePublicReleaseMetadata();

  const buildId = sourceBuildId();
  const configSignaturePin = await resolveConfigSignaturePin({
    explicitPin: process.env.GC_CONFIG_SIGNATURE_PIN,
    keyFile: process.env.GC_CONFIG_SIGN_KEY_FILE,
    required: process.env.GC_CONFIG_REQUIRE_SIGNATURE === "1",
  });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });
  const bundledInputs = new Set();
  const profileBuildOptions = {
    sourcemap: sourceMapsEnabled,
    plugins: profilePlugins,
  };

  // T-417: bundle the Telegram-parse Web Worker as its own self-contained, content-hashed chunk. esbuild
  // does NOT split workers referenced via `new Worker(new URL(...))`, so we build the entry explicitly and
  // inject its final /assets URL into the app bundle below (via `define`). The app constructs the Worker
  // from that real path; if the entry is absent the app transparently falls back to a main-thread parse.
  const workerEntry = join(webDir, "src", "tg_import.worker.ts");
  let workerUrl = "";
  let workerFile = null;
  if (await exists(workerEntry)) {
    const workerResult = await build({
      absWorkingDir: root,
      entryPoints: [workerEntry],
      outdir: assetsDir,
      entryNames: "tg_import.worker.[hash]",
      bundle: true,
      format: "esm",
      target: ["es2022"],
      platform: "browser",
      minify: true,
      ...profileBuildOptions,
      metafile: true,
    });
    for (const input of Object.keys(workerResult.metafile.inputs))
      bundledInputs.add(input);
    for (const outPath of Object.keys(workerResult.metafile.outputs)) {
      const rel = distRelative(outPath);
      if (rel.endsWith(".js")) { workerFile = rel; workerUrl = "/" + rel; }
    }
  }

  // T-121: bundle the registration proof-of-work Web Worker the same way (its own content-hashed
  // chunk, URL injected via `define`). A bits=20 solve is ~1M sha256 attempts — it must run off the
  // UI thread; a missing entry ⇒ empty URL ⇒ the shell's pow_runner falls back to the main-thread
  // solver (cooperative-yielding), and the build itself never fails on the absence.
  const powWorkerEntry = join(webDir, "src", "pow.worker.ts");
  let powWorkerUrl = "";
  let powWorkerFile = null;
  if (await exists(powWorkerEntry)) {
    const powWorkerResult = await build({
      absWorkingDir: root,
      entryPoints: [powWorkerEntry],
      outdir: assetsDir,
      entryNames: "pow.worker.[hash]",
      bundle: true,
      format: "esm",
      target: ["es2022"],
      platform: "browser",
      minify: true,
      ...profileBuildOptions,
      metafile: true,
    });
    for (const input of Object.keys(powWorkerResult.metafile.inputs))
      bundledInputs.add(input);
    for (const outPath of Object.keys(powWorkerResult.metafile.outputs)) {
      const rel = distRelative(outPath);
      if (rel.endsWith(".js")) { powWorkerFile = rel; powWorkerUrl = "/" + rel; }
    }
  }

  // Bundle. entryNames with a hash makes every asset content-addressed → safe to cache immutably.
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(webDir, "src", "main.ts")],
    outdir: assetsDir,
    entryNames: "app.[hash]",
    assetNames: "asset.[hash]",
    bundle: true,
    ...WEB_SPLIT_OPTIONS,
    target: ["es2022"],
    platform: "browser",
    minify: true,
    ...profileBuildOptions,
    metafile: true,
    loader: { ".svg": "file", ".png": "file", ".woff2": "file" },
    // Point the app at the separately-built worker chunks (empty string ⇒ main-thread fallback).
    define: {
      __GC_WORKER_URL__: JSON.stringify(workerUrl),
      __GC_POW_WORKER_URL__: JSON.stringify(powWorkerUrl),

      __GC_BUILD_ID__: JSON.stringify(buildId),
      __GC_CONFIG_SIGNATURE_PIN__: JSON.stringify(configSignaturePin),
      __GC_DISTRIBUTION_CHANNEL__: JSON.stringify(distributionChannel),
      __GC_STORE_PROFILE__: JSON.stringify(storeProfile),
    },
  });
  for (const input of Object.keys(result.metafile.inputs))
    bundledInputs.add(input);

  // Находим именно main entry, а не «последний .js»: при splitting рядом есть чанки.
  const mainEntry = resolve(webDir, "src", "main.ts");
  const entryOutput = Object.entries(result.metafile.outputs).find(
    ([, output]) => output.entryPoint && resolve(root, output.entryPoint) === mainEntry,
  )?.[0];
  if (!entryOutput) throw new Error("build produced no JS entry for web/src/main.ts");
  const initialOutputs = collectStaticOutputs(result.metafile.outputs, entryOutput);
  const jsFile = distRelative(entryOutput);
  const cssOutput = result.metafile.outputs[entryOutput]?.cssBundle;
  const cssFile = cssOutput
    ? distRelative(outputDependency(result.metafile.outputs, entryOutput, cssOutput))
    : null;

  // Защитный гейт DS-01: libsodium разрешён только за dynamic import, никогда в initial closure.
  const initialSodium = [...initialOutputs].filter((outputPath) =>
    Object.keys(result.metafile.outputs[outputPath]?.inputs ?? {}).some((input) =>
      input.includes("node_modules/libsodium"),
    ),
  );
  if (initialSodium.length > 0) {
    throw new Error(`libsodium leaked into initial web bundle: ${initialSodium.join(", ")}`);
  }

  // Copy static public assets (favicon, manifest, icons) to the dist root.
  if (await exists(publicDir)) {
    await cp(publicDir, outDir, { recursive: true });
  }
  // One catalog produces both externally visible surfaces. Neither downloads.json nor manifest.json
  // is hand-maintained: the public website and native update endpoint receive byte-consistent metadata.
  await writeJsonAtomic(join(outDir, "downloads.json"), release.downloads);
  await mkdir(dirname(release.manifestOut), { recursive: true });
  await writeJsonAtomic(release.manifestOut, release.updateManifest);

  // Template the hybrid root with the hashed app URLs. The public site ships its own tiny static CSS
  // and loader; the much larger app CSS is disabled until site-loader.js selects app mode. This keeps
  // ordinary marketing visits fast while native shells, installed sessions and explicit ?app=1 routes
  // continue to boot the exact same shared application bundle.
  const tpl = await readFile(join(webDir, "index.html"), "utf8");
  const siteVersion = encodeURIComponent(buildId);
  const styleTag = cssFile
    ? `<meta name="gc-app-style" content="/${cssFile}" />`
    : "";
  const scriptTag = `<script src="/site-loader.js?v=${siteVersion}" data-downloads-url="/downloads.json?v=${siteVersion}" data-app-entry="/${jsFile}"></script>`;
  const html = renderReleaseTemplate(tpl, release.downloads, "ru-RU", "web/index.html")
    .replaceAll("__SITE_VERSION__", siteVersion)
    .replace("<!-- __STYLES__ -->", styleTag)
    .replace("<!-- __SCRIPTS__ -->", scriptTag);
  await writeFile(join(outDir, "index.html"), html, "utf8");

  // The English mirror is copied from public/ rather than templated from web/index.html, so render the
  // same release variables and stamp its stylesheet URL with the same build identity.
  const enIndexPath = join(outDir, "en", "index.html");
  if (await exists(enIndexPath)) {
    const enHtml = renderReleaseTemplate(
      await readFile(enIndexPath, "utf8"),
      release.downloads,
      "en-US",
      "public/en/index.html",
    ).replaceAll("__SITE_VERSION__", siteVersion);
    await writeFile(enIndexPath, enHtml, "utf8");
  }

  // Service worker (T-408): template web/sw.js with a per-build version and the exact app-shell precache
  // list, then emit it at the dist root so it is served on GET /sw.js with root scope. The version is the
  // JS content hash — a new bundle ⇒ a byte-different sw.js ⇒ the browser sees an update ⇒ the «Обновить»
  // banner. Only files that truly exist in dist go in PRECACHE (a 404 there would fail SW install).
  const swTplPath = join(webDir, "sw.js");
  if (await exists(swTplPath)) {
    const hashMatch = jsFile.match(/app\.([^.]+)\.js$/);
    const version = hashMatch ? hashMatch[1] : String(Date.now());
    const precache = ["/", "/index.html"];
    for (const outputPath of [...initialOutputs].sort()) {
      if (!outputPath.endsWith(".map")) precache.push(`/${distRelative(outputPath)}`);
    }
    for (const rel of [
      "manifest.webmanifest",
      "icon.svg",
      "icon-maskable.svg",
      "apple-touch-icon.svg",
      "favicon.svg",
    ]) {
      if (await exists(join(outDir, rel))) precache.push(`/${rel}`);
    }
    // Public release metadata, loader and CSS are commit-scoped. This prevents an older controlling
    // worker from returning stale version/size values or stale responsive CSS after a deployment.
    if (await exists(join(outDir, "site-loader.js"))) precache.push(`/site-loader.js?v=${siteVersion}`);
    if (await exists(join(outDir, "downloads.json"))) precache.push(`/downloads.json?v=${siteVersion}`);
    if (await exists(join(outDir, "site.css"))) precache.push(`/site.css?v=${siteVersion}`);
    // Match the assignments specifically — the two tokens also appear in sw.js's header comment, and a
    // bare string .replace() would rewrite that first occurrence instead of the code.
    const swSrc = (await readFile(swTplPath, "utf8"))
      .replace('"__SW_VERSION__"', JSON.stringify(version))
      .replace("= __PRECACHE__", `= ${JSON.stringify(precache)}`);
    await writeFile(join(outDir, "sw.js"), swSrc, "utf8");
  }

  // Bundle-budget gate (CLIENTS: ≤ 300 KB gzip). Measure the exact level-9 gzip bytes emitted below
  // and served in production; Node's default level-6 estimate can reject a bundle that is genuinely
  // below the transfer budget. The budget is overridable via GC_BUNDLE_BUDGET_KB for experiments.
  const budgetKb = Number(process.env.GC_BUNDLE_BUDGET_KB ?? "300");
  const gzipLen = async (rel) => (rel ? productionGzipLength(await readFile(join(outDir, rel))) : 0);
  const initialFiles = [...initialOutputs].map(distRelative);
  const initialJs = initialFiles.filter((rel) => rel.endsWith(".js"));
  const initialCss = initialFiles.filter((rel) => rel.endsWith(".css"));
  const lazyJs = Object.keys(result.metafile.outputs)
    .filter((outputPath) => outputPath.endsWith(".js") && !initialOutputs.has(outputPath))
    .map(distRelative);
  const jsGz = (await Promise.all(initialJs.map(gzipLen))).reduce((sum, bytes) => sum + bytes, 0);
  const cssGz = (await Promise.all(initialCss.map(gzipLen))).reduce((sum, bytes) => sum + bytes, 0);
  const lazyGz = (await Promise.all(lazyJs.map(gzipLen))).reduce((sum, bytes) => sum + bytes, 0);
  const workerGz = await gzipLen(workerFile);
  const powWorkerGz = await gzipLen(powWorkerFile);
  const totalGz = jsGz + cssGz; // the app-shell budget covers the initial transfer; the workers are lazy.
  const budgetBytes = budgetKb * 1024;
  const kb = (n) => (n / 1024).toFixed(1);

  console.log(`build:web OK → ${outDir}`);
  console.log(
    `  store profile: ${storeProfile}${sourceMapsEnabled ? "" : " (source maps disabled)"}`,
  );
  console.log(`  distribution channel: ${distributionChannel}`);
  console.log(
    `  index.html + ${jsFile}${cssFile ? " + " + cssFile : ""}${workerFile ? " + " + workerFile : ""}${powWorkerFile ? " + " + powWorkerFile : ""}`,
  );
  console.log(
    `  gzip: initial js ${kb(jsGz)} KB${cssGz ? ` + css ${kb(cssGz)} KB` : ""} = ${kb(totalGz)} KB / ${budgetKb} KB budget`,
  );
  if (lazyJs.length > 0 || workerFile || powWorkerFile) {
    console.log(`  lazy: ${lazyJs.length} app chunk(s) ${kb(lazyGz)} KB gzip${workerFile ? ` + worker ${kb(workerGz)} KB` : ""}${powWorkerFile ? ` + pow worker ${kb(powWorkerGz)} KB` : ""}`);
  }
  if (totalGz > budgetBytes) {
    throw new Error(`bundle budget exceeded: ${kb(totalGz)} KB gzip > ${budgetKb} KB (set GC_BUNDLE_BUDGET_KB to override)`);
  }

  // Перф-бюджет PRODUCT_UX §4.16 (холодный старт p95 < 1,2 с). Перф-аудит кампании №13 показал:
  // 333 КБ несжатого entry-JS на сети класса Fast3G — это ~1,7 с чистого трансфера и главный вклад
  // в провал бюджета (p95 ≈ 3,0 с). Пишем предсжатые сайдкары *.br/*.gz рядом с текстовыми
  // ассетами: сжатие на билде = ноль CPU на рантайме и детерминированные байты; сервер
  // (core/http.ts serveStatic) отдаёт сайдкар по Accept-Encoding с content-encoding + Vary.
  // *.map пропускаем сознательно (их тянут только devtools, а brotli-11 на мегабайтных картах
  // заметно замедлял бы каждый билд). Сайдкар пишется только если он СТРОГО меньше оригинала.
  const pc = await precompressDir(outDir);
  console.log(
    `  precompress: ${pc.files} file(s) ${kb(pc.rawBytes)} KB → br ${kb(pc.brBytes)} KB / gz ${kb(pc.gzBytes)} KB`,
  );

  // Bind the store profile and build identity to the exact emitted bytes. Mobile preparation refuses a
  // messenger payload unless every non-sidecar file still matches this SHA-256 inventory.
  const attestation = await createWebBuildAttestation(outDir, {
    profile: storeProfile,
    distributionChannel,
    buildId,
    bundledNpmPackages: [...bundledInputs]
      .map(npmPackageNameFromEsbuildInput)
      .filter((packageName) => packageName !== null),
  });
  await writeJsonAtomic(join(outDir, WEB_BUILD_ATTESTATION_FILE), attestation);
  console.log(
    `  attestation: ${WEB_BUILD_ATTESTATION_FILE} (${attestation.files.length} file(s))`,
  );
  const credentialGate = await assertNoTelegramWebSecrets(outDir);
  console.log(`  Telegram web credential gate: ${credentialGate.files} artifact(s) clean`);
}

const PRECOMPRESS_EXT = /\.(?:js|mjs|css|html|svg|json|xml|txt|webmanifest)$/;

async function precompressDir(dir) {
  const acc = { files: 0, rawBytes: 0, brBytes: 0, gzBytes: 0 };
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await precompressDir(p);
      acc.files += sub.files; acc.rawBytes += sub.rawBytes; acc.brBytes += sub.brBytes; acc.gzBytes += sub.gzBytes;
      continue;
    }
    if (!entry.isFile() || !PRECOMPRESS_EXT.test(entry.name)) continue;
    const buf = await readFile(p);
    const br = brotliCompressSync(buf, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    const gz = productionGzip(buf);
    const wroteBr = br.length < buf.length;
    const wroteGz = gz.length < buf.length;
    if (wroteBr) await writeFile(p + ".br", br);
    if (wroteGz) await writeFile(p + ".gz", gz);
    if (wroteBr || wroteGz) {
      acc.files += 1;
      acc.rawBytes += buf.length;
      acc.brBytes += wroteBr ? br.length : buf.length;
      acc.gzBytes += wroteGz ? gz.length : buf.length;
    }
  }
  return acc;
}

main().catch((err) => {
  console.error("build:web FAILED:", err);
  process.exit(1);
});
