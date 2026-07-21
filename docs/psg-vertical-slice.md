# PSG Vertical Slice

Status: Phase 3 acceptance is closed as of 2026-07-21. Automated acceptance
passes, and the user confirmed clean playback after testing the real track in a
supported desktop browser.

## Seed Content

- Track: **Solitude** by Pator (2024)
- Original source and attribution:
  <https://zxart.ee/eng/authors/p/pator/solitude/>
- Authoritative format: uncompressed AY Emulator PSG stream
- Source bytes: 63,474
- Source SHA-256:
  `6264516620313219de9a7e8b2d21d07e47f83b0b833d893646653abf64b14857`
- Playback environment: AY, 1,773,400 Hz, 50 Hz, ABC
- Parsed runtime: 8,651 frames and 173.02 seconds
- Canonical runtime SHA-256:
  `0f8e1a3d4c5a0ca3454d957bca324f2eca265cfa25e9b28ceed066a099d66be6`
- Per-track waveform SHA-256:
  `3b5e87b99641b79cba1bcbf8d5c9da99ef9240e85fdbfad89d749338f5c065fe`

The authoritative source and sidecar live in
`content/tracks/pator-solitude`. Runtime YM6, per-track waveform data, and
provenance are isolated below its `generated` directory. Public playback and
catalog-wide waveform assets have byte-digest filenames; the stable catalog
points to those immutable names.

## Preparation and Validation

The production importer retrieved the specified direct HTTPS URL while keeping
it separate from the human-facing attribution URL. The importer rejects unsafe
destinations and redirects, credentials, downgrade redirects, excessive files,
empty responses, unsupported signatures, metadata collisions, and invalid
ordering before committing staged changes.

Generation performs these deterministic gates:

1. Parse and structurally validate the authoritative PSG stream.
2. Convert its register timeline to canonical YM6.
3. Compare every generated frame and register with the parsed source timeline.
4. Independently compare uninterrupted and restored playback at zero, 25%,
   50%, 75%, and one second before the end, for both mix and A/B/C samples at
   the fixed `0.000001` tolerance.
5. Render the complete pre-pan, pre-volume A/B/C output at 48 kHz and encode
   2,048 outward-rounded min/max buckets for each channel.
6. Generate per-track provenance, the catalog-wide waveform pack, the stable
   catalog, and content-hashed public runtime assets.
7. Recompute every expected byte during read-only validation and fail the build
   if any source, derived file, digest, metadata field, offset, or public asset
   is missing or stale.

Import, update, and confirmed removal use a repository-local staging directory.
Generation and full validation finish in the stage before the content and
public-generated directories are swapped into place; rollback restores the
prior pair if the swap fails.

## Browser Slice

The Phase 3 interface:

- loads and schema-validates the real catalog;
- fetches the waveform pack on page load and validates byte length and SHA-256
  with Web Crypto before decoding it;
- lazy-fetches only the selected YM6 and performs the same integrity check
  before passing bytes to the playback adapter;
- overlays true red A, yellow B, and cyan C waveform envelopes behind one
  semantic seek control;
- plays only after a user gesture, pauses, resumes, seeks, and reaches the
  generated 173.02-second end;
- displays genuine per-channel levels using direct animation-frame meter
  updates with the specified dB mapping and attack/release smoothing;
- changes master volume and mute and restores the selected track, paused
  position, volume, and mute state after reload; and
- links directly to the original source page.

Automated Playwright acceptance covers desktop Chromium, Firefox, WebKit, and
Pixel 7 mobile-Chromium emulation. It exercises the real catalog, waveform pack,
YM6, WASM synthesizer, Web Audio scheduling, A/B/C meters, persistence, controls,
attribution, and end detection without mocked metadata or audio.

## Reproduction

```sh
npm run content:generate
npm run content:validate
npm test
npm run test:e2e
npm run lint
npm run format:check
npm run build
```

Manual audible review: **passed 2026-07-21**. The user tested **Solitude** and
reported that it plays correctly. The exact browser version was not reported.
