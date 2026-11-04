# Desktop verification — 2026-11-04

Local macOS ARM64 checks for Tetorica DMG Synth 0.0.1. No commits, pushes, tags,
signing, notarization or publication were performed.

## Bundled frontend

Imported `tetorica_dmg_synth_tauri-initial-20261104_itch.zip` without modifying its
30 extracted files. Archive SHA-256:
`01a69d23a7f92237a7a56c42f86c654f4f26ae7529cbe2972e227a3dde792fe4`.
`python3 scripts/import_release.py --check` passes. The browser source archive,
native sources, license notices and original WASM pair are retained. The WebP icon
matches the user's upstream file byte for byte; Tauri icons are derived PNG / ICO / ICNS.

The parent frontend adds a local Tauri-only `tetoricaSynthAudio` bridge and blocks
new note reservations during output switching. It preserves the same allocator,
WASM, Master bus and passive monitor. Parent `npm run test:dmg-synth`: **32 passed**.

## Automated checks

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | 8 Python + 42 Node passed | ZIP validation, native save, Pin, audio routing, credit / resampling / failure handling |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 24 passed, 2 explicit hardware tests ignored | Native command validation, binary packets, queue / rendering / credits |
| `npm run test:browser` | Chromium and WebKit passed | Real bundled WASM / AudioWorklet, mocked native IPC, physical output muted |
| `node scripts/check-audio-transport.cjs docs/audio_transport_20261104.json` | Passed | Offline scheduling model, recurring 25 ms delays, batching and bounded drift |
| `npm run build -- --bundles app --no-sign` | Passed | Local ARM64 macOS app, unsigned |
| `python3 scripts/import_release.py --check` | Passed | All 30 bundled files match the release lock |

The browser check verifies Menu / Pin, preset binary save and cancellation,
reload cancellation, native file chooser activation for VGZ, VGM voice import,
Wave preset import, keyboard access, Pulse / Pitch reset on output switching,
blocking new notes during delayed startup, finite captured PCM, Web Audio
restoration after native output failure, and one AudioContext. Narrow layout has
zero horizontal overflow at 540 px. See [JSON report](desktop_browser_20261104.json).

[Browser screenshot](desktop_browser_20261104.png) shows recovery from the test's
deliberately injected native-device failure; that error text is part of the test.
The native host in this browser test is mocked, rather than a real CPAL device.

## Real app

Launched `src-tauri/target/release/bundle/macos/Tetorica DMG Synth.app` through the
native UI. The app rendered the bundled DMG editor and VGM import. Menu displayed
DMG preset import / export, VGM / VGZ import, Audio output and Reload.
Pin switched to On and back to Off. Web Audio switched to Native with
`Native → System default (48,000 Hz)`, then returned to Web Audio. The final state
was Pin Off, Web Audio selected and Menu closed.

While Native was selected, the app's diagnostics showed zero device underruns and
755 captured frames dropped. This is a brief observation, not a continuous-audio
certification. WebView scheduling and background operation still require listening
and long-duration checks. No claim is made about subjective sound quality.

## Real CPAL silence test

Explicit command:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml native_device_continuous -- --ignored --nocapture
```

This test opens the default device at 48 kHz for 30 seconds, injects a 25 ms
producer delay once per second and requires zero underruns. It does not use the
WebView IPC path. Three runs were recorded:

| Conditions | Underruns | Longest producer interval | Outcome |
| --- | ---: | ---: | --- |
| Concurrent release build | 1 | 67.88 ms | Failed strict zero-underrun assertion |
| Build complete; offline scheduling check briefly overlapped | 1 | 110.98 ms | Failed strict zero-underrun assertion |
| Other build / verification work stopped | 0 | 45.57 ms | Passed |

The passing run lasted 30.006 seconds, injected 29 delays, consumed 1,440,256
frames, received 1,443,840 frames, and ended with 3,584 queued frames and no device
error. The isolated-run log is `/private/tmp/dmg-native-device-isolated-20261104.log`;
the second-run log is `/private/tmp/dmg-native-device-idle-20261104.log`.

The failures represent real post-startup starvation. Workload is a plausible
factor, not a proven exclusive cause. No assertion or buffer limit was relaxed.
The output remains bounded and recovers after starvation. Keep Web Audio as the
default and check Native performance on the user's actual device and workload.

## Remaining validation

Human listening, long sessions, background / Pin use, real-game VGM files and
native file dialogs remain useful checks. GitHub Actions is configured for macOS
ARM64 / x86_64, Windows x86_64 and Linux x86_64 / ARM64, but remote jobs have not
run because this new repository has not been committed or pushed by this work.
Signing and notarization are separate deployment steps.
