import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";
import { collectStaticOutputs, WEB_SPLIT_OPTIONS } from "../../build_helpers.mjs";

test("crypto_store bundle: libsodium-sumo остаётся только в ленивом динамическом чанке", async () => {
  const clientsRoot = resolve(import.meta.dirname, "../..");
  const result = await build({
    stdin: {
      contents: `
        import { argon2idUserSecret, ARGON2_WEAK } from "./core/src/crypto_store/index.ts";
        globalThis.__cryptoProbe = () => argon2idUserSecret().derive(
          "probe",
          new Uint8Array(16),
          ARGON2_WEAK,
        );
      `,
      resolveDir: clientsRoot,
      sourcefile: "crypto_store_probe.ts",
    },
    outdir: resolve(clientsRoot, ".tmp-crypto-store-bundle"),
    entryNames: "probe.[hash]",
    bundle: true,
    ...WEB_SPLIT_OPTIONS,
    target: ["es2022"],
    platform: "browser",
    minify: true,
    metafile: true,
    write: false,
  });
  const entryOutput = Object.entries(result.metafile.outputs).find(([, meta]) => meta.entryPoint)
    ?.[0];
  assert.ok(entryOutput, "esbuild emitted no entry output");
  const initial = collectStaticOutputs(result.metafile.outputs, entryOutput);
  const hasSodium = (output: string): boolean =>
    Object.keys(result.metafile.outputs[output]?.inputs ?? {}).some((input) =>
      input.includes("libsodium"),
    );

  assert.ok(
    result.metafile.outputs[entryOutput]!.imports.some(
      (dependency) => dependency.kind === "dynamic-import",
    ),
    "entry must retain a dynamic import edge",
  );
  assert.ok([...initial].every((output) => !hasSodium(output)), "initial closure contains libsodium");
  assert.ok(
    Object.keys(result.metafile.outputs).some(
      (output) => !initial.has(output) && hasSodium(output),
    ),
    "no lazy libsodium chunk was emitted",
  );
});
