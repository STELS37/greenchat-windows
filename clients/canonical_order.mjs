// Canonical, locale-independent ordering for every attested list in the messenger release chain.
//
// Reproducible-build evidence is only meaningful when two hosts that run the same source produce
// byte-identical manifests. `String.prototype.localeCompare` cannot provide that: it resolves
// through ICU collation, which depends on the Node build, the bundled ICU data and the ambient
// locale, and which deliberately deprioritises punctuation. That is not a theoretical risk — for
// the tracked `clients/` tree it reorders 37 of 597 source paths (`clients/build.mjs` sorts after
// `clients/build_attestation.d.mts` under ICU) while Git, the source snapshot and every byte
// ordered producer emit the opposite order, so evidence failed its own validator.
//
// The canonical order here is the UTF-8 byte order that Git itself uses for tree entries. It is
// stable across Node versions, locales and ICU data, so an attested manifest ordered by this
// comparator is verifiable on any host.
import { Buffer } from "node:buffer";

export function canonicalCompare(left, right) {
  const leftText = typeof left === "string" ? left : String(left);
  const rightText = typeof right === "string" ? right : String(right);
  if (leftText === rightText) return 0;
  return Buffer.compare(
    Buffer.from(leftText, "utf8"),
    Buffer.from(rightText, "utf8"),
  );
}
