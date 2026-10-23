# UI layout kernel

Independent C++17 geometry and hit-testing code, compiled to WebAssembly by Zig 0.13.0. It contains no extracted official implementation. The Electron UI remains React/JavaScript and Canvas 2D. This is not a replacement for the Minecraft JsonUI engine.

Build from DesktopUI:

```powershell
./scripts/build-ui-layout.ps1 -Zig /absolute/path/to/zig.exe
npm run build
```

The checked-in `src/features/editor/ui-layout.wasm` is embedded in the renderer bundle by esbuild's binary loader. No compiler is required on the user's machine. CSP permits WebAssembly compilation only; JavaScript eval remains disabled. The module imports no functions and has fixed static arrays for at most 20,000 nodes, with parents preceding children. The renderer creates its own isolated instance. Source/build intermediates under native/ are excluded from the app package.

The checked-in module has optional DWARF/source-map metadata removed to avoid publishing local build paths. The bundle step reapplies this filter through `scripts/wasm-release.mjs` to cover local rebuilds. Executable sections are retained byte for byte. Regression tests add synthetic debug metadata and verify that filtering preserves module behavior.

Inputs have 18 float32 values per node and outputs have 11. Field definitions are at the top of layout.cpp. Supported geometry: numeric/parent-percent-plus-pixel dimensions, anchors, offsets, basic fixed-size stack flow, ancestor visibility/alpha/layers and rectangular child clipping. Child-driven sizing, fill, grid/collection/factory semantics, expression evaluation and animation are not implemented by this kernel.

Regression tests instantiate the shipped wasm, not a JavaScript replacement. Timing is a kernel microbenchmark, not an end-to-end performance claim or comparison with MC_Editor.
