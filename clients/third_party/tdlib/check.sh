#!/usr/bin/env bash
# Fast source gate for pinned native TDLib build entry points. Does not compile native code.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=PINNED.env
source "$HERE/PINNED.env"

[[ "$TDLIB_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid pinned TDLib commit" >&2; exit 1; }
[[ "$OPENSSL_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid pinned OpenSSL SHA-256" >&2; exit 1; }
[ -s "$HERE/LICENSE_1_0.txt" ] || { echo "TDLib license missing" >&2; exit 1; }
[ -s "$HERE/OPENSSL_LICENSE.txt" ] || { echo "OpenSSL license missing" >&2; exit 1; }

for script in "$HERE/build-desktop.sh" "$HERE/build-android.sh"; do
  bash -n "$script"
  grep -Fq 'JOBS="${GC_BUILD_JOBS:-2}"' "$script" || {
    echo "unsafe native build job default: $(basename "$script")" >&2
    exit 1
  }
  grep -Fq 'GC_CLEAN_NATIVE_BUILD:-0' "$script" || {
    echo "native clean-build opt-in missing: $(basename "$script")" >&2
    exit 1
  }
  output="$(mktemp)"
  if GC_BUILD_JOBS=0 bash "$script" >"$output" 2>&1; then
    rm -f "$output"
    echo "invalid native job count accepted: $(basename "$script")" >&2
    exit 1
  fi
  grep -q 'integer between 1 and 16' "$output" || {
    rm -f "$output"
    echo "native job validation failed closed without stable diagnostic" >&2
    exit 1
  }
  rm -f "$output"
done

grep -Fq 'UPSTREAM_SDK_ROOT="$BUILD_ROOT/android-sdk-overlay"' "$HERE/build-android.sh" || {
  echo "Android private NDK overlay support missing" >&2
  exit 1
}
grep -Fq './build-tdlib-greenchat.sh \' "$HERE/build-android.sh" || {
  echo "Android reviewed TDLib build recipe is not invoked" >&2
  exit 1
}
grep -Fq '"$UPSTREAM_SDK_ROOT" "$ANDROID_NDK_VERSION" "$SSL_INSTALL" c++_static JSONJava'   "$HERE/build-android.sh" || {
  echo "Android reviewed TDLib build does not use the selected NDK overlay" >&2
  exit 1
}

grep -Fq 'ELF_PAGE_LINKER_FLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"' "$HERE/build-android.sh" || {
  echo "Android 16 KiB max/common page linker flags are missing" >&2
  exit 1
}
grep -Fq 'CMAKE_SHARED_LINKER_FLAGS' "$HERE/build-android.sh" || {
  echo "Android TDLib CMake linker flag injection is missing" >&2
  exit 1
}
grep -Fq 'official TDLib Android CMake invocation changed; refusing an unreviewed patch' "$HERE/build-android.sh" || {
  echo "Android TDLib upstream recipe drift guard is missing" >&2
  exit 1
}
grep -Fq 'no-shared no-tests no-stdio no-ui-console' "$HERE/build-android.sh" || {
  echo "Android OpenSSL non-interactive profile is missing" >&2
  exit 1
}
grep -Fq 'OPENSSL_PROFILE_MARKER="$SSL_INSTALL/.gc-build-profile"' "$HERE/build-android.sh" || {
  echo "Android OpenSSL cache profile marker is missing" >&2
  exit 1
}
grep -Fq '"$NM" -D -u "$DEST"' "$HERE/build-android.sh" || {
  echo "Android final TDLib dynamic-symbol inspection is missing" >&2
  exit 1
}
grep -Fq "unsupported Android stdio data symbols" "$HERE/build-android.sh" || {
  echo "Android OpenSSL/final TDLib stdio symbol gate is missing" >&2
  exit 1
}
grep -Fq 'openssl_profile_sha256=%s' "$HERE/build-android.sh" || {
  echo "Android OpenSSL build profile is missing from the native manifest" >&2
  exit 1
}

echo "TDLIB-NATIVE-SOURCE-GATE: OK"
