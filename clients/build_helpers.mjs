import { dirname, join, normalize } from "node:path";

/** Общая конфигурация entry, гарантирующая реальный dynamic-import chunk в ESM. */
export const WEB_SPLIT_OPTIONS = Object.freeze({
  // esbuild's default charset is "ascii": every non-ASCII character in a string literal is emitted as a
  // six-byte \uXXXX escape instead of the two UTF-8 bytes it actually is. This application ships its
  // whole Russian interface catalogue inside the bundle, so the default was expensive in a very literal
  // way. Measured on HEAD (2026-08-04), one option changed and nothing else:
  //   charset default (ascii) -> app.js 943.1 KB raw, 20231 \u04xx escapes, initial 301.2 KB gzip
  //   charset: "utf8"         -> app.js 812.0 KB raw,     0 \u04xx escapes, initial 296.3 KB gzip
  // That is 131 KB of pure escape overhead and 4.9 KB of real transfer, on a 300 KB budget the release
  // lane was failing by 1.4 KB. ui/src/locales/ru.ts alone occupied 196 KB of the initial closure while
  // the equally large en.ts occupied 59.7 KB -- the 3.3x gap was the escaping, not the content.
  //
  // Safe by specification, not by luck: the bundle is loaded with `import(entry)` in
  // web/public/site-loader.js, and a module script is always decoded as UTF-8 regardless of the
  // Content-Type charset or the document's own encoding. server/src/core/http.ts additionally serves
  // ".js" as `text/javascript; charset=utf-8`, and web/index.html declares `<meta charset="utf-8" />`,
  // so the classic-script path would be correct too.
  charset: "utf8",
  format: "esm",
  splitting: true,
  chunkNames: "chunk.[hash]",
});

export function outputDependency(outputs, owner, dependency) {
  if (outputs[dependency]) return dependency;
  const relativeDependency = normalize(join(dirname(owner), dependency));
  if (outputs[relativeDependency]) return relativeDependency;
  throw new Error(`metafile references missing output: ${dependency} from ${owner}`);
}

/** Всё, что браузер обязан загрузить до первого dynamic import, включая CSS entry. */
export function collectStaticOutputs(outputs, entry) {
  const seen = new Set();
  const visit = (outputPath) => {
    if (seen.has(outputPath)) return;
    const output = outputs[outputPath];
    if (!output) throw new Error(`metafile references missing output: ${outputPath}`);
    seen.add(outputPath);
    if (output.cssBundle) visit(outputDependency(outputs, outputPath, output.cssBundle));
    for (const imported of output.imports) {
      if (!imported.external && imported.kind !== "dynamic-import") {
        visit(outputDependency(outputs, outputPath, imported.path));
      }
    }
  };
  visit(entry);
  return seen;
}
