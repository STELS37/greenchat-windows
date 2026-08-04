// T-452 release gate: reject Telegram native application credentials from every web artifact,
// including source maps and precompressed sidecars. Diagnostics never echo the matched value.
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

async function filesUnder(root) {
  const out = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  await visit(root);
  return out.sort();
}

function scanBuffer(buffer, forbidden, file, suffix, matches) {
  for (const item of forbidden) {
    if (item.value.length > 0 && buffer.includes(Buffer.from(item.value, "utf8"))) {
      matches.push(`${file}${suffix}: ${item.label}`);
    }
  }
}

export async function assertNoTelegramWebSecrets(directory, env = process.env) {
  const root = resolve(directory);
  const forbidden = [
    { label: "native credential hash field", value: ["api", "hash"].join("_") },
    { label: "native credential identifier field", value: ["api", "id"].join("_") },
    { label: "native credential hash environment name", value: ["GC", "TELEGRAM", "API", "HASH"].join("_") },
    { label: "native credential identifier environment name", value: ["GC", "TELEGRAM", "API", "ID"].join("_") },
  ];
  for (const [name, label] of [
    ["GC_TELEGRAM_API_HASH", "configured native credential"],
    ["GC_TELEGRAM_SECRET_SENTINEL", "release-gate sentinel"],
  ]) {
    const value = String(env[name] ?? "").trim();
    if (value.length >= 8) forbidden.push({ label, value });
  }

  const matches = [];
  for (const path of await filesUnder(root)) {
    const rel = relative(root, path).replaceAll("\\", "/");
    const raw = await readFile(path);
    scanBuffer(raw, forbidden, rel, "", matches);
    try {
      if (extname(path) === ".gz") scanBuffer(gunzipSync(raw), forbidden, rel, " (decompressed)", matches);
      if (extname(path) === ".br") scanBuffer(brotliDecompressSync(raw), forbidden, rel, " (decompressed)", matches);
    } catch {
      matches.push(`${rel}: invalid compressed release artifact`);
    }
  }
  if (matches.length > 0) {
    throw new Error(`Telegram web credential gate failed:\n${[...new Set(matches)].map((line) => `- ${line}`).join("\n")}`);
  }
  return { files: (await filesUnder(root)).length };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const target = process.argv[2] ?? new URL("../web/dist/", import.meta.url).pathname;
  assertNoTelegramWebSecrets(target)
    .then(({ files }) => console.log(`telegram web credential gate OK (${files} artifacts)`))
    .catch((error) => { console.error(String(error instanceof Error ? error.message : error)); process.exit(1); });
}
