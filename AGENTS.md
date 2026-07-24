# AGENTS.md

## Scope and authority

These instructions apply to the entire repository.

- This file and the working implementation are the authoritative product and technical specification; there is no separate `docs/` specification.
- When implementation and this guidance disagree, preserve user data, stop broadening the change, and reconcile deliberately rather than expanding scope.
- Keep changes focused. Preserve unrelated user edits in this intentionally dirty worktree.

## What this is

A browser player for a curated collection of ZX Spectrum AY/YM chip music. Tracker and chip files are converted offline into finite, seekable YM6 runtime files plus precomputed waveform peaks; the browser lazily loads a Rust/WASM YM2149 emulator and renders audio itself. There is no prerecorded audio anywhere in the product.

Two things follow from that and explain most of the design:

- **The engine is a synchronous, main-thread WASM renderer.** Anything that rewinds it costs a full render from sample zero. Position changes are therefore deferred and batched, not free.
- **Everything the browser plays is derived from committed authoritative inputs by deterministic tooling.** Derived artifacts are byte-compared in CI. A change that alters rendered output by one sample fails `content:validate`, which is the intended alarm, not an obstacle to route around.

## Repository workflow

- Do not commit, tag, push, open pull requests, change remotes, or deploy unless the user explicitly requests that exact external action in the current conversation.
- Do not stage changes as part of normal implementation or verification.
- Do not create or modify an external Vercel project without separate explicit authorization.
- Use `apply_patch` for hand-edited text and source files. Formatting tools may perform mechanical rewrites.
- Do not hand-edit generated catalogs, waveform packs, playback files, hashes, or provenance. Change authoritative inputs or tooling and regenerate them.
- Do not add analytics, tracking, advertising, cookies, telemetry, a service worker, PWA behavior, or remote runtime assets.

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
    Ym2149PlaybackAdapter.ts   the only Web Audio / engine caller (lazy chunk)
    engine.ts                  WASM binding narrowing (lazy chunk)
    sampleRates.ts             ENGINE_SAMPLE_RATE, OFFLINE_SAMPLE_RATE
    enginePin.ts               ENGINE_COMMIT, the single source of the pin
    chipModel.ts               AY amplitude mapping (see invariants)
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

### The eager/lazy module boundary

`PlayerController` is in the eager bundle. `Ym2149PlaybackAdapter` and `engine.ts` are reached only through `await import()` inside `createAdapter`, which is what keeps the 1.3 MB WASM out of the cold load.

Anything the eager bundle imports becomes eager. This is easy to break by accident: `audioPermission.ts` needs the engine's sample rate, so that constant lives in the dependency-free `sampleRates.ts` rather than in `engine.ts`. Likewise `content/schemas.ts` needs the engine commit, so the pin lives in the dependency-free `enginePin.ts`. **Never import `engine.ts` or `Ym2149PlaybackAdapter.ts` from `PlayerController.ts`, `audioPermission.ts`, `content/`, or `app/`** except through the existing dynamic import. Verify after any import change that `dist/assets/` still emits a separate `Ym2149PlaybackAdapter-*.js` chunk.

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

- The browser runtime contract is finite, seekable generated YM. Do not add prerecorded audio fallback, overlapping playback, crossfades, or browser-side tracker parsing.
- Maintain the exact A/B/C channel identity, waveform colors, mix behavior, volume semantics, sequencing, persistence, Media Session, and error recovery as currently implemented.
- The stereo mix passes through a fixed master processing chain before the volume gain node: sub-sonic high-pass, bass low-shelf, safety limiter, then high-frequency low-pass. Preserve the chain and its order; retune only by explicit product decision. The offline render that feeds per-channel waveforms stays dry (unprocessed).
- Playback `AudioContext`s are created at `ENGINE_SAMPLE_RATE` (44.1 kHz), matching the buffers the scheduler produces. A buffer whose rate differs from its context is resampled by each `AudioBufferSourceNode` independently, restarting the interpolator at every scheduled chunk boundary. Do not create the playback context at 48 kHz; `OFFLINE_SAMPLE_RATE` is for the waveform render only.

## Invariants that look optimizable but are not

Each of these has a cheap-looking "improvement" that silently breaks audio or correctness. Read the rationale before touching them.

**`chipModel.ts` candidate order.** The AY magnitude mapping is a nearest-neighbour scan over 64 candidates with strict `<`, so the _first_ match wins. Fourteen candidates share a `ym` magnitude with a _different_ `ay` result, including real chip levels 60, 85, 101, 241, 287, 341, 574, 965, 1148, 1365, 2296, 3247, 4592, and 5461. Sorting the table for a binary search, or relaxing the comparison to `<=`, changes the amplitude of those levels and audibly alters every AY track (17 of 24 in the current catalog). The lookup is memoized instead. The memo is keyed on the magnitudes that actually arrive, because the engine returns `Float32Array` samples that are not bit-identical to the double-precision table, and it is capped because the offline render interpolates between samples and would otherwise grow it without bound.

**Engine reconstruction lives in `play()` only.** The upstream native seek does not reconstruct tone/noise/envelope phase, so the adapter creates a fresh engine and renders deterministically from zero to the target sample. Cost is roughly 1 ms per second of audio on a fast desktop, so ~370 ms at the end of a six-minute track and several times that on a phone. `pause`, `stop`, and `seek` therefore only record where playback should resume; `playerSample` tracks where the engine actually is and `play()` reconciles it exactly once. Do not reintroduce a rewind into `pause`/`stop`/`seek`, and do not substitute the native seek. If reconstruction is moved off the main thread, keep the same sample-exact result — `content:validate` will confirm it.

**Meter and voice timelines are stamped with audible time.** Buffers are scheduled up to 300 ms ahead, so reading the engine or the newest queued chunk directly would run the meters, keyboard, and oscilloscope ahead of the sound. Both `getChannelLevels` and `getChannelVoices` must keep their `time <= now` gate.

**`renderOffline` closures are hoisted deliberately.** They are declared once per render, not per output sample; a three-minute track interpolates over eight million samples.

**The unreachable throw in `remote.ts` is required.** The redirect loop always returns or throws in its final iteration, but control-flow analysis cannot see that and the function returns a value.

**Address blocking fails closed.** `isBlockedAddress` compares expanded IPv6 bytes, not text prefixes, so `::1` and `0:0:0:0:0:0:0:1` and `2001:db8::`/`2001:0db8::` are treated alike. Anything unparseable is blocked. Keep it exported and table-tested.

## Performance budgets

- Cold-load transfer (HTML, CSS, initial JS, catalog, waveform pack, initially used fonts, above-the-fold images) stays under 500 KB, excluding the lazy engine and music. Currently ~194 KB.
- Target LCP under 2.5 s and CLS under 0.1, and keep meter and waveform animation near 55 fps or better during playback.
- Hot paths, in order of sensitivity: the 50 ms scheduler tick in `scheduleBuffers` (engine render plus per-sample chip model for one 100 ms chunk), the per-frame waveform draw, then the meter and keyboard loops.
- Public runtime and waveform URLs stay content-hashed and immutable; HTML and `generated/catalog.json` stay revalidated. Production sourcemaps are emitted but not linked (`sourcemap: 'hidden'`), so browsers never fetch them.

## Accessibility and interface

- Target WCAG 2.2 AA. Every interactive control needs an accessible name, keyboard behavior, visible focus, and non-color state communication.
- `aria-label` on a `div` with no role is dropped by assistive technology. Give such containers an explicit role (for example `role="group"`).
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

### Editing catalog metadata

Never hand-edit `track.json` plus the derived files. Use the CLI, which stages into a temporary directory, regenerates, validates, and only then swaps `content/` and `public/generated/` into place:

```sh
npm run content:import -- --file <path> --id <slug> --order <n> --title ... --author ... --source-url ...
npm run content:update -- --id <slug> --title "..."
npm run content:remove -- --id <slug> --yes
```

Track title and author are embedded in the generated YM6 metadata, so changing either rewrites the runtime bytes, its SHA-256, its public filename, `provenance.json`, and `catalog.json`. Waveform payloads do not depend on metadata, so the waveform pack hash stays put. Expect exactly that set of files to change and confirm no `.content-stage-*` directory survives the run.

## Playback engine and generated artifacts

- `ENGINE_COMMIT` in `src/playback/enginePin.ts` is the only place the pinned revision is written. The provenance schema, the content pipeline, `rebuild-engine.sh`, and `engine:verify` all read it, and `engine:verify` asserts `vendor/ym2149/manifest.json` records the same revision. Change it only alongside an explicit engine decision recorded here. The pin is currently `b3096aac0dcab6dd1d82c0209f579761943aadc6` (ym2149-rs v0.9.1).
- `engine:verify` also asserts the bindings the runtime actually calls are still declared. Add to that list when the adapter or pipeline starts calling a new binding; do not guard bindings nothing consumes.
- Do not rebuild the engine during ordinary development. `npm run engine:rebuild` is an exceptional maintainer command, and it does not update `manifest.json` hashes for you.
- Authoritative sources, sidecars, internal provenance, and build-machine information must not enter public output.

## Testing expectations

- Add regression tests for behavioral fixes.
- Controller async tests must cover rapid selection, stale completion, stale failure, disposal during loading, single-adapter/single-context creation under a slow engine import, and the activate/dispose/activate remount cycle.
- Content tests must cover signatures/types, conversion provenance, stale derived files, atomic mutation, and release catalog rules.
- Browser journeys must exercise real generated catalog/waveform/runtime assets and the real WASM engine where specified; do not replace acceptance evidence with mocked audio. `test:e2e` builds first and serves `dist` through `vite preview`, so the journeys cover the shipped bundle rather than the dev server.
- Accessibility scans fail on serious or critical findings. Manual platform/device checks remain required where automation cannot provide the specified evidence.

### Test environment facts

jsdom differs from a browser in ways these suites depend on. Know them before writing a component test:

- `OffscreenCanvas` is undefined, so canvas code takes its inline fallback path.
- `devicePixelRatio` is 1.
- `matchMedia` is absent; `src/test/setup.ts` installs a stub reporting "no preference" with inert listeners. Stub it per test to exercise reduced motion or mobile portrait.
- 2D contexts are not implemented; tests mock `HTMLCanvasElement.prototype.getContext` and must include every method the drawing path calls.
- Component loops driven by `requestAnimationFrame` receive the frame timestamp as an argument so tests can advance time deterministically. Keep that parameter; do not read `performance.now()` inside the loop body.

## Linting

`eslint-plugin-react-hooks` is enabled for `src/**` and is the only automated guard on effect dependencies, ref access during render, and `setState` inside effects — the exact failure modes that produce torn-down animation loops and cascading renders here. Fix what it reports rather than suppressing it.

`eslint-plugin-jsx-a11y` is deliberately absent: its current release does not declare ESLint 10 peer support. The accessibility gate is the axe scan in the Playwright suite. Revisit when upstream supports ESLint 10.

## Handoff

Report what changed, the exact checks run and their results, and any remaining release gate. State plainly when a change altered generated content and why. Never describe the MVP or release as complete while the canonical production URL, deployment, performance measurements, or required manual platform checks remain unresolved.
