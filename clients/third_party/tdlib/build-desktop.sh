#!/usr/bin/env bash
# Build the official pinned TDLib JSON runtime for the current Linux desktop host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_ROOT="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$CLIENTS_ROOT/.." && pwd)"
# shellcheck source=PINNED.env
source "$HERE/PINNED.env"

if [ "$(uname -s)" != "Linux" ]; then
  echo "build-desktop.sh currently targets the Linux release runner; macOS/Windows use their native CI jobs." >&2
  exit 2
fi

case "$(uname -m)" in
  x86_64) OPENSSL_TARGET=linux-x86_64 ;;
  aarch64|arm64) OPENSSL_TARGET=linux-aarch64 ;;
  *) echo "unsupported desktop architecture: $(uname -m)" >&2; exit 2 ;;
esac

# TDLib translation units are memory-heavy; unrestricted `nproc` can exhaust RAM/swap and leave
# compilers blocked in uninterruptible I/O. Keep a conservative reproducible default; CI/operators may
# raise it explicitly after sizing the runner.
JOBS="${GC_BUILD_JOBS:-2}"
if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || [ "$JOBS" -gt 16 ]; then
  echo "GC_BUILD_JOBS must be an integer between 1 and 16" >&2
  exit 2
fi
BUILD_ROOT="${GC_TDLIB_BUILD_DIR:-$REPO_ROOT/var/build/tdlib/$TDLIB_COMMIT/desktop-$(uname -m)}"
TD_SRC="$BUILD_ROOT/td-src"
TD_BUILD="$BUILD_ROOT/td-build"
SSL_SRC="$BUILD_ROOT/openssl-src"
SSL_INSTALL="$BUILD_ROOT/openssl-install"
OUT_DIR="$CLIENTS_ROOT/desktop/src-tauri/resources/tdlib"

clone_at_commit() {
  local repository="$1" commit="$2" destination="$3"
  if [ -d "$destination/.git" ] && [ "$(git -C "$destination" rev-parse HEAD 2>/dev/null || true)" = "$commit" ]; then
    return
  fi
  rm -rf "$destination"
  git clone --filter=blob:none --no-checkout "$repository" "$destination"
  git -C "$destination" fetch --depth 1 origin "$commit"
  git -C "$destination" checkout --detach FETCH_HEAD
  test "$(git -C "$destination" rev-parse HEAD)" = "$commit"
}

prepare_openssl_source() {
  local marker="$SSL_SRC/.gc-openssl-sha256"
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$OPENSSL_SHA256" ]; then
    return
  fi
  local archive="$BUILD_ROOT/$OPENSSL_TAG.tar.gz"
  local extract="$BUILD_ROOT/openssl-extract"
  rm -rf "$SSL_SRC" "$extract"
  mkdir -p "$extract"
  curl --fail --location --retry 3 \
    "https://github.com/openssl/openssl/releases/download/$OPENSSL_TAG/$OPENSSL_TAG.tar.gz" \
    --output "$archive"
  printf '%s  %s\n' "$OPENSSL_SHA256" "$archive" | sha256sum --check --status
  tar -xzf "$archive" -C "$extract"
  local source
  source="$(find "$extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [ -n "$source" ] || { echo "OpenSSL release archive is empty" >&2; exit 1; }
  mv "$source" "$SSL_SRC"
  rm -rf "$extract"
  printf '%s' "$OPENSSL_SHA256" >"$marker"
}

mkdir -p "$BUILD_ROOT" "$OUT_DIR"
clone_at_commit "$TDLIB_REPOSITORY" "$TDLIB_COMMIT" "$TD_SRC"
prepare_openssl_source

if [ ! -f "$SSL_INSTALL/lib64/libcrypto.a" ] && [ ! -f "$SSL_INSTALL/lib/libcrypto.a" ]; then
  rm -rf "$SSL_INSTALL"
  pushd "$SSL_SRC" >/dev/null
  ./Configure "$OPENSSL_TARGET" no-shared no-tests -fPIC \
    --prefix="$SSL_INSTALL" --openssldir="$SSL_INSTALL/ssl"
  make -j"$JOBS"
  make install_sw
  popd >/dev/null
fi

if [ "${GC_CLEAN_NATIVE_BUILD:-0}" = "1" ]; then
  rm -rf "$TD_BUILD"
fi
cmake -S "$TD_SRC" -B "$TD_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DOPENSSL_ROOT_DIR="$SSL_INSTALL" \
  -DOPENSSL_USE_STATIC_LIBS=TRUE \
  -DTD_ENABLE_JNI=OFF \
  -DTD_ENABLE_LTO=ON
cmake --build "$TD_BUILD" --target tdjson -j"$JOBS"

TDJSON_LINK="$TD_BUILD/libtdjson.so"
if [ ! -e "$TDJSON_LINK" ]; then
  echo "TDLib build completed without libtdjson.so" >&2
  exit 1
fi
TDJSON="$(realpath -e -- "$TDJSON_LINK")"
TD_BUILD_REAL="$(realpath -e -- "$TD_BUILD")"
case "$TDJSON" in
  "$TD_BUILD_REAL"/*) ;;
  *) echo "TDLib output escaped the expected build directory" >&2; exit 1 ;;
esac
[ -f "$TDJSON" ] || { echo "Resolved TDLib output is not a regular file" >&2; exit 1; }

DEST="$OUT_DIR/libtdjson.so"
install -m 0755 "$TDJSON" "$DEST"
strip --strip-debug --strip-unneeded "$DEST"
cp "$HERE/LICENSE_1_0.txt" "$OUT_DIR/TDLIB_LICENSE_1_0.txt"
cp "$HERE/OPENSSL_LICENSE.txt" "$OUT_DIR/OPENSSL_LICENSE.txt"

if ldd "$DEST" | grep -Eq 'libssl|libcrypto'; then
  echo "libtdjson.so unexpectedly depends on host OpenSSL; static OpenSSL linkage is required" >&2
  exit 1
fi

python3 - "$DEST" "$TDLIB_EXPECTED_VERSION" <<'PY'
import ctypes, json, sys
path, expected = sys.argv[1:]
lib = ctypes.CDLL(path)
lib.td_execute.argtypes = [ctypes.c_char_p]
lib.td_execute.restype = ctypes.c_char_p
raw = lib.td_execute(b'{"@type":"getOption","name":"version"}')
if not raw:
    raise SystemExit("td_execute(getOption version) returned null")
value = json.loads(raw.decode("utf-8"))
actual = value.get("value")
if actual != expected:
    raise SystemExit(f"TDLib version mismatch: expected {expected}, got {actual!r}")
PY

SHA256="$(sha256sum "$DEST" | awk '{print $1}')"
cat >"$OUT_DIR/BUILD-MANIFEST.txt" <<EOF
provider=official-tdlib
repository=$TDLIB_REPOSITORY
commit=$TDLIB_COMMIT
version=$TDLIB_EXPECTED_VERSION
openssl_commit=$OPENSSL_COMMIT
platform=linux
arch=$(uname -m)
sha256=$SHA256
cmake=$(cmake --version | head -1)
compiler=$(${CXX:-c++} --version | head -1)
EOF

echo "TDLIB-DESKTOP-BUILD: OK $DEST sha256=$SHA256"
