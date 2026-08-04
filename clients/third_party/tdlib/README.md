# Official TDLib native runtime (T-452)

GreenChat uses only Telegram's official `tdlib/td` source and JSON interface. No third-party Telegram
wrapper is a production dependency. The exact source commit and the Android OpenSSL LTS release are
pinned in `PINNED.env`; builds must verify both the Git commit and OpenSSL SHA-256 before compilation.

## Source/binary policy

- Source repository: `https://github.com/tdlib/td.git` at the pinned full commit.
- License: Boost Software License 1.0 (`LICENSE_1_0.txt`).
- Android crypto dependency: supported OpenSSL 3.5 LTS, pinned and SHA-256 verified. Do not restore the
  official example's historical OpenSSL 1.1.1 default; that branch is outside community support.
- Generated `.so`/`.dll`/`.dylib` files are build artifacts and are never committed.
- Release CI builds from the pin, records compiler/NDK/CMake versions and publishes hashes/SBOM with the
  signed client artifact.
- Telegram `api_id`/`api_hash` are build secrets/configuration. They are never stored in this directory,
  source control, logs, diagnostics, crash reports or server-side account data.

## Build entry points

- Desktop Linux development/runtime: `build-desktop.sh`.
- Android JSONJava runtime: `build-android.sh`.

Both scripts default to `GC_BUILD_JOBS=2`: TDLib translation units are memory-heavy and unrestricted
`nproc` can exhaust RAM/swap on shared runners. A sized CI runner may set an explicit value from 1 to 16.
Build trees are incremental by default; set `GC_CLEAN_NATIVE_BUILD=1` only when a genuinely clean native
rebuild is required. Long runs belong in managed MCP background jobs and must be polled/cancelled cleanly.

The desktop runtime is copied to `clients/desktop/src-tauri/resources/tdlib/`. Android ABI libraries are
copied to `clients/mobile/android/app/src/main/jniLibs/<abi>/libtdjsonjava.so`. Those output locations are
ignored by Git. A build without the native artifact remains fully functional as GreenChat; the Telegram
connector reports `available:false` and is hidden/disabled by capability-aware UI.
