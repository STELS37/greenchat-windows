#!/usr/bin/env bash
# Build the pinned official TDLib JSON runtime as one universal macOS dylib (arm64 + x86_64).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_ROOT="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$CLIENTS_ROOT/.." && pwd)"
# shellcheck source=PINNED.env
# shellcheck disable=SC1091
source "$HERE/PINNED.env"

MIN_MACOS="${GC_MACOS_MIN_VERSION:-12.0}"
JOBS="${GC_BUILD_JOBS:-2}"
BUILD_ROOT="${GC_TDLIB_BUILD_DIR:-$REPO_ROOT/var/build/tdlib/$TDLIB_COMMIT/macos-universal}"
TD_SRC="$BUILD_ROOT/td-src"
OPENSSL_ARCHIVE="$BUILD_ROOT/$OPENSSL_TAG.tar.gz"
OUT_DIR="$CLIENTS_ROOT/desktop/src-tauri/resources/tdlib"
DEST="$OUT_DIR/libtdjson.dylib"

fail() { echo "TDLIB-MACOS-BUILD: $*" >&2; exit 1; }

self_check() {
  python3 - "$TDLIB_COMMIT" "$TDLIB_EXPECTED_VERSION" "$OPENSSL_TAG" "$OPENSSL_SHA256" "$MIN_MACOS" <<'PY'
import json, sys
commit, version, openssl, sha, minimum = sys.argv[1:]
print(json.dumps({
  "provider": "official-tdlib",
  "platform": "macos",
  "architectures": ["arm64", "x86_64"],
  "library": "libtdjson.dylib",
  "tdlib_commit": commit,
  "tdlib_version": version,
  "openssl_tag": openssl,
  "openssl_sha256": sha,
  "minimum_macos": minimum,
}, sort_keys=True))
PY
}

if [ "${1:-}" = "--self-check" ]; then self_check; exit 0; fi
[ "$#" -eq 0 ] || fail "unknown argument: $1"
[ "$(uname -s)" = "Darwin" ] || fail "this builder must run on macOS"
if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || [ "$JOBS" -gt 16 ]; then
  fail "GC_BUILD_JOBS must be 1..16"
fi
for tool in git curl tar shasum cmake lipo otool install_name_tool strip python3; do
  command -v "$tool" >/dev/null || fail "required tool is missing: $tool"
done

clone_at_commit() {
  local repository="$1" commit="$2" destination="$3"
  if [ -d "$destination/.git" ] && [ "$(git -C "$destination" rev-parse HEAD 2>/dev/null || true)" = "$commit" ]; then return; fi
  rm -rf "$destination"
  git clone --filter=blob:none --no-checkout "$repository" "$destination"
  git -C "$destination" fetch --depth 1 origin "$commit"
  git -C "$destination" checkout --detach FETCH_HEAD
  [ "$(git -C "$destination" rev-parse HEAD)" = "$commit" ] || fail "TDLib source pin mismatch"
}

prepare_archive() {
  mkdir -p "$BUILD_ROOT"
  if [ -f "$OPENSSL_ARCHIVE" ] && printf '%s  %s\n' "$OPENSSL_SHA256" "$OPENSSL_ARCHIVE" | shasum -a 256 -c --status; then return; fi
  rm -f "$OPENSSL_ARCHIVE"
  curl --fail --location --retry 3 \
    "https://github.com/openssl/openssl/releases/download/$OPENSSL_TAG/$OPENSSL_TAG.tar.gz" \
    --output "$OPENSSL_ARCHIVE"
  printf '%s  %s\n' "$OPENSSL_SHA256" "$OPENSSL_ARCHIVE" | shasum -a 256 -c --status \
    || fail "OpenSSL archive digest mismatch"
}

openssl_target() {
  case "$1" in arm64) echo darwin64-arm64-cc ;; x86_64) echo darwin64-x86_64-cc ;; *) return 1 ;; esac
}

build_openssl() {
  local arch="$1"
  local src="$BUILD_ROOT/openssl-$arch-src"
  local install="$BUILD_ROOT/openssl-$arch-install"
  local lib="$install/lib/libcrypto.a"
  [ -f "$lib" ] && { echo "$install"; return; }
  rm -rf "$src" "$install"
  mkdir -p "$src"
  tar -xzf "$OPENSSL_ARCHIVE" -C "$src" --strip-components=1
  pushd "$src" >/dev/null
  ./Configure "$(openssl_target "$arch")" no-shared no-tests \
    "-mmacosx-version-min=$MIN_MACOS" --prefix="$install" --openssldir="$install/ssl" >&2
  make -j"$JOBS" >&2
  make install_sw >&2
  popd >/dev/null
  [ -f "$lib" ] || fail "OpenSSL $arch build produced no static libcrypto"
  echo "$install"
}

build_tdjson() {
  local arch="$1" ssl="$2"
  local build="$BUILD_ROOT/td-build-$arch"
  [ "${GC_CLEAN_NATIVE_BUILD:-0}" = "1" ] && rm -rf "$build"
  cmake -S "$TD_SRC" -B "$build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DOPENSSL_ROOT_DIR="$ssl" \
    -DOPENSSL_USE_STATIC_LIBS=TRUE \
    -DOPENSSL_CRYPTO_LIBRARY="$ssl/lib/libcrypto.a" \
    -DOPENSSL_SSL_LIBRARY="$ssl/lib/libssl.a" \
    -DTD_ENABLE_JNI=OFF \
    -DTD_ENABLE_LTO=ON >&2
  cmake --build "$build" --target tdjson -j"$JOBS" >&2
  local dylib
  dylib="$(find "$build" -type f -name 'libtdjson*.dylib' -print -quit)"
  if [ -z "$dylib" ] || [ ! -f "$dylib" ]; then
    fail "TDLib $arch build produced no libtdjson dylib"
  fi
  local slices
  slices=" $(lipo -archs "$dylib") "
  case "$slices" in *" $arch "*) ;; *) fail "TDLib output does not contain $arch" ;; esac
  echo "$dylib"
}

clone_at_commit "$TDLIB_REPOSITORY" "$TDLIB_COMMIT" "$TD_SRC"
prepare_archive
arm_ssl="$(build_openssl arm64)"
x64_ssl="$(build_openssl x86_64)"
arm_dylib="$(build_tdjson arm64 "$arm_ssl")"
x64_dylib="$(build_tdjson x86_64 "$x64_ssl")"

mkdir -p "$OUT_DIR"
tmp="$OUT_DIR/.libtdjson.dylib.$$"
trap 'rm -f "$tmp"' EXIT
lipo -create "$arm_dylib" "$x64_dylib" -output "$tmp"
install_name_tool -id @rpath/libtdjson.dylib "$tmp"
strip -x "$tmp"
chmod 0755 "$tmp"
mv "$tmp" "$DEST"
trap - EXIT

slices=" $(lipo -archs "$DEST") "
case "$slices" in *" arm64 "*) ;; *) fail "universal dylib has no arm64 slice" ;; esac
case "$slices" in *" x86_64 "*) ;; *) fail "universal dylib has no x86_64 slice" ;; esac
if otool -L "$DEST" | grep -Eiq 'libssl|libcrypto|/opt/homebrew|/usr/local'; then
  otool -L "$DEST" >&2
  fail "TDLib dylib depends on a non-system OpenSSL/Homebrew runtime"
fi
for symbol in _td_create_client_id _td_send _td_receive _td_execute; do
  nm -gU "$DEST" | awk '{print $NF}' | grep -qx "$symbol" || fail "TDLib dylib misses $symbol"
done

python3 - "$DEST" "$TDLIB_EXPECTED_VERSION" <<'PY'
import ctypes, json, sys
path, expected = sys.argv[1:]
lib = ctypes.CDLL(path)
lib.td_execute.argtypes = [ctypes.c_char_p]
lib.td_execute.restype = ctypes.c_char_p
raw = lib.td_execute(b'{"@type":"getOption","name":"version"}')
if not raw: raise SystemExit("td_execute(getOption version) returned null")
actual = json.loads(raw.decode("utf-8")).get("value")
if actual != expected: raise SystemExit(f"TDLib version mismatch: {actual!r} != {expected}")
PY

cp "$HERE/LICENSE_1_0.txt" "$OUT_DIR/TDLIB_LICENSE_1_0.txt"
cp "$HERE/OPENSSL_LICENSE.txt" "$OUT_DIR/OPENSSL_LICENSE.txt"
sha="$(shasum -a 256 "$DEST" | awk '{print $1}')"
cat > "$OUT_DIR/BUILD-MANIFEST.txt" <<EOF
provider=official-tdlib
repository=$TDLIB_REPOSITORY
commit=$TDLIB_COMMIT
version=$TDLIB_EXPECTED_VERSION
openssl_commit=$OPENSSL_COMMIT
openssl_version=$OPENSSL_VERSION
platform=macos
architectures=arm64,x86_64
minimum_macos=$MIN_MACOS
sha256=$sha
EOF
printf 'TDLIB-MACOS-BUILD: OK %s sha256=%s archs=%s\n' "$DEST" "$sha" "$(lipo -archs "$DEST")"
