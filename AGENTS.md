# AGENTS.md

## Scope and authority

These instructions apply to the entire repository.

- This file and the working implementation are the authoritative product and technical specification; there is no separate `docs/` specification.
- When implementation and this guidance disagree, preserve user data, stop broadening the change, and reconcile deliberately rather than expanding scope.
- Keep changes focused. Preserve unrelated user edits in this intentionally dirty worktree.

## What this is

A browser player for a curated collection of ZX Spectrum AY/YM chip music. Tracker and chip files are converted offline into finite, seekable YM6 runtime files plus precomputed waveform peaks; the browser renders audio itself. There is no prerecorded audio anywhere in the product.

Two things follow from that and explain most of the design:

- **The engine is a synchronous, main-thread WASM renderer.** Anything that rewinds it costs a full render from sample zero. Position changes are therefore deferred and batched, not free.
- **Everything the browser plays is derived from committed authoritative inputs by deterministic tooling.** Derived artifacts are byte-compared in CI. A change that alters rendered output by one sample fails `content:validate`, which is the intended alarm, not an obstacle to route around.

### Two playback modes

The player ships two presentations of the same track, switchable on the fly and persisted:

- **`vanilla`** — the pinned Rust/WASM YM2149 emulator through the original master chain. Preserved exactly as it has always been; `content:validate` is what proves it.
- **`studio`** — a project-owned band-limited renderer (`chipSynth.ts`) through a per-channel processing chain. The default for a new listener.

Studio exists because the vendored engine snaps tone edges to the output sample grid, which jitters the pulse width. Measured on a 4105 Hz tone at 44.1 kHz, the engine produces spurious even harmonics near **-13 dB** and inharmonic partials near **-16 dB**; those land between 1 and 12 kHz, where no output filter can remove them. The same tone through `chipSynth.ts` measures **-52 dB** and **-64 dB**. That is emulator error, not chip character — real hardware toggles at exact chip-clock instants.

Both modes exist as parallel graphs feeding one volume node, and both renderers stay loaded so a switch only reconciles the one becoming active. Consequences worth knowing before touching either:

- **Vanilla is a fixed reference, not a fallback.** Do not retune its chain, its gain structure, or its amplitude model to make studio look better. It is the thing listeners A/B against.
- **Studio has no aliasing to hide.** Filters justified as "taming harshness" only throw away real harmonics there. `CHANNEL_SMOOTHING_HZ` was 9 kHz on that mistaken reasoning and left studio 3 to 7.6 dB darker than vanilla; it is 14 kHz because that measures within about 2 dB of vanilla from 2 kHz to 20 kHz.
- **The two modes must stay loudness-matched**, or the toggle compares level instead of tone and the louder one always wins. See `STUDIO_MAKEUP_DB`.

## Repository workflow

- Do not commit, tag, push, open pull requests, change remotes, or deploy unless the user explicitly requests that exact external action in the current conversation.
- Do not stage changes as part of normal implementation or verification.
- Do not create or modify an external Vercel project without separate explicit authorization.
- Use `apply_patch` for hand-edited text and source files. Formatting tools may perform mechanical rewrites.
- Do not hand-edit generated catalogs, waveform packs, playback files, hashes, or provenance. Change authoritative inputs or tooling and regenerate them.
- Do not add advertising, cookies, a service worker, PWA behavior, or remote runtime assets.
- Vercel Web Analytics (`@vercel/analytics/react`, the default `<Analytics />` component with no `mode` or `debug` override) is the one permitted exception, added as an explicit product decision. It is page-view/web-vitals telemetry only: do not call `track()` for custom events, clicks, or other UI interactions. Its script and beacon requests are served through the deployment's own origin by Vercel's edge network, so `'self'` in the existing CSP already covers them — do not relax `script-src` or `connect-src` for a third-party analytics domain. Do not add any other analytics or tracking provider without a similar explicit decision recorded here.

## Toolchain and commands

Use the pinned Node.js/npm versions and the lockfile. Install with `npm ci`, not `npm install`, when verifying a clean checkout.

| Command                    | What it proves                                                            | Rough cost      |
| -------------------------- | ------------------------------------------------------------------------- | --------------- |
| `npm run typecheck`        | `tsc --noEmit` over src, scripts, tests, and configs                      | seconds         |
| `npm run lint`             | ESLint, zero warnings tolerated; includes React hook rules                | seconds         |
| `npm run format:check`     | Prettier over the whole tree, including Markdown                          | seconds         |
| `npm test`                 | Vitest unit and component suites, including real WASM rendering           | ~50 s           |
| `npm run test:e2e`         | Playwright journeys **against the production build**                      | build + minutes |
| `npm run engine:verify`    | Vendored engine matches the pin, hashes, and required bindings            | instant         |
| `npm run content:generate` | Re-derives every artifact from authoritative inputs                       | ~40 s           |
| `npm run content:validate` | Byte-compares every committed derived artifact against a fresh derivation | ~40 s           |
| `npm run build`            | `content:validate` + `engine:verify` + `typecheck` + `vite build`         | ~45 s           |

Run checks in proportion to the change, then run the complete relevant suite before handoff. The production build must retain content validation and engine verification; do not weaken it to make a failure disappear.

`content:validate` is the strongest tool in the repo. Any change touching the engine adapter, the chip amplitude model, the offline render, or the YM/PSG format code must keep it passing, which is proof the change is bit-exact. If a change is _meant_ to alter rendered output, that is a product decision: regenerate with `content:generate` and say so explicitly in the handoff, because it rewrites every provenance file and content hash.

Continuous integration is intentionally limited to `npm run build`, which already runs the TypeScript sanity check. Keep richer lint, unit, browser, and accessibility checks as documented local commands unless the specification changes.

## Repository map

```
src/
  main.tsx                     createRoot, no StrictMode (see remount note below)
  app/                         React UI, project-owned CSS, no UI framework
    App.tsx                    catalog load, layout, distraction-free mode, keyboard
    WaveformSeek.tsx           canvas waveform + oscilloscope lens + range fallback
    ChannelMeters.tsx          three needle meters, rAF-driven
    PianoKeyboard.tsx          88-key note visualiser, rAF-driven
    VolumeKnob.tsx             role="slider" knob
    usePrefersReducedMotion.ts every rAF animation must consult this
    styles.css                 all styling
  content/
    schemas.ts                 zod schemas: sidecar, provenance, generated catalog
    runtime.ts                 fetch + SHA-256 verify, waveform pack decode
  playback/
    contracts.ts               PlaybackAdapter contract and shared types
    PlayerController.ts        the single controller the UI talks to
    Ym2149PlaybackAdapter.ts   scheduler and mode switching (lazy chunk)
    audioGraph.ts              both mode chains and all DSP tuning (lazy chunk)
    reverbImpulse.ts           synthesized plate impulse response (lazy chunk)
    chipSource.ts              ChipSource: engine and synth behind one shape
    chipSynth.ts               band-limited YM2149 renderer (studio mode)
    engine.ts                  WASM binding narrowing (lazy chunk)
    sampleRates.ts             ENGINE_SAMPLE_RATE, OFFLINE_SAMPLE_RATE
    enginePin.ts               ENGINE_COMMIT, the single source of the pin
    chipModel.ts               AY amplitude mapping + DAC tables (see invariants)
    loudness.ts                ITU-R BS.1770 measurement (build time only)
    formats.ts                 PSG / YM3 / YM6 / AY parsing and YM6 authoring
    waveform.ts                waveform peak encoding and layout constants
    persistence.ts             localStorage preferences
scripts/
  content/{cli,foundation,remote,tracker}.ts   curator pipeline (Node only)
  playback/{verify-engine-artifacts.ts,rebuild-engine.sh}
content/tracks/<permanent-id>/  authoritative source + sidecar + generated/
public/generated/               catalog.json, hashed runtime YM, hashed waveform pack
vendor/ym2149/                  pinned WASM engine, hashes in manifest.json
tests/e2e/                      Playwright journeys
```

## Application architecture

- Keep React, strict TypeScript, Vite, and project-owned CSS. Do not introduce a heavyweight UI framework without an explicit product decision.
- Keep playback behind the application-owned adapter and the single `PlayerController`. UI components must not call Web Audio or engine APIs directly. Components may read the adapter's semantic accessors (`getChannelLevels`, `getChannelVoices`, `getOscilloscopeSamples`, `getSnapshot`); those exist precisely so the UI never touches an `AudioNode`.
- Preserve one lazy `AudioContext` and at most one playback-engine instance.
- Engine/WASM and music bytes must remain lazy-loaded after a permitted user gesture.
- Both renderers sit behind the `ChipSource` shape in `chipSource.ts`, so `scheduleBuffers` never branches on which mode is active beyond recovering a chip level. Add a renderer by implementing `ChipSource`, not by special-casing the scheduler.
- All DSP tuning lives in `audioGraph.ts` as named constants with the measurement that produced them. Do not scatter filter frequencies or gains into the adapter.

### The eager/lazy module boundary

`PlayerController` is in the eager bundle. `Ym2149PlaybackAdapter` and `engine.ts` are reached only through `await import()` inside `createAdapter`, which is what keeps the 1.3 MB WASM out of the cold load.

Anything the eager bundle imports becomes eager. This is easy to break by accident: `audioPermission.ts` needs the engine's sample rate, so that constant lives in the dependency-free `sampleRates.ts` rather than in `engine.ts`. Likewise `content/schemas.ts` needs the engine commit, so the pin lives in the dependency-free `enginePin.ts`. **Never import `engine.ts`, `Ym2149PlaybackAdapter.ts`, `chipSource.ts`, `chipSynth.ts`, `audioGraph.ts`, or `reverbImpulse.ts` from `PlayerController.ts`, `audioPermission.ts`, `content/`, or `app/`** except through the existing dynamic import. `contracts.ts` is eager, so keep runtime values there trivial — `playbackModes` is a three-element array and nothing heavier belongs beside it.

Verify after any import change that `dist/assets/` still emits a separate `Ym2149PlaybackAdapter-*.js` chunk, and grep the eager chunk for a distinctive string from the lazy modules; minified identifiers make a name-based check useless.

### Async ownership in `PlayerController`

- Preserve generation/cancellation checks for every async selection. Late loads, failures, seeks, or decoder results must not mutate newer state.
- The permitted `AudioContext` is acquired once by `acquirePermission` and cached. Two rapid selections must share it; minting a second context violates the one-context invariant. `requestPlaybackAudioPermission` must still be called synchronously inside the user gesture.
- Adapter creation is memoized in `adapterPromise`. `createAdapter` performs a dynamic import, so two rapid selections both reach it before either resolves; without the shared promise the losing adapter is orphaned with its context still open.
- `releaseAudio` is the single place that tears the audio side down, and it leaves exactly one owner responsible for closing the context: the adapter once it has adopted it, the controller until then. Do not add context `close()` calls elsewhere.
- `activate()` is deliberately re-entrant and clears `disposed`. React remounts effects without rebuilding a `useMemo` value, so a terminal `dispose()` would leave the controller permanently inert with a live ticker. `main.tsx` does not currently use `StrictMode`; the controller must survive it if that changes.
- Preference writes are coalesced only for continuous controls (the volume knob publishes per pointer move). `dispose()` flushes a _pending_ coalesced write and must never invent a write of its own — an unconditional write on teardown resurrects preferences a caller just cleared.

### Rendering and animation

- Keep high-frequency meter and waveform work out of React render cycles. Publish only semantic transitions and coarse position updates. The controller ticks position at 250 ms; per-frame work belongs in `requestAnimationFrame` loops that read the adapter directly.
- A position update must never tear down an animation loop or a `ResizeObserver`. Position reaches the loops through a ref, and effects are keyed on whether animation is active, not on the position value.
- Waveform canvases redraw directly when their rendered size changes, including after their track list is restored on fullscreen exit. Do not refetch waveform data or route resize-only redraws through React.
- The static three-lane waveform (2,048 buckets × 3 channels ≈ 6,100 stroked segments) is cached in an `OffscreenCanvas` and blitted per frame; only the progress overlay, playhead, and oscilloscope lens are redrawn. Where `OffscreenCanvas` is unavailable the lanes are drawn inline — keep that fallback.
- Every `requestAnimationFrame` animation must consult `usePrefersReducedMotion`. The CSS `prefers-reduced-motion` block neutralises transitions and keyframes only; it cannot stop canvas repaints or inline style updates. Under reduced motion the loops fall back to a coarse cadence, which also removes the easing because all smoothing is elapsed-time based. Information (levels, notes, playhead) must keep updating; only the motion stands down.

### Audio graph and playback contract

- The browser runtime contract is finite, seekable generated YM. Do not add prerecorded audio fallback, overlapping playback, or browser-side tracker parsing. Browser-side **YM6 register parsing** is required — it is what drives the studio renderer — and is distinct from parsing tracker formats, which stays offline.
- Maintain the exact A/B/C channel identity, waveform colors, mix behavior, volume semantics, sequencing, persistence, Media Session, and error recovery as currently implemented. Channel identity holds in both modes: vanilla routes through per-channel left/right gain pairs, studio through equal-power panners at ±0.8.
- **Vanilla master chain**, in order, before the volume gain node: sub-sonic high-pass, bass low-shelf, loudness match, safety limiter, high-frequency low-pass. Preserve the chain and its order.
- **Studio chain**: per channel, DC block → smoothing low-pass → 4× oversampled saturation → analyser → equal-power pan; then a master tilt EQ (bass shelf, presence dip, air shelf), a synthesized plate reverb send and a detuned chorus send, then the loudness match and the limiter. The per-channel processing sits **ahead of the analyser** on purpose, so the oscilloscope shows the waveform that is actually heard.
- The loudness match is always ahead of a chain's limiter, never after it. A track needing a lift would otherwise clip the output, since the match can exceed unity.
- The offline render that feeds per-channel waveforms stays dry, on the engine, unaffected by playback mode. One waveform pack serves both modes: band-limiting barely moves min/max peaks across a 2,048-bucket reduction, and a second pack would cost roughly 288 KB for no visible gain.
- Playback `AudioContext`s are created at `ENGINE_SAMPLE_RATE` (44.1 kHz), matching the buffers the scheduler produces. A buffer whose rate differs from its context is resampled by each `AudioBufferSourceNode` independently, restarting the interpolator at every scheduled chunk boundary. Do not create the playback context at 48 kHz; `OFFLINE_SAMPLE_RATE` is for the waveform render only.

## Invariants that look optimizable but are not

Each of these has a cheap-looking "improvement" that silently breaks audio or correctness. Read the rationale before touching them.

**`chipModel.ts` candidate order.** The AY magnitude mapping is a nearest-neighbour scan over 64 candidates with strict `<`, so the _first_ match wins. Fourteen candidates share a `ym` magnitude with a _different_ `ay` result, including real chip levels 60, 85, 101, 241, 287, 341, 574, 965, 1148, 1365, 2296, 3247, 4592, and 5461. Sorting the table for a binary search, or relaxing the comparison to `<=`, changes the amplitude of those levels and audibly alters every AY track (17 of 24 in the current catalog). The lookup is memoized instead. The memo is keyed on the magnitudes that actually arrive, because the engine returns `Float32Array` samples that are not bit-identical to the double-precision table, and it is capped because the offline render interpolates between samples and would otherwise grow it without bound.

**Engine reconstruction lives in `play()` only.** The upstream native seek does not reconstruct tone/noise/envelope phase, so the adapter creates a fresh engine and renders deterministically from zero to the target sample. Cost is roughly 1 ms per second of audio on a fast desktop, so ~370 ms at the end of a six-minute track and several times that on a phone. `pause`, `stop`, and `seek` therefore only record where playback should resume; each `ChipSource` tracks where it actually is and `play()` reconciles the active one exactly once. Do not reintroduce a rewind into `pause`/`stop`/`seek`, and do not substitute the native seek. If reconstruction is moved off the main thread, keep the same sample-exact result — `content:validate` will confirm it.

This applies to the engine only. `chipSynth.ts` seeks by replaying register writes, which is effectively free, so a studio-mode seek or mode switch costs nothing. Tests asserting the deferred-reconstruction invariant **must select vanilla explicitly**: under the default studio mode the engine is never rebuilt and every such assertion passes for the wrong reason.

**`chipSynth.ts` integrates exactly; it does not point-sample.** The chip output is piecewise constant, changing only at chip-step boundaries, and each output sample is the exact average over its interval — so an edge three quarters of the way through a sample contributes exactly three quarters of it. Replacing that with point sampling reintroduces the pulse-width jitter the renderer exists to remove. Integration runs at 4× and decimates through two halfband stages, which discards partials above the output Nyquist instead of folding them down. The counters advance at **clock/8**, which is what makes tone frequency clock/(16·period) and one 32-step envelope cycle clock/(256·period); "simplifying" that divisor detunes everything.

**R13 = 0xFF means "no envelope write this frame".** YM files use it as a sentinel. Treating it as a shape write retriggers the envelope 50 times a second and destroys every slow envelope in the catalog. Envelope shapes without the continue bit are indistinguishable from 0x09 and 0x0F and are remapped to them, so only four behaviours need modelling.

**The saturator's input trim is bounded by the WaveShaper curve's domain.** A `WaveShaperNode` curve is defined over ±1 and **hard-clamps** past it, which is clipping, not saturation. The hottest per-channel peak reaching the saturator across the whole catalog is 1.26 after DC blocking and smoothing, so `SATURATION_INPUT_TRIM` keeps that inside the curve and `saturationMakeupGain` restores unity for small signals. Raising `CHANNEL_SMOOTHING_HZ` raises that peak — re-measure before changing either. An early draft used a trim of 2.5 on the assumption that per-channel peaks were near 0.28; that would have hard-clipped every loud passage.

**`STUDIO_MAKEUP_DB` is a measurement, not a taste setting.** It must be derived from K-weighted loudness of both modes' **complete static chains**, not their dry mixes: vanilla's +4 dB bass shelf and studio's presence dip are worth about 1.5 dB between them, and omitting them understates the requirement. Re-derive it after any change to either chain's EQ or to the synth's band limiting, or the toggle silently becomes a level comparison.

**Meter and voice timelines are stamped with audible time.** Buffers are scheduled up to 300 ms ahead, so reading the engine or the newest queued chunk directly would run the meters, keyboard, and oscilloscope ahead of the sound. Both `getChannelLevels` and `getChannelVoices` must keep their `time <= now` gate.

**`renderOffline` closures are hoisted deliberately.** They are declared once per render, not per output sample; a three-minute track interpolates over eight million samples.

**The unreachable throw in `remote.ts` is required.** The redirect loop always returns or throws in its final iteration, but control-flow analysis cannot see that and the function returns a value.

**Address blocking fails closed.** `isBlockedAddress` compares expanded IPv6 bytes, not text prefixes, so `::1` and `0:0:0:0:0:0:0:1` and `2001:db8::`/`2001:0db8::` are treated alike. Anything unparseable is blocked. Keep it exported and table-tested.

## Performance budgets

- Cold-load transfer (HTML, CSS, initial JS, catalog, waveform pack, initially used fonts, above-the-fold images) stays under 500 KB, excluding the lazy engine and music. Currently ~194 KB.
- Target LCP under 2.5 s and CLS under 0.1, and keep meter and waveform animation near 55 fps or better during playback.
- Hot paths, in order of sensitivity: the 50 ms scheduler tick in `scheduleBuffers` (source render plus per-sample chip model for one 100 ms chunk), the per-frame waveform draw, then the meter and keyboard loops.
- Main-thread cost per second of audio, measured over four catalog tracks in the scheduler's own per-frame segments: **vanilla 2.2 ms (0.22% of a core), studio 23.1 ms (2.31%)**. Studio is about 10× vanilla and the difference is entirely the synth's render step (22.3 ms against the engine's 1.15 ms) — exact-area integration at 4× plus two halfband stages is real arithmetic, and it is not cheaper than the WASM emulator it replaces. It is merely cheap in absolute terms: a tick renders at most 100 ms of audio, so worst case is ~2.3 ms of work against a 50 ms deadline.
- That headroom, not any claim of being faster, is why studio reuses the main-thread push scheduler instead of an `AudioWorklet`: it preserves every timeline, lookahead, and reconciliation invariant above and avoids worklet module loading entirely. Re-measure before adding per-sample work to the synth.
- Studio is slightly _cheaper_ than vanilla in the two smaller steps: it skips `applyChipAmplitudeModel` because it indexes the DAC tables directly (0.16 ms against 0.67 ms), and its voice state is a plain object rather than a wasm-bindgen JSON round trip (0.01 ms against 0.35 ms). Both are swamped by the render difference.
- A mode switch is the one CPU spike: both sources render for the crossfade chunk, and a studio-to-vanilla switch also pays the engine reconstruction, up to ~370 ms of synchronous work at the end of a long track.
- Mode chains are built on first use, so a listener who stays in one mode never pays for the other's nodes — notably the studio `ConvolverNode`. Keep that laziness.
- A mode switch renders both sources for one 100 ms chunk and crossfades the two chains. Do not "simplify" it into a hard splice: the retiring chain's buffers would stop mid-signal and the DC step left in its high-pass is an audible thump.
- Public runtime and waveform URLs stay content-hashed and immutable; HTML and `generated/catalog.json` stay revalidated. Production sourcemaps are emitted but not linked (`sourcemap: 'hidden'`), so browsers never fetch them.

## Accessibility and interface

- Target WCAG 2.2 AA. Every interactive control needs an accessible name, keyboard behavior, visible focus, and non-color state communication.
- `aria-label` on a `div` with no role is dropped by assistive technology. Give such containers an explicit role (for example `role="group"`).
- Deck toggles (Shuffle, Studio sound) keep a **fixed** accessible name and carry their state in `aria-pressed`; the state-dependent wording lives in `title`. Their LED is a 0.22rem strip that changes brightness and blooms rather than only hue. A strip that narrow cannot render a system colour legibly, so under `forced-colors: active` the pressed state is an outline on the button instead.
- Preserve the waveform's semantic range control and its conventional slider fallback when canvas or waveform data fails.
- Preserve desktop distraction-free mode and its established deck proportions. On mobile portrait, expose distraction-free mode only when native fullscreen and landscape orientation locking are available; activate the expanded deck only after the device is actually landscape, exit cleanly after a rejected landscape request, and keep the control available for retries.
- Keep the mobile-landscape distraction-free layout compact without changing the UV meters' `1.34` aspect ratio, the desktop control geometry, or normal-mode responsive proportions.
- Preserve dialog focus trapping/restoration, reduced-motion behavior, forced-colors usability, 200% zoom usability, and responsive layouts without horizontal overflow.
- External links open safely with `noopener noreferrer`. Bundled music is not exposed through direct download controls.
- Keep fonts, code, images, audio, and generated data self-hosted. Maintain the restrictive CSP and security headers. The CSP has no `unsafe-inline`, so the build must not emit inline `<script>`; check `dist/index.html` after changing Vite options.

## Content and provenance

- Curator inputs live under `content/tracks/<permanent-id>/`. IDs are stable and ordering is contiguous and one-based.
- Every public track requires a valid human-facing `sourceUrl`; it is the catalog's sole per-track attribution field. Do not add or invent per-track license metadata.
- Catalog size is a curatorial and deployment choice: development, preview, and release builds may ship any valid number of tracks, including an empty catalog. Invalid tracks must never be silently omitted.
- AY, YM, and PSG preparation is Node-only. PSG-to-YM6 and waveform generation remain project-owned deterministic paths.
- PT3, STC, ASC, STP, and FTC are accepted only through the pinned ZXTune Docker workflow at commit `8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a`.
- Tracker conversion runs as a Linux container on the curator's macOS machine. Do not build or introduce an Android application.
- Preserve original tracker bytes as authoritative. Treat `generated/source.psg`, `generated/tracker-conversion.json`, runtime YM, waveforms, and provenance as derived artifacts.
- Require ZXTune's detected type to match the tracker extension. Reject a source whose index names another supported tracker type alongside it. Keep processing network-disabled, read-only, capability-free, and bound to an isolated working directory.
- Production validation and Vercel builds consume committed derived tracker artifacts and must not require Docker or network access. A committed conversion is reused whenever its recorded source hash still matches, which is why re-deriving tracker tracks needs neither Docker nor network.
- Import/update/remove operations remain atomic. A failed download, conversion, generation, or validation must not leave partial content or catalog state.

### Loudness normalization

`content:generate` measures the dry offline mix with ITU-R BS.1770 K-weighting (`src/playback/loudness.ts`) and records two fields on both `provenance.json` and `catalog.json`: `measuredLoudnessLufs` and the `normalizationGainDb` the browser applies in **both** modes.

- The target is **-9 LUFS**, chosen to sit near the measured median of the current catalog (-9.3, spanning -5.7 to -11.7) rather than at a broadcast reference. That removes the 5.6 dB track-to-track jump while leaving the site's overall level where listeners already have it, and keeps every derived gain inside a few dB so the ±6 dB clamp never bites. Dense square waves measure loud at a modest peak, so a figure this high is expected here.
- Gains are rounded to two decimals so the value is stable under `content:validate`'s byte comparison.
- A **short** render is not a **silent** one. Loudness measurement falls back to an ungated measurement below one 0.4 s gating block; only genuine silence is unmeasurable, and that is a hard pipeline error. The synthetic PSG fixture is two frames long, which is exactly the case an over-strict implementation breaks.
- These fields depend on rendered audio, not on metadata, so adding or retuning them rewrites `provenance.json` and `catalog.json` for every track while leaving runtime YM bytes, their hashes and filenames, and the waveform pack hash untouched. Expect exactly that set of files to change.

### Editing catalog metadata

Never hand-edit `track.json` plus the derived files. Use the CLI, which stages into a temporary directory, regenerates, validates, and only then swaps `content/` and `public/generated/` into place:

```sh
npm run content:import -- --file <path> --id <slug> --order <n> --title ... --author ... --source-url ...
npm run content:update -- --id <slug> --title "..."
npm run content:remove -- --id <slug> --yes
```

Track title and author are embedded in the generated YM6 metadata, so changing either rewrites the runtime bytes, its SHA-256, its public filename, `provenance.json`, and `catalog.json`. Waveform payloads do not depend on metadata, so the waveform pack hash stays put. Expect exactly that set of files to change and confirm no `.content-stage-*` directory survives the run.

### Resolving zxart.ee source URLs

A zxart.ee track page (e.g. `https://zxart.ee/eng/authors/z/ziutek/shock7/`) is an Angular SPA; the module download link is not present in the plain HTML. Resolve it through zxart's public API instead of scraping the rendered page:

1. Fetch the page HTML anyway and read the `og:audio` meta tag, e.g. `https://music.zxart.ee/music/81553_Ziutek_Shock7.ogg`. The leading number (`81553`) is the `zxMusicId`.
2. Query `https://zxart.ee/api/export:zxMusic/limit:10/filter:zxMusicId=<id>` with a non-empty `User-Agent` (required or the API bans the IP on sight). The response's `responseData.zxMusic[0]` has `title`, `authorIds`, `year`, `type` (tracker/chip format), `compo`, and `originalUrl` — the real, directly downloadable file URL to pass as `--url` to `content:import`. Keep the zxart page URL itself as `--source-url`; it is the catalog's attribution field, not the download source.
3. `type` names the format zxart assigns, which does not always match the file extension `content:import` expects: `COP`/`VTX`/other non-tracker types cannot be imported at all (only PT3/STC/ASC/STP/FTC via Docker, or AY/YM/PSG directly). A `.pt3` extension is not sufficient on its own either — ZXTune inspects the file and rejects a source whose _detected_ type is `TS` (dual-chip TurboSound), which the pipeline does not model; `content:import` fails with a clear "extension does not match ZXTune type" error in that case, before writing anything.
4. `chipType` (AY vs YM) and `channelLayout` (ABC vs ACB) are not derivable from the zxart API; they encode the curator's knowledge of the intended hardware and the tracker's channel convention. In the current catalog, `channelLayout` tracks the source format (STC and ASC convert to ACB; PT3, AY, PSG, STP, and FTC convert to ABC) and `chipType` tracks the author's established convention elsewhere in the catalog (e.g. every Ziutek track is YM, every Klav track is AY) — check existing tracks by the same author before guessing, and note the guess explicitly when there is no precedent, since it audibly changes the amplitude model.

## Playback engine and generated artifacts

- `ENGINE_COMMIT` in `src/playback/enginePin.ts` is the only place the pinned revision is written. The provenance schema, the content pipeline, `rebuild-engine.sh`, and `engine:verify` all read it, and `engine:verify` asserts `vendor/ym2149/manifest.json` records the same revision. Change it only alongside an explicit engine decision recorded here. The pin is currently `b3096aac0dcab6dd1d82c0209f579761943aadc6` (ym2149-rs v0.9.1).
- `engine:verify` also asserts the bindings the runtime actually calls are still declared. Add to that list when the adapter or pipeline starts calling a new binding; do not guard bindings nothing consumes.
- Do not rebuild the engine during ordinary development. `npm run engine:rebuild` is an exceptional maintainer command, and it does not update `manifest.json` hashes for you.
- Authoritative sources, sidecars, internal provenance, and build-machine information must not enter public output.

## Testing expectations

- Add regression tests for behavioral fixes.
- Controller async tests must cover rapid selection, stale completion, stale failure, disposal during loading, single-adapter/single-context creation under a slow engine import, and the activate/dispose/activate remount cycle.
- Content tests must cover signatures/types, conversion provenance, stale derived files, atomic mutation, release catalog rules, and the loudness derivation.
- **`chipSynth.ts` is guarded by spectrum assertions, not golden samples.** The renderer's whole purpose is a spectral property, and its output is not required to be bit-stable across a legitimate filter retune. `chipSynth.test.ts` measures a 4105 Hz tone and requires spurious even harmonics below -45 dB and inharmonic partials below -55 dB relative to the fundamental — the direct regression test for the engine defect studio mode exists to fix. Keep envelope-shape, noise, register-sentinel, and seek-equivalence coverage alongside it.
- Envelope assertions must span at least one full envelope cycle. A window shorter than a cycle can sample an alternating sweep entirely within its quiet phase and fail for no reason.
- Adapter tests must cover both modes: which renderer `play` reconciles, that a mid-playback switch reconstructs the engine at most once and never for a vanilla-to-studio switch, that a switch while paused defers reconciliation, that chains are memoized and built lazily, and that the oscilloscope follows the active mode.
- Browser journeys must exercise real generated catalog/waveform/runtime assets and the real WASM engine where specified; do not replace acceptance evidence with mocked audio. `test:e2e` builds first and serves `dist` through `vite preview`, so the journeys cover the shipped bundle rather than the dev server.
- Accessibility scans fail on serious or critical findings. Manual platform/device checks remain required where automation cannot provide the specified evidence.

### Test environment facts

jsdom differs from a browser in ways these suites depend on. Know them before writing a component test:

- `OffscreenCanvas` is undefined, so canvas code takes its inline fallback path.
- `devicePixelRatio` is 1.
- `matchMedia` is absent; `src/test/setup.ts` installs a stub reporting "no preference" with inert listeners. Stub it per test to exercise reduced motion or mobile portrait.
- 2D contexts are not implemented; tests mock `HTMLCanvasElement.prototype.getContext` and must include every method the drawing path calls.
- Component loops driven by `requestAnimationFrame` receive the frame timestamp as an argument so tests can advance time deterministically. Keep that parameter; do not read `performance.now()` inside the loop body.
- Web Audio is absent. `src/test/audioContext.ts` is a scriptable `AudioContext` double with a test-driven `currentTime`, and it must gain a factory for every node type the graph builders call — a missing one surfaces as `context.createX is not a function` from deep inside `ensureChain`. It exposes `gainValues()` and `panValues()` in creation order. Assert with `slice` from the end rather than absolute positions: chain-level gains are created before the per-channel ones, and the chorus's panners before the channel panners.

## Linting

`eslint-plugin-react-hooks` is enabled for `src/**` and is the only automated guard on effect dependencies, ref access during render, and `setState` inside effects — the exact failure modes that produce torn-down animation loops and cascading renders here. Fix what it reports rather than suppressing it.

`eslint-plugin-jsx-a11y` is deliberately absent: its current release does not declare ESLint 10 peer support. The accessibility gate is the axe scan in the Playwright suite. Revisit when upstream supports ESLint 10.

## Handoff

Report what changed, the exact checks run and their results, and any remaining release gate. State plainly when a change altered generated content and why. Never describe the MVP or release as complete while the canonical production URL, deployment, performance measurements, or required manual platform checks remain unresolved.
