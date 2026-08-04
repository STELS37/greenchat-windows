#!/usr/bin/env bash
# Build official pinned TDLib JSONJava for all Android ABIs used by the universal GreenChat APK.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_ROOT="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$CLIENTS_ROOT/.." && pwd)"
# shellcheck source=PINNED.env
source "$HERE/PINNED.env"

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
ANDROID_NDK_VERSION="${ANDROID_NDK_VERSION:-26.3.11579264}"
NDK_ROOT="${ANDROID_NDK_ROOT:-$ANDROID_SDK_ROOT/ndk/$ANDROID_NDK_VERSION}"
CMAKE_BIN="$ANDROID_SDK_ROOT/cmake/3.22.1/bin/cmake"
# TDLib translation units are memory-heavy; unrestricted `nproc` can exhaust RAM/swap and leave
# compilers blocked in uninterruptible I/O. Keep a conservative reproducible default; CI/operators may
# raise it explicitly after sizing the runner.
JOBS="${GC_BUILD_JOBS:-2}"
if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || [ "$JOBS" -gt 16 ]; then
  echo "GC_BUILD_JOBS must be an integer between 1 and 16" >&2
  exit 2
fi
BUILD_ROOT="${GC_TDLIB_ANDROID_BUILD_DIR:-$REPO_ROOT/var/build/tdlib/$TDLIB_COMMIT/android-$ANDROID_NDK_VERSION}"
TD_SRC="$BUILD_ROOT/td-src"
SSL_SRC="$BUILD_ROOT/openssl-src"
SSL_INSTALL="$BUILD_ROOT/openssl-install"
JNI_ROOT="$CLIENTS_ROOT/mobile/android/app/src/main/jniLibs"
ABIS=(arm64-v8a armeabi-v7a x86_64 x86)
OPENSSL_ANDROID_API=24
ELF_PAGE_LINKER_FLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
# This exact profile is part of the cache identity. Android API 21+ no longer exports the legacy
# stdin/stdout/stderr data symbols used by console-enabled OpenSSL. TDLib is a non-interactive library,
# so stdio and the default console UI are deliberately disabled in every pinned Android archive.
OPENSSL_ANDROID_PROFILE="tag=$OPENSSL_TAG;sha256=$OPENSSL_SHA256;ndk=$ANDROID_NDK_VERSION;api=$OPENSSL_ANDROID_API;options=no-shared,no-tests,no-stdio,no-ui-console;elf-page-flags=$ELF_PAGE_LINKER_FLAGS"
OPENSSL_PROFILE_MARKER="$SSL_INSTALL/.gc-build-profile"
OPENSSL_PROFILE_SHA256="$(printf '%s' "$OPENSSL_ANDROID_PROFILE" | sha256sum | awk '{print $1}')"

[ -d "$ANDROID_SDK_ROOT" ] || { echo "Android SDK not found: $ANDROID_SDK_ROOT" >&2; exit 2; }
[ -d "$NDK_ROOT" ] || { echo "Android NDK not found: $NDK_ROOT" >&2; exit 2; }
[ -x "$CMAKE_BIN" ] || { echo "Android SDK CMake 3.22.1 not found" >&2; exit 2; }
ANDROID_SDK_ROOT="$(cd "$ANDROID_SDK_ROOT" && pwd -P)"
NDK_ROOT="$(cd "$NDK_ROOT" && pwd -P)"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) HOST_TAG=linux-x86_64 ;;
  Darwin-x86_64) HOST_TAG=darwin-x86_64 ;;
  Darwin-arm64) HOST_TAG=darwin-x86_64 ;;
  *) echo "unsupported Android build host: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac
[ -f "$NDK_ROOT/build/cmake/android.toolchain.cmake" ] || {
  echo "Android NDK toolchain is incomplete: $NDK_ROOT" >&2
  exit 2
}
[ -x "$NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG/bin/clang" ] || {
  echo "Android NDK Clang is missing: $NDK_ROOT" >&2
  exit 2
}
export ANDROID_NDK_ROOT="$NDK_ROOT"
export ANDROID_NDK_HOME="$NDK_ROOT"
# Upstream build-tdlib.sh reconstructs the NDK path from SDK_ROOT/ndk/VERSION and otherwise ignores
# ANDROID_NDK_ROOT. Present a private, non-mutating SDK overlay when the selected NDK lives elsewhere.
UPSTREAM_SDK_ROOT="$ANDROID_SDK_ROOT"
EXPECTED_NDK_ROOT="$ANDROID_SDK_ROOT/ndk/$ANDROID_NDK_VERSION"
if [ "$NDK_ROOT" != "$EXPECTED_NDK_ROOT" ]; then
  UPSTREAM_SDK_ROOT="$BUILD_ROOT/android-sdk-overlay"
  mkdir -p "$UPSTREAM_SDK_ROOT/ndk" "$UPSTREAM_SDK_ROOT/cmake"
  ln -sfn "$NDK_ROOT" "$UPSTREAM_SDK_ROOT/ndk/$ANDROID_NDK_VERSION"
  ln -sfn "$ANDROID_SDK_ROOT/cmake/3.22.1" "$UPSTREAM_SDK_ROOT/cmake/3.22.1"
fi
# Upstream build-tdlib.sh invokes CMake/Ninja without an explicit -j; this environment variable keeps
# source generation and every ABI build inside the same bounded worker budget.
export CMAKE_BUILD_PARALLEL_LEVEL="$JOBS"
export PATH="$ANDROID_SDK_ROOT/cmake/3.22.1/bin:$NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG/bin:$PATH"

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

mkdir -p "$BUILD_ROOT"
clone_at_commit "$TDLIB_REPOSITORY" "$TDLIB_COMMIT" "$TD_SRC"
prepare_openssl_source

openssl_install_complete() {
  [ -f "$OPENSSL_PROFILE_MARKER" ] || return 1
  [ "$(cat "$OPENSSL_PROFILE_MARKER")" = "$OPENSSL_ANDROID_PROFILE" ] || return 1
  local abi
  for abi in "${ABIS[@]}"; do
    [ -s "$SSL_INSTALL/$abi/lib/libcrypto.a" ] || return 1
    [ -s "$SSL_INSTALL/$abi/lib/libssl.a" ] || return 1
    [ -s "$SSL_INSTALL/$abi/include/openssl/ssl.h" ] || return 1
  done
}

if ! openssl_install_complete; then
  rm -rf "$SSL_INSTALL"
  pushd "$SSL_SRC" >/dev/null
  for ABI in "${ABIS[@]}"; do
    [ ! -f Makefile ] || make distclean
    case "$ABI" in
      arm64-v8a) SSL_TARGET=android-arm64 ;;
      armeabi-v7a) SSL_TARGET=android-arm ;;
      x86_64) SSL_TARGET=android-x86_64 ;;
      x86) SSL_TARGET=android-x86 ;;
    esac
    LDFLAGS="$ELF_PAGE_LINKER_FLAGS" ./Configure "$SSL_TARGET" \
      no-shared no-tests no-stdio no-ui-console \
      -U__ANDROID_API__ -D__ANDROID_API__="$OPENSSL_ANDROID_API"
    make -j"$JOBS"
    mkdir -p "$SSL_INSTALL/$ABI/lib"
    cp libcrypto.a libssl.a "$SSL_INSTALL/$ABI/lib/"
    cp -a include "$SSL_INSTALL/$ABI/"
  done
  [ ! -f Makefile ] || make distclean
  popd >/dev/null
  printf '%s' "$OPENSSL_ANDROID_PROFILE" >"$OPENSSL_PROFILE_MARKER.tmp"
  mv "$OPENSSL_PROFILE_MARKER.tmp" "$OPENSSL_PROFILE_MARKER"
fi

NM="$NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG/bin/llvm-nm"
[ -x "$NM" ] || { echo "Android NDK llvm-nm is missing: $NDK_ROOT" >&2; exit 2; }
for ABI in "${ABIS[@]}"; do
  if "$NM" -u "$SSL_INSTALL/$ABI/lib/libcrypto.a" | grep -Eq '[[:space:]](stdin|stdout|stderr)$'; then
    echo "$ABI OpenSSL archive contains unsupported Android stdio data symbols" >&2
    exit 1
  fi
done

# Build from an exact copy of the official TDLib Android recipe, adding only the two linker options
# required by Android for 16 KiB ELF compatibility with NDK r27 and lower. LDFLAGS alone is not reliable:
# CMake's Android toolchain does not necessarily import it into CMAKE_SHARED_LINKER_FLAGS.
UPSTREAM_BUILD_SCRIPT="$TD_SRC/example/android/build-tdlib.sh"
GC_BUILD_SCRIPT="$TD_SRC/example/android/build-tdlib-greenchat.sh"
python3 - "$UPSTREAM_BUILD_SCRIPT" "$GC_BUILD_SCRIPT" <<'PY_PATCH'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
needle = '-DANDROID_PLATFORM=android-16 $TDLIB_INTERFACE_OPTION .. || exit 1'
replacement = ('-DANDROID_PLATFORM=android-16 '
               '-DCMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384 '
               '-Wl,-z,common-page-size=16384" '
               '$TDLIB_INTERFACE_OPTION .. || exit 1')
if source.count(needle) != 1:
    raise SystemExit('official TDLib Android CMake invocation changed; refusing an unreviewed patch')
Path(sys.argv[2]).write_text(source.replace(needle, replacement))
PY_PATCH
chmod 0700 "$GC_BUILD_SCRIPT"
grep -Fq -- '-DCMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"' \
  "$GC_BUILD_SCRIPT" || { echo "TDLib 16 KiB linker patch is missing" >&2; exit 1; }

pushd "$TD_SRC/example/android" >/dev/null
if [ "${GC_CLEAN_NATIVE_BUILD:-0}" = "1" ]; then
  rm -rf build-native-JSONJava build-*-JSONJava tdlib
fi
./build-tdlib-greenchat.sh \
  "$UPSTREAM_SDK_ROOT" "$ANDROID_NDK_VERSION" "$SSL_INSTALL" c++_static JSONJava
popd >/dev/null

rm -rf "$JNI_ROOT"
mkdir -p "$JNI_ROOT"
READELF="$NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG/bin/llvm-readelf"
STRIP="$NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG/bin/llvm-strip"
MANIFEST="$BUILD_ROOT/ANDROID-BUILD-MANIFEST.txt"
: >"$MANIFEST"
printf 'provider=official-tdlib\ncommit=%s\nversion=%s\nopenssl_commit=%s\nopenssl_profile_sha256=%s\nndk=%s\n' \
  "$TDLIB_COMMIT" "$TDLIB_EXPECTED_VERSION" "$OPENSSL_COMMIT" "$OPENSSL_PROFILE_SHA256" \
  "$ANDROID_NDK_VERSION" >>"$MANIFEST"

for ABI in "${ABIS[@]}"; do
  SOURCE="$TD_SRC/example/android/tdlib/libs/$ABI/libtdjsonjava.so"
  [ -f "$SOURCE" ] || { echo "missing TDLib output for $ABI" >&2; exit 1; }
  mkdir -p "$JNI_ROOT/$ABI"
  DEST="$JNI_ROOT/$ABI/libtdjsonjava.so"
  install -m 0755 "$SOURCE" "$DEST"
  "$STRIP" --strip-debug --strip-unneeded "$DEST"

  if "$READELF" -d "$DEST" | grep -Eq 'libssl|libcrypto|libc\+\+_shared'; then
    echo "$ABI TDLib binary has an unexpected shared crypto/C++ dependency" >&2
    exit 1
  fi
  if "$NM" -D -u "$DEST" 2>/dev/null | grep -Eq '[[:space:]](stdin|stdout|stderr)$'; then
    echo "$ABI TDLib binary contains unsupported Android stdio data symbols" >&2
    exit 1
  fi
  python3 - "$READELF" "$DEST" <<'PY'
import re, subprocess, sys
readelf, path = sys.argv[1:]
out = subprocess.check_output([readelf, "-lW", path], text=True)
alignments = []
for line in out.splitlines():
    if re.match(r"\s*LOAD\s", line):
        token = line.split()[-1]
        alignments.append(int(token, 16))
if not alignments or min(alignments) < 0x4000:
    raise SystemExit(f"{path}: ELF LOAD alignment is not 16 KiB: {alignments}")
PY
  SHA256="$(sha256sum "$DEST" | awk '{print $1}')"
  printf 'abi.%s.sha256=%s\n' "$ABI" "$SHA256" >>"$MANIFEST"
done

cp "$MANIFEST" "$JNI_ROOT/BUILD-MANIFEST.txt"
cp "$HERE/LICENSE_1_0.txt" "$JNI_ROOT/TDLIB_LICENSE_1_0.txt"
cp "$HERE/OPENSSL_LICENSE.txt" "$JNI_ROOT/OPENSSL_LICENSE.txt"

echo "TDLIB-ANDROID-BUILD: OK $JNI_ROOT"
cat "$MANIFEST"
