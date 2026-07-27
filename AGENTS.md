# AGENTS.md

## Scope and authority

These instructions apply to the entire repository.

- This file and the working implementation are the authoritative product and technical specification; there is no separate `docs/` specification.
- When implementation and this guidance disagree, preserve user data, stop broadening the change, and reconcile deliberately rather than expanding scope.
- Keep changes focused. Preserve unrelated user edits in this intentionally dirty worktree.

## What this is

A browser player for a curated collection of ZX Spectrum AY/YM chip music. Tracker and chip files are converted offline into finite, seekable, strict YM6 runtime files plus precomputed waveform peaks. The browser renders the chip audio itself; there is no prerecorded audio anywhere in the product.

The player has one presentation: the pinned `pinebit/ym2149-rs` engine's raw three-channel output. The fork integrates the PSG's piecewise-constant output over exact host-sample intervals and carries native AY and YM DAC curves. On the 4105 Hz regression tone at 44.1 kHz, `engineSpectrum.test.ts` requires spurious even harmonics below **-45 dB** and inharmonic partials below **-55 dB** relative to the fundamental. This is the direct guard against the sample-grid edge jitter that once required a separate studio renderer.

Two facts explain most of the design:

- **The synchronous WASM renderer lives in an `AudioWorklet`, not on the main thread.** The worklet renders 1,024-sample blocks and drains them into 128-frame render quanta. There is no timer scheduler, buffer lookahead, `AudioBufferSourceNode`, or browser-side tracker parser.
- **Everything the browser plays is derived from committed authoritative inputs.** Runtime YM, conversion records, provenance, waveforms, and the public catalog are deterministic committed artifacts. Validation structurally verifies committed YM6 and fully re-derives engine-dependent artifacts without requiring Rust, Docker, or network access.

## Repository workflow

- Do not commit, tag, push, open pull requests, change remotes, or deploy unless the user explicitly requests that exact external action in the current conversation.
- Do not stage changes as part of normal implementation or verification.
- Do not create or modify an external Vercel project without separate explicit authorization.
- Use `apply_patch` for hand-edited text and source files. Formatting tools may perform mechanical rewrites.
- Do not hand-edit generated catalogs, waveform packs, playback files, hashes, conversion records, or provenance. Change authoritative inputs or tooling and regenerate them.
- Do not add advertising, cookies, a service worker, PWA behavior, or remote runtime assets.
- Vercel Web Analytics (`@vercel/analytics/react`, the default `<Analytics />` component with no `mode` or `debug` override) is the one permitted telemetry exception. Do not call `track()` or relax CSP for another provider.

## Toolchain and commands

Use the pinned Node.js/npm versions and lockfile. Verify a clean checkout with `npm ci`, not `npm install`.

| Command                            | What it proves                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck`                | `tsc --noEmit` over source, scripts, tests, and configs                           |
| `npm run lint`                     | ESLint with zero warnings                                                         |
| `npm run format:check`             | Prettier over the whole tree                                                      |
| `npm test`                         | Unit/component suites, including real WASM and worklet processor tests            |
| `npm run test:e2e`                 | Playwright journeys against the production build                                  |
| `npm run engine:verify`            | Vendored fork matches its pin, hashes, and required bindings                      |
| `npm run engine:install-converter` | Installs the pinned native `psg2ym6` into gitignored `.tools/`                    |
| `npm run content:generate`         | Regenerates every artifact; needs converter and Docker only when inputs are stale |
| `npm run content:validate`         | Structurally checks YM6 and byte-compares all re-derived committed output         |
| `npm run build`                    | Content validation, engine verification, typecheck, and Vite build                |

The production build must retain content validation and engine verification. Do not weaken either to make a failure disappear. A deliberate engine, renderer, or conversion change may rewrite every runtime, waveform, hash, provenance file, and catalog entry; regenerate once and report the scope explicitly.

Continuous integration intentionally runs only `npm run build`. Keep lint, unit, browser, accessibility, and manual audio checks as documented local gates unless the specification changes.

## Repository map

```text
src/
  main.tsx
  app/
    App.tsx                    catalog, layout, distraction-free mode, keyboard
    WaveformSeek.tsx           cached three-lane waveform + range fallback
    ChannelMeters.tsx          three rAF-driven needle meters
    PianoKeyboard.tsx          rAF-driven 88-key visualiser
    VolumeKnob.tsx             role="slider" knob
  content/
    schemas.ts                 sidecar, conversion, provenance, catalog schemas
    runtime.ts                 fetch/SHA-256 verification and waveform decoding
  playback/
    contracts.ts               eager adapter contract and shared types
    PlayerController.ts        the single controller the UI talks to
    Ym2149PlaybackAdapter.ts   lazy main-thread worklet bridge
    audioGraph.ts              raw A/B/C stereo routing and gains only
    worklet/chipProcessor.ts   the sole browser WASM player
    worklet/utf8Shim.ts        worklet-safe wasm-bindgen UTF-8 globals
    workletMessages.ts         type-only port protocol
    enginePin.ts               the single engine/converter revision pin
    formats.ts                 Node-side PSG/AY/YM6 parsing and strict YM6 authoring
    loudness.ts                ITU-R BS.1770 measurement, build time only
    waveform.ts                waveform peak encoding/layout
scripts/
  content/{cli,foundation,offlineRender,psg2ym6,remote,tracker}.ts
  playback/{install-converter,rebuild-engine,verify-engine-artifacts}.*
content/tracks/<permanent-id>/  authoritative source + sidecar + generated/
public/generated/               catalog, hashed runtime YM, waveform pack
vendor/ym2149/                  pinned fork artifacts and manifest
tests/e2e/                      production-build browser journeys
```

## Application architecture

- Keep React, strict TypeScript, Vite, and project-owned CSS. Do not add a heavyweight UI framework without a product decision.
- Playback stays behind one `PlayerController` and the application-owned adapter. UI code may read only semantic accessors (`getChannelLevels`, `getChannelVoices`, `getSnapshot`), never Web Audio or engine objects.
- Preserve one lazy `AudioContext`, one `AudioWorkletNode`, and at most one `Ym2149Player`. Engine/WASM and track bytes load only after a permitted user gesture.
- `AudioContext` is created without a forced sample rate. The worklet constructs the engine using its actual global `sampleRate`, so playback is native at the device rate. `OFFLINE_SAMPLE_RATE` is independently fixed at 48 kHz in the Node content renderer.
- The raw graph is: three-channel worklet output → splitter → per-channel L/R gains → stereo merger → normalization gain → volume gain → destination. There are no filters, compressors, saturation, analysers, panners, reverb, chorus, or limiters.
- Preserve A/B/C identity and `ABC`/`ACB`/`BAC` routing. Outer channels use `MIX_HEADROOM` 0.5 in one ear; the centre channel uses `0.5 × Math.SQRT1_2` in both. The routing gains are built silent and reach those values through the first `setChannelOrder`, so nothing can leak into the wrong ear at unity while that ramp runs.
- **The audible channel order belongs to the listener, not the track.** `setChannelOrder` is called once before the routing nodes exist, so the adapter holds the order and applies it when the worklet is built. Per-track `channelLayout` is curator metadata recording the source tracker's convention; a track load must never write it into the routing, or the cycler and the audio disagree from the first load onward.

### Worklet invariants

- The worklet bundle must be a self-contained same-origin IIFE. It must contain no static `import`/`export` and must not use a `blob:` URL. Production uses Vite's emitted hashed worker asset; dev uses the dedicated `/@zxmusicfm/chipProcessor.js` bundle endpoint because Vite's ordinary dev worker URL emits ESM imports.
- **Both worklet bundles are about 17 kB, and a regression shows up as size.** The generated glue's default init path resolves the `.wasm` beside itself; a library build in IIFE format cannot resolve `import.meta.url`, so Vite inlines the whole 1.3 MB engine as base64 into a branch nothing calls. The dev build cuts that branch, and its plugin throws if the expression it targets disappears from a vendor drop. The dev endpoint is memoized and invalidated from the watcher, because it is a nested Vite build and `addModule` asks for it on every first play.
- `AudioWorkletGlobalScope` may lack `TextEncoder` and `TextDecoder`. `utf8Shim.ts` must execute before the wasm-bindgen glue. The worklet also lacks dependable `fetch`/`URL`, so initialize with `initSync`.
- **The engine crosses the port as transferred bytes, and is compiled inside the worklet.** Posting a compiled `WebAssembly.Module` instead would keep a 1.3 MB compile off the audio thread, and it works on desktop Chromium, Firefox and WebKit — but Chromium under a mobile device profile accepts that `postMessage` without throwing and then never delivers it, leaving playback stuck in `loading` forever. `structuredClone` of the same module succeeds, so no feature probe can see it, and the only other option is racing the reply against a timer, which misfires under parallel load and ships the engine twice. Bytes are deterministic everywhere. The compile runs once during setup while the graph is silent, so the quantum it stalls would have produced silence anyway. `playback-engine.spec.ts` on `mobile-chrome` is what catches a regression here.
- Compile WASM on the main thread and post the `WebAssembly.Module`. If a browser rejects module cloning, post a copied `ArrayBuffer` and use the same `initSync` path. Chromium can accept `postMessage` yet silently lose the module message, so the bridge also sends the byte fallback when the ready handshake has not arrived within 500 ms; keep that timeout covered by Chromium journeys.
- Render blocks stay at 1,024 samples. Rendering one 128-frame quantum per `process()` call creates 375 wasm-bindgen objects per second. The final block is shortened to the exact finite track sample count so playback does not gain a silent tail.
- The worklet owns playback generation numbers. Every load/playback reply capable of affecting a track is generation-stamped; stale frames, completions, and failures must not mutate newer state.
- Worklet meter/register snapshots are stamped with the context time when their block becomes audible. `getChannelLevels`, `getChannelVoices`, and position must keep the `audioTime <= currentTime` gate.
- Voice pitch is derived in TypeScript as `chipClockHz / (16 × tonePeriod)`. Do not use the engine's legacy channel-state helper, which assumes a 2 MHz Atari clock. Envelope-driven keyboard intensity uses the audible block's per-channel RMS because a register snapshot does not expose the envelope generator's instantaneous DAC step.

### The eager/lazy boundary

`PlayerController` is eager. It reaches `Ym2149PlaybackAdapter` only through the existing dynamic import, keeping the roughly 1.3 MB WASM and worklet machinery out of cold load. `enginePin.ts`, `contracts.ts`, and `audioPermission.ts` remain dependency-light.

Never statically import `Ym2149PlaybackAdapter.ts`, the worklet, vendored glue, or `audioGraph.ts` from `PlayerController.ts`, `audioPermission.ts`, `content/`, or `app/`. After import changes, verify that `dist/assets/` still contains a separate `Ym2149PlaybackAdapter-*.js`, a separate `chipProcessor-*.js`, and a separate WASM file, and that the eager chunk has no distinctive engine strings.

### Async ownership in `PlayerController`

- Preserve generation/cancellation checks for every async selection. Late loads, failures, seeks, and decoder results must not mutate newer state.
- The permitted context is acquired once and cached. Two rapid selections share it.
- Adapter creation remains memoized in `adapterPromise`; otherwise two dynamic imports can orphan a worklet and context.
- `releaseAudio` is the sole audio teardown. The adapter owns closing a context it adopted; the controller owns it before adoption.
- `activate()` remains re-entrant for a future React StrictMode remount.
- Preference writes are coalesced only for continuous controls. `dispose()` flushes a pending write and never invents one.

### Rendering and animation

- Keep high-frequency meter, keyboard, and waveform work out of React renders. The controller publishes semantic transitions and 250 ms position updates; per-frame reads happen in rAF loops.
- Position updates must not rebuild rAF loops or `ResizeObserver`s.
- Waveform resize redraws never refetch data. The static 2,048-bucket × three-channel layer is cached in `OffscreenCanvas` and blitted; the inline fallback remains required.
- The waveform contains progress and playhead overlays only. Do not reintroduce the removed oscilloscope lens without a product decision.
- Every rAF animation consults `usePrefersReducedMotion`; information keeps updating at a coarse cadence when motion is reduced.

## Audio and format invariants

**Exact integration lives in the fork.** `compute_next_sample` averages every chip transition by fractional overlap at the real host sample rate. Replacing it with point sampling or snapping edges to the host grid restores the defect guarded by `engineSpectrum.test.ts`.

**R13 = 0xFF means “no envelope write this frame.”** Treating it as a shape write retriggers slow envelopes 50 times per second. Worklet tests span frame boundaries to guard this.

**Native seek is intentionally phase-discontinuous.** `seek_to_frame` jumps the YM frame pointer, resets effects and `prev_r13`, but does not reconstruct tone/noise/envelope phase. That is the chosen O(1) seek behavior. Do not render from zero or introduce a main-thread reconstruction path.

**Strict runtime YM6 is narrow by design.** Runtime files are interleaved YM6 with no digi-drums, loop, extra data, or port output; R14/R15 are zero and reserved register bits are clear. Browser playback rejects anything outside the fork's `strictZxYm6` profile.

**Loudness gain has no limiter after it.** Offline generation measures the worst per-ear peak over all three channel orders and clamps normalization to a **-0.3 dBFS** ceiling after the ±6 dB loudness clamp. A peak-limited track records `peakLimitedFrom`; peak-limited gains round downward to remain safe.

**`originalFileName` survives only in provenance.** A regeneration reads it back out of the existing `provenance.json` to carry it forward, so `readRecordedOriginalFileName` reads that one field instead of validating the whole document. Parsing against the current schema loses the curator's filename for every track the first time any unrelated field is added or removed, silently, because the fallback is the on-disk `source.<ext>`. Keep it exported and table-tested.

**A noise-mixing channel has no note.** The piano visualiser draws a key only while `R7` gates tone on and noise off for that channel. A channel mixing noise into its tone is percussion, and its tone period is usually a value left over from an earlier note, so drawing from it lights an arbitrary key. The consequence is deliberate: a tone-plus-noise lead stops appearing on the keyboard, and the meters remain the only visualisation of that channel.

**Envelope-driven keys are shaded from level, not from a register.** The piano visualiser reads a channel's amplitude from `R8`-`R10` while bit 4 is clear. Once it is set the channel follows the envelope, whose level is generator state no register carries, so the only source left is the rendered per-channel level — and that sits on the DAC curve rather than the register index. `amplitudeFromLevel` closes the gap by reading it through the same 48 dB floor the meters use, because the AY DAC steps about 3.2 dB per index: level 4 reads 0.38 against a register-linear 0.27, level 8 reads 0.63 against 0.53, level 12 reads 0.87 against 0.80. Clamping the level straight into 0..1 instead makes every envelope bass and lead in the catalog roughly four times darker than a volume-driven note at the same chip level.

**Address blocking fails closed.** `isBlockedAddress` compares expanded IPv6 bytes, not textual prefixes. Anything unparseable is blocked; keep it exported and table-tested.

**The unreachable throw in `remote.ts` is required.** The redirect loop returns or throws in its final iteration, but control-flow analysis cannot prove that.

## Performance budgets

- Cold-load transfer stays under 500 KB, excluding lazy WASM and music. Keep LCP under 2.5 s, CLS under 0.1, and meter/waveform animation near 55 fps or better.
- The audio hot path is isolated to the worklet: 1,024-sample WASM render, per-channel RMS, one register copy, and 128-frame ring drains. Do not add per-sample main-thread work.
- Measured locally on arm64 with Node 24.14.1 at 48 kHz over 60 seconds each of `pator-solitude`, `klav-satisfaction-10`, `jason-c-brooke-ramparts-128k-title-1`, and `ziutek-shock7`, including block RMS and register reads: **5.75 ms per second of audio on average (0.58% of one core)**. AY tracks measured 6.25–6.34 ms/s; the YM track measured 4.09 ms/s. This is a regression baseline, not a phone guarantee.
- A 128-frame quantum at 48 kHz has a 2.67 ms deadline, but block rendering amortizes allocation and typical work is far below the 21.3 ms represented by a 1,024-sample block. Re-measure before adding work in `fillRing` or `process`.
- Runtime YM and waveform URLs remain content-hashed and immutable. HTML and `generated/catalog.json` revalidate. Production sourcemaps are hidden and unlinked.

## Accessibility and interface

- Target WCAG 2.2 AA. Every control needs an accessible name, keyboard behavior, visible focus, and non-color state communication.
- `aria-label` on a roleless `div` is dropped; use an explicit semantic role.
- Shuffle keeps a fixed accessible name and carries state in `aria-pressed`. Its narrow LED uses brightness/bloom plus a forced-colors outline.
- Preserve the waveform's semantic range input and conventional fallback when canvas or data fails.
- Preserve desktop distraction-free proportions. On mobile portrait, expose it only when native fullscreen and landscape locking are available; recover cleanly from rejected orientation requests.
- Preserve UV meter aspect ratio `1.34`, dialog focus trapping/restoration, reduced motion, forced colors, 200% zoom, and no horizontal overflow.
- External links use `noopener noreferrer`. Bundled music has no direct download control.
- Keep fonts, code, images, audio, and generated data self-hosted. CSP has no `unsafe-inline`; builds must not emit inline script. The About dialog's `ym2149-rs` attribution points to the `pinebit` fork.

## Content and provenance

- Inputs live under `content/tracks/<permanent-id>/`. IDs are stable; ordering is contiguous and one-based.
- Every public track has one human-facing `sourceUrl`. Do not invent per-track license metadata.
- Supported authoritative extensions are `.pt3`, `.stc`, `.asc`, `.stp`, `.ftc`, `.ay`, and `.psg`. Direct `.ym`/`.ym3`/`.ym6` sources are not accepted.
- PT3/STC/ASC/STP/FTC use pinned ZXTune Docker commit `8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a`, with `mode=psg,optimization=0`. Keep the container network-disabled, read-only, capability-free, and isolated. Detected type must match the extension; dual-chip TurboSound is unsupported.
- The pinned ZXTune build currently enumerates AY subsongs but throws while converting AY to PSG, including single-song files. AY sources therefore use the documented fallback: vendored WASM captures the selected subsong's registers and project-owned strict YM6 authoring writes the runtime directly, without an intermediate PSG. The WASM exposes register state rather than write events, so captured R13 remains `0xFF` after the initial state.
- PSG-backed tracks use the native `.tools/bin/psg2ym6` from the same `ENGINE_COMMIT` as WASM. Legacy direct PSG ending on a frame marker is normalized only for converter input by replacing that final marker with `0xFD`; authoritative bytes are unchanged.
- `generated/ym6-conversion.json` records the route, engine/converter commit, input and output hashes/lengths, clock, frame rate/count, and metadata. Tracker tracks also retain `source.psg` and `tracker-conversion.json`.
- Production validation and Vercel require no Docker, Rust, or network. They reuse committed conversion artifacts when hashes and parameters match, structurally parse strict YM6, then re-render waveforms/loudness/catalog with vendored WASM.
- Import/update/remove remains atomic. No `.content-stage-*` directory may survive. Invalid tracks are never silently omitted.

### Loudness normalization

`content:generate` renders the strict YM6 natively at 48 kHz, measures the dry mix with ITU-R BS.1770 K-weighting, and writes `measuredLoudnessLufs` plus `normalizationGainDb` to provenance and catalog.

- Target loudness is **-9 LUFS**, with a ±6 dB clamp.
- After that, normalization is reduced as needed so the worst possible left or right ear peak across ABC/ACB/BAC remains at or below **-0.3 dBFS**. `peakLimitedFrom` records the pre-peak-clamp gain.
- Values are serialized to two decimals; peak-limited values round toward safety.
- Shorter than one 0.4 s gating block is not silence; use ungated measurement. Genuine silence is a hard pipeline error.

### Editing catalog metadata

Never hand-edit sidecars plus generated output:

```sh
npm run content:import -- --file <path> --id <slug> --order <n> --title ... --author ... --source-url ...
npm run content:update -- --id <slug> --title "..."
npm run content:remove -- --id <slug> --yes
```

Title/author are embedded in YM6. Updating either requires the pinned converter for PSG-backed tracks and rewrites runtime bytes, conversion record, hashes, public filename, provenance, and catalog. Fail clearly with `npm run engine:install-converter` when the binary is absent.

### Resolving zxart.ee URLs

The track page is an Angular SPA. Read its `og:audio` numeric ID, then query `https://zxart.ee/api/export:zxMusic/limit:10/filter:zxMusicId=<id>` with a non-empty User-Agent. Use `originalUrl` for import and retain the page URL as attribution.

`type` does not guarantee support: COP, VTX, TurboSound, and other foreign formats are rejected. `chipType` and `channelLayout` remain curator knowledge; check existing work by the same author before guessing.

## Playback engine and artifacts

- `ENGINE_COMMIT` is the sole pin for both vendored WASM and `psg2ym6`: `5bb4886fb35032db07980e5fdac408db54c7796f` from `https://github.com/pinebit/ym2149-rs` (`v0.9.1`).
- `engine:verify` checks the manifest revision, every vendored hash, and bindings actually called by browser/runtime tooling. Update the list with real use, not speculative bindings.
- `engine:rebuild` is exceptional and uses Rust 1.95.0 plus wasm-bindgen 0.2.105. It does not silently update manifest hashes.
- `engine:install-converter` installs the native converter under gitignored `.tools/`.
- Authoritative sources, sidecars, internal provenance paths, and build-machine data must not enter public output.

## Testing expectations

- Add regression tests for behavioral fixes.
- Controller tests cover rapid selection, stale completion/failure, disposal while loading, single-context/single-adapter creation, and activate/dispose/activate.
- Adapter tests cover one worklet, message ordering, generation rejection, audible-time gates, real ZX-clock pitch, all channel orders, that a listener's order survives the worklet build and a track load, that envelope- and volume-driven voices shade alike, and plain normalization.
- Worklet tests use real vendored WASM and cover non-silent A/B/C output, ring-boundary continuity, direct seek, R13 sentinel behavior, and exactly-once completion.
- `engineSpectrum.test.ts` is the direct regression for the defect the fork fixes. Keep the -45/-55 dB thresholds.
- Content tests cover signatures/types, conversion provenance and staleness, peak-limited loudness, deterministic generation, and atomic mutation.
- Browser journeys use real catalog, waveform, worklet, and WASM assets. `test:e2e` builds first and serves `dist`. `playback-worklet.spec.ts` is the only proof that the module transfer, the UTF-8 shim, and the self-contained bundle work outside Chromium; a worklet that fails to render still reports playing, so keep its position-advances and stereo-order assertions on every browser project.
- Accessibility scans fail on serious/critical findings. Manual Chromium, Firefox, and WebKit listening still matters where automation cannot prove audible continuity or stereo image.

### Test environment facts

- jsdom has no `OffscreenCanvas`; waveform tests use the inline path.
- `devicePixelRatio` is 1. `matchMedia` is stubbed to no preference.
- Canvas 2D contexts are mocked and must expose every method the tested path calls.
- Web Audio is absent. `src/test/audioContext.ts` supplies test-driven `currentTime`, gain capture, `audioWorklet.addModule`, and a scriptable `AudioWorkletNode.port`.
- rAF callbacks receive their timestamp so tests can advance time deterministically.

## Linting

`eslint-plugin-react-hooks` is the automated guard on effect dependencies, ref access during render, and state writes in effects. Fix findings rather than suppressing them.

`eslint-plugin-jsx-a11y` remains absent until it supports ESLint 10; axe in Playwright is the accessibility gate.

## Handoff

Report what changed, exact checks and results, generated-content scope and reason, converter/AY route, peak-limited track count and deltas, measured performance, and remaining manual platform/audio gates. Never call a release complete while required deployment or manual checks remain unresolved.
