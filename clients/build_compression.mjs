import { gzipSync } from "node:zlib";

// The web server serves the precompressed .gz sidecars emitted by build.mjs. The transfer-size budget
// must therefore measure the exact same codec settings instead of Node's lower default compression level.
export const PRODUCTION_GZIP_OPTIONS = Object.freeze({ level: 9 });

export function productionGzip(buffer) {
  return gzipSync(buffer, PRODUCTION_GZIP_OPTIONS);
}

export function productionGzipLength(buffer) {
  return productionGzip(buffer).length;
}
