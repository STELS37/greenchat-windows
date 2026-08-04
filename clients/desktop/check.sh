#!/usr/bin/env bash
# T-411: desktop shell gate — type/borrow check plus deep-link routing tests.
#
# Cargo.lock follows current Tauri 2 dependencies and therefore requires the rustup stable toolchain.
# Falling back to a distribution cargo is unsafe: the command exists, starts normally, and only later
# fails on crate MSRV, which made the release gate look flaky instead of misconfigured.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/src-tauri"
ROOT="$(cd "$HERE/../.." && pwd)"
RUSTUP="${RUSTUP_HOME_BIN:-$HOME/.cargo/bin/rustup}"

if [ ! -x "$RUSTUP" ]; then
  echo "SMOKE-CLIENTS: rustup unavailable at $RUSTUP; install rustup stable (system cargo is not accepted)" >&2
  exit 1
fi
if ! "$RUSTUP" run stable rustc --version >/dev/null 2>&1; then
  echo "SMOKE-CLIENTS: rustup stable is not installed; run 'rustup toolchain install stable --profile minimal'" >&2
  exit 1
fi

cd "$SRC"
echo "desktop: cargo check ($("$RUSTUP" run stable rustc --version))"
"$RUSTUP" run stable cargo check --quiet
echo "desktop: cargo test (deep-link routing)"
"$RUSTUP" run stable cargo test --quiet
echo "desktop: Linux packaging and native-session contracts"
node "$ROOT/scripts/build-linux-desktop.mjs" --self-check
node --test "$ROOT/scripts/build-linux-desktop.test.mjs"
echo "DESKTOP-CHECK: OK"
