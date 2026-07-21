# AGENTS.md

## Scope and authority

These instructions apply to the entire repository.

- This file and the working implementation are the authoritative product and technical specification; there is no separate `docs/` specification.
- When implementation and this guidance disagree, preserve user data, stop broadening the change, and reconcile deliberately rather than expanding scope.
- Keep changes focused. Preserve unrelated user edits in this intentionally dirty worktree.

## Repository workflow

- Do not commit, tag, push, open pull requests, change remotes, or deploy unless the user explicitly requests that exact external action in the current conversation.
- Do not stage changes as part of normal implementation or verification.
- Do not create or modify an external Vercel project without separate explicit authorization.
- Use `apply_patch` for hand-edited text and source files. Formatting tools may perform mechanical rewrites.
- Do not hand-edit generated catalogs, waveform packs, playback files, hashes, or provenance. Change authoritative inputs or tooling and regenerate them.
- Do not add analytics, tracking, advertising, cookies, telemetry, a service worker, PWA behavior, or remote runtime assets.

## Toolchain and commands

Use the pinned Node.js/npm versions and the lockfile. Install with `npm ci`, not `npm install`, when verifying a clean checkout.

Primary commands:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:e2e
npm run engine:verify
npm run content:generate
npm run content:validate
npm run build
```

Run checks in proportion to the change, then run the complete relevant suite before handoff. The production build must retain content validation and engine verification; do not weaken it to make a failure disappear.

Continuous integration is intentionally limited to the TypeScript sanity check and production build. Keep richer lint, unit, browser, and accessibility checks as documented local commands unless the specification changes.

## Application architecture

- Keep React, strict TypeScript, Vite, and project-owned CSS. Do not introduce a heavyweight UI framework without an explicit product decision.
- Keep playback behind the application-owned adapter and the single `PlayerController`. UI components must not call Web Audio or engine APIs directly.
- Preserve one lazy `AudioContext` and at most one playback-engine instance. Engine/WASM and music bytes must remain lazy-loaded after a permitted user gesture.
- Preserve generation/cancellation checks for every async selection. Late loads, failures, seeks, or decoder results must not mutate newer state.
- Keep high-frequency meter and waveform work out of React render cycles. Publish only semantic transitions and coarse position updates.
- The browser runtime contract is finite, seekable generated YM. Do not add prerecorded audio fallback, overlapping playback, crossfades, or browser-side tracker parsing.
- Maintain the exact A/B/C channel identity, waveform colors, mix behavior, volume semantics, sequencing, persistence, Media Session, and error recovery as currently implemented.
- Cold-load transfer (HTML, CSS, initial JS, catalog, waveform pack, initially used fonts, above-the-fold images) stays under 500 KB, excluding the lazy engine and music. Target LCP under 2.5 s and CLS under 0.1, and keep meter and waveform animation near 55 fps or better during playback.

## Accessibility and interface

- Target WCAG 2.2 AA. Every interactive control needs an accessible name, keyboard behavior, visible focus, and non-color state communication.
- Preserve the waveform's semantic range control and its conventional slider fallback when canvas or waveform data fails.
- Preserve dialog focus trapping/restoration, reduced-motion behavior, forced-colors usability, 200% zoom usability, and responsive layouts without horizontal overflow.
- External links open safely with `noopener noreferrer`. Bundled music is not exposed through direct download controls.
- Keep fonts, code, images, audio, and generated data self-hosted. Maintain the restrictive CSP and security headers.

## Content and provenance

- Curator inputs live under `content/tracks/<permanent-id>/`. IDs are stable and ordering is contiguous and one-based.
- Every public track requires a valid human-facing `sourceUrl`; it is the catalog's sole per-track attribution field. Do not add or invent per-track license metadata.
- Catalog size is a curatorial and deployment choice: development, preview, and release builds may ship any valid number of tracks, including an empty catalog. Invalid tracks must never be silently omitted.
- AY, YM, and PSG preparation is Node-only. PSG-to-YM6 and waveform generation remain project-owned deterministic paths.
- PT3, STC, and ASC are accepted only through the pinned ZXTune Docker workflow at commit `8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a`.
- Tracker conversion runs as a Linux container on the curator's macOS machine. Do not build or introduce an Android application.
- Preserve original tracker bytes as authoritative. Treat `generated/source.psg`, `generated/tracker-conversion.json`, runtime YM, waveforms, and provenance as derived artifacts.
- Require ZXTune's detected type to match the tracker extension. Keep processing network-disabled, read-only, capability-free, and bound to an isolated working directory.
- Production validation and Vercel builds consume committed derived tracker artifacts and must not require Docker or network access.
- Import/update/remove operations remain atomic. A failed download, conversion, generation, or validation must not leave partial content or catalog state.

## Playback engine and generated artifacts

- Keep `ym2149-rs` pinned to commit `b3096aac0dcab6dd1d82c0209f579761943aadc6` unless a new explicit engine decision is recorded in this file.
- The adapter seeks by creating a fresh engine and rendering deterministically from zero to the target sample, because the upstream native seek does not reconstruct tone/noise/envelope phase. Preserve this reconstruction rather than substituting native seek; if it is moved off the main thread, keep the same sample-exact result.
- Do not rebuild the engine during ordinary development. `npm run engine:rebuild` is an exceptional maintainer command; verify tracked artifacts with `npm run engine:verify`.
- Keep public runtime and waveform URLs content-hashed and immutable. Keep HTML and `generated/catalog.json` revalidated.
- Authoritative sources, sidecars, internal provenance, and build-machine information must not enter public output.

## Testing expectations

- Add regression tests for behavioral fixes.
- Controller async tests must cover rapid selection, stale completion/failure, and disposal during loading.
- Content tests must cover signatures/types, conversion provenance, stale derived files, atomic mutation, and release catalog rules.
- Browser journeys must exercise real generated catalog/waveform/runtime assets and the real WASM engine where specified; do not replace acceptance evidence with mocked audio.
- Accessibility scans fail on serious or critical findings. Manual platform/device checks remain required where automation cannot provide the specified evidence.

## Handoff

Report what changed, the exact checks run and their results, and any remaining release gate. Never describe the MVP or release as complete while the canonical production URL, deployment, performance measurements, or required manual platform checks remain unresolved.
