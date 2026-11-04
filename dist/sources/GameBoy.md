# Game Boy APU source and rebuilding

The MAME-derived DMG APU by Wilbert Pol and Anthony Kruize (thanks to Shay Green)
and the Tetorica C++ adaptation use BSD-3-Clause. Original upstream files,
attribution and adaptation notes are retained under
[gameboy-sdk/vendor/mame-gameboy/](gameboy-sdk/vendor/mame-gameboy/README.md).
The sources and recipe are byte-exact files from the pinned native SDK.
[GameBoy.json](GameBoy.json) records their provenance and the shipped outputs.

From this sources directory, with Emscripten available:

`sh gameboy-sdk/scripts/build_gameboy_apu_wasm.sh ../../generated`

The recipe accepts an absolute output directory as well. Paths are resolved
from the included SDK directory. No game files, console BIOS, full MAME checkout
or network are needed. This is an APU instrument core; CPU/GBS song playback
is not provided. Native hosts compile vendor/mame-gameboy/gameboy_apu.cpp
and include gameboy_apu.h. Each instance has two Pulse channels, one Wave and
one Noise channel. Software keyboard allocation and presets belong to the host.
