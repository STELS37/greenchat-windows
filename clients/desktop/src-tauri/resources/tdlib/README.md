Official TDLib native build artifacts are generated here by
`clients/third_party/tdlib/build-desktop.sh` and are not committed.

A packaged Linux build expects `libtdjson.so`; macOS expects `libtdjson.dylib`; Windows expects
`tdjson.dll`. The Tauri resource map installs this directory as `$RESOURCE/tdlib/`.
