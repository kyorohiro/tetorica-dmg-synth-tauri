# Tetorica DMG Synth — Tauri

A desktop version of [Tetorica DMG Synth](https://kyorohiro.itch.io/tetorica-dmg-synth).
Play and edit Game Boy Pulse, Wave and Noise, draw Wave RAM, import sounds from
VGM / VGZ, and take the instrument away as a preset or JavaScript.

This app bundles the browser Synth with the desktop shell used by Tetorica's
[FM2612 Synth](https://github.com/kyorohiro/tetorica-fm2612-synth-tauri) and
[SPU Synth](https://github.com/kyorohiro/tetorica-spu-synth-tauri).
The bundled app runs offline and does not download an engine at startup.

## Run

Use Node.js 22 or newer, Python 3, Rust, and the platform's Tauri 2 build tools
(Xcode command-line tools on macOS).

```sh
npm ci
npm run dev
```

Select **Enable audio**, then play the displayed computer keys or click a key.
Pulse uses two hardware channels in round robin, or CH1 alone when Sweep is on.
Wave and Noise each have one hardware channel. Noise keys trigger the configured
noise rather than tracking musical note pitch.

The desktop controls use the same Menu / Pin icons and layout as FM2612 / SPU:

- **Menu → Import → Instrument · DMG preset…** opens a saved `.json` preset.
- **Menu → Import → Sounds · VGM / VGZ…** opens a Game Boy VGM or VGZ file.
  Select a sound in the resulting library, then play it on the keyboard.
  The import uses initial voice settings, without song playback or later changes.
- **Menu → Export** saves a preset through the native file dialog.
- **Pin** toggles the window's always-on-top state for the current app session.
- **Menu → Reload** asks before discarding the current session.
- **Menu → Audio output** chooses Web Audio or Native (Rust).

The full browser editor remains available, including the two synchronized Pitch
wheels, Octave, Master 0–380%, Wave drawing, and JavaScript export. Preset and VGM
file selection use the operating system's WebView file chooser. Instruments stay
in memory until saved; automatic session restoration is not included.

## Audio output

Both modes generate audio with the same DMG WASM / AudioWorklet engine. Native
output sends final, Master-scaled PCM over binary Tauri IPC to Rust / CPAL for
device playback. The chip itself continues to run in the WebView.

Switching output stops held notes and resets Pitch while retaining the current
instrument. Native starts with the default output device; select another device
and choose **Apply device** to change it. An output error stops playback and
returns to Web Audio with the reason shown. If the engine closes, use **Enable
audio** to restart it.

The transport reuses SPU's bounded packet queue, sample-rate conversion and clock
correction. It uses eight packet credits rather than allowing an unbounded IPC
queue. Background WebView scheduling can still interrupt sound generation;
Native output does not move synthesis outside the WebView.

## Update the bundled browser app

Create a standalone DMG Synth ZIP in the upstream repository, then import it:

```sh
npm run import:release -- /path/to/tetorica_dmg_synth_VERSION_itch.zip
python3 scripts/import_release.py --check
npm test
```

`dist/` contains the original ZIP contents, including the WASM pair, corresponding
sources and license notices. `release.lock.json` pins the archive and every file
by SHA-256. Keep `dist/` and the lock together in the same commit; the ZIP itself
does not need to be committed. Invalid imports keep the previous distribution.

Desktop extensions are injected into the local app at runtime. They do not edit
the authenticated distribution. The browser version exposes an audio adapter only
to the local, top-level Tauri window.

## Test and build

```sh
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run build
```

On macOS the app is generated under `src-tauri/target/release/bundle/macos/`.
The application identifier is `net.tetorica.dmg-synth`; the initial desktop version
is `0.0.1`. The supplied icon comes from the original `tetorica_dmg_synth.webp`.

For browser checks of the real bundled Synth and desktop adapter:

```sh
npx playwright install chromium webkit
npm run test:browser
```

Those checks use real WASM / Web Audio with mocked native IPC and muted physical
output. They complement the Rust tests and app launch; they do not establish
real-device latency or long-duration audio quality. The explicit device test below
opens the system output for 30 seconds of silence:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml native_device_continuous -- --ignored --nocapture
node scripts/check-audio-transport.cjs /tmp/dmg-audio-transport.json
```

GitHub Actions tests the adapters and builds macOS ARM64 / x86_64, Windows x86_64,
and Linux x86_64 / ARM64 on their respective runners. Manual runs upload build
artifacts; `v*` tags prepare a draft GitHub release. Local macOS checks do not
replace those platform builds.

`deploy_mac.sh` supports signing and notarization using your environment variables.
See the variables at the top of that script. Signing, notarization, tagging and
publishing are separate from the local development build.

## Source and licenses

- [Upstream browser app, JavaScript APIs and WASM](https://github.com/kyorohiro/hello_ymfm_wasm)
- [Native sound-chip sources](https://github.com/kyorohiro/tetorica-soundchip-native)
- `desktop/`: Menu / Pin, native save and audio output adapters.
- `src-tauri/src/`: local command checks, native dialogs and CPAL transport.
- `dist/sources/`: bundled browser inputs and corresponding Game Boy sources.
- [Work log and remaining checks](docs/todo_20261104.md).

The desktop shell is BSD-3-Clause; see [LICENSE](LICENSE). Retain the licenses
and upstream credits in `dist/LICENSE` and `dist/licenses/` when redistributing
the sound engine and corresponding sources.
