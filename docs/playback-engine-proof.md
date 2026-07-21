# Playback-Engine Proof of Concept

Status: **passed on 2026-07-21**. The project keeps `ym2149-rs`; the Game Music
Emu fallback was not triggered because the mandatory failures found upstream
have maintainable application-adapter corrections that pass the same objective
checks.

## Pinned Engine

- Upstream: <https://github.com/slippyex/ym2149-rs>
- Release: `v0.9.1`
- Commit: `b3096aac0dcab6dd1d82c0209f579761943aadc6`
- License: MIT; reproduced in `vendor/ym2149/LICENSE`
- Rust toolchain: `1.88.0`
- WASM target: `wasm32-unknown-unknown`
- `wasm-bindgen-cli`: `0.2.105`
- Engine-native sample rate: 44,100 Hz
- Application offline-render and waveform-input rate: 48,000 Hz

The release's checked-in WASM was stale and did not contain
`generateSamplesWithChannels`, `getChannelOutputs`, `loop_count`, or
`channelCount`, although those APIs exist in the tagged Rust source. The
repository therefore carries a source rebuild from the exact commit rather
than adopting the stale upstream binary.

The tagged upstream `Cargo.lock` was also incomplete for `r68k`: it named
version `0.2.1` without a source or checksum while the source requires the
external `0.2.2` crate. The vendored lock resolves only that entry to the
published `r68k 0.2.2` checksum. A second build with that lock and `--locked`
passes. This is a dependency-resolution correction, not an engine source fork.

Artifact integrity is enforced by `npm run engine:verify` and by the production
build. The authoritative hashes live in `vendor/ym2149/manifest.json`:

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `Cargo.lock`               | `32c7c3e4c859a550584766cb66c26b9919f3926fe5f9edb900da536c01576120` |
| `LICENSE`                  | `08553388cef2a01b79813ce167b7cca8bd6b5db5427ca01b713e1911329f391f` |
| `ym2149_wasm.js`           | `f5e081385bda611984528cc7f3abe5e34ae2e8efc4f03741f908662ae3b122eb` |
| `ym2149_wasm.d.ts`         | `be21e2fa0d4fb3206337fd8e04811f06be8dbdb91067adab3908a9ad9e3b72ef` |
| `ym2149_wasm_bg.wasm`      | `c5b064a9f75b6f38ada5a8de3ced9b0ca48dc9d5049ee71713dd1c6f0e10aedf` |
| `ym2149_wasm_bg.wasm.d.ts` | `02521aa9c2e5ed0a61579f8ec49b077614cbba5407f440ecd60f448dc1e27648` |

The WASM is emitted as a separate lazy playback asset. The verified production
build reports approximately 411.38 kB gzip for WASM and 79.96 kB gzip for the
initial JavaScript, so the engine does not enter the initial bundle.

## Fixture Matrix

| Fixture                 | Ownership/source                                                                                                         | Path exercised                                                                           | Result                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pator-solitude.psg`    | Pator; downloaded from the direct ZX-Art URL in [IDEA.md](./IDEA.md); permission evidence remains the ZX-Art source page | Real PSG parse → YM6 → runtime, fixed seek matrix, complete A/B/C render, waveform input | Pass: 63,474 bytes, SHA-256 `6264516620313219de9a7e8b2d21d07e47f83b0b833d893646653abf64b14857`, 8,651 frames, 173.02 s |
| Synthetic PSG           | Project-created                                                                                                          | Register writes, short delay, extended delay, PSG → YM6                                  | Pass                                                                                                                   |
| Finite synthetic AY     | Project-created executable ZXAY/EMUL Z80 fixture                                                                         | Direct AY capture → finite YM6, full mix and isolated A/B/C equivalence                  | Pass, maximum sample difference `0`                                                                                    |
| Looping synthetic AY    | Project-created executable ZXAY/EMUL Z80 fixture                                                                         | Explicit duration override capture → finite YM6, full mix and isolated A/B/C equivalence | Pass, maximum sample difference `0`                                                                                    |
| Compliant synthetic YM6 | Project-created                                                                                                          | Byte-identical canonical-runtime copy                                                    | Pass                                                                                                                   |
| Synthetic YM3           | Project-created                                                                                                          | Supported noncompliant YM normalization → YM6                                            | Pass                                                                                                                   |

The PSG parser deliberately supports the uncompressed AY Emulator stream
contract only. It rejects invalid signatures, truncation, zero extended delays,
trailing bytes after end-of-music, and unimplemented commands with a byte
offset.

## Mandatory Results

| Criterion                        | Objective evidence                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load and real browser playback   | The user-gesture diagnostic loads the real WASM, schedules stereo Web Audio buffers, and passes in Chromium, Firefox, and WebKit.                                                                                                                   |
| Play, pause, resume, stop, end   | Browser tests exercise all lifecycle transitions. Stop resets to ready at zero; natural completion enters ended.                                                                                                                                    |
| Volume and mute                  | The live proof changes master volume, verifies zero-volume and mute silence the reported output, then restores audible gain.                                                                                                                        |
| Accurate seeking and restoration | Restoration loads the requested position and remains ready/paused. Solitude passes independent seeks at 0%, 25%, 50%, 75%, and one second before the end, comparing the following second with uninterrupted playback at maximum error ≤ `0.000001`. |
| Exact A/B/C samples              | Runtime YM exposes three genuine per-sample channel arrays. All three contain real activity in the synthetic and Solitude complete-track renders.                                                                                                   |
| Complete offline waveform input  | Solitude renders 8,304,960 samples per channel at 48 kHz, then produces one 12,288-byte, 2,048-bucket A/B/C waveform payload without the reserved `-128` value.                                                                                     |
| AY and YM chip curves            | Runtime channel samples select either the pinned YM logarithmic table or the measured 16-level AY table at the adapter boundary. Tests prove the models are distinct.                                                                               |
| Browser matrix                   | Playwright passes desktop Chromium 149, Firefox 151, WebKit 26.5, and Pixel 7 mobile-Chromium emulation. The release gate still requires real iOS Safari and Android Chrome devices as specified in [IDEA.md](./IDEA.md).                           |
| Reproducible self-hosting        | JS, declarations, WASM, corrected lock, license, hashes, rebuild command, and stale-artifact verification are repository-tracked. Normal install/build remains Node-only and has no runtime service dependency.                                     |

Measured locally on the proof machine, reconstructing engine state one second
before the end of Solitude took approximately 202 ms; a complete 173.02-second
A/B/C render and 44.1-to-48 kHz conversion took approximately 2.18 seconds.
These measurements are diagnostic rather than release performance budgets.

## Adapter Corrections and Known Limitations

### Native YM seek does not preserve synthesis phase

At a one-second seek in the project fixture, upstream native `seek_to_frame`
produced a maximum A/B/C sample difference of `1.6817432641983032` against
uninterrupted playback. It moves the frame sequencer but does not reconstruct
tone, noise, envelope, and effect phase.

The application adapter creates a fresh engine and deterministically renders
from zero to the requested native sample. That correction produces maximum
difference `0` in the focused fixture and passes the full Solitude seek matrix.
It is bounded, isolated, requires no engine fork, and can be replaced by a
future upstream stateful seek API without changing the controller contract.

### Direct AY channel observation is frame-end cached

The upstream AY WASM wrapper renders internally in frame-sized caches. Its
`generateSamplesWithChannels` loop reads channel state while draining that
cache, so the reported direct-AY A/B/C values can reflect the frame-end state
instead of each emitted sample. This path is not used by the browser: AY is
captured to canonical YM6 during preparation.

The build-time equivalence gate works around the observation limitation by
rendering the authoritative AY source and generated YM once as a full mix and
once with each of A, B, and C isolated through the engine's channel muting. The
finite and duration-overridden fixtures match exactly in all four renders. The
generated YM runtime then exposes correct per-sample A/B/C values normally.

### Sample-rate boundary

The pinned WASM synthesizes at 44,100 Hz. Browser playback supplies buffers at
their declared native rate and lets Web Audio perform device-rate conversion.
Content preparation uses one deterministic, continuous linear conversion to
48,000 Hz before waveform bucketing. Conversion operates identically for every
track and channel and performs no per-track normalization.

### Automated browser scope

Headless Chromium advances its audio clock more slowly than wall time. Browser
acceptance waits on the audio clock rather than assuming timer equality. This
does not alter adapter position semantics. Physical mobile devices and manual
listening remain later release-gate work, exactly as required by
[IDEA.md](./IDEA.md).

## Reproduction

Ordinary verification requires only the pinned Node/npm toolchain:

```sh
npm ci
npm run engine:verify
npm test
npm run test:e2e
npm run lint
npm run format:check
npm run build
```

Rebuilding the vendor artifacts is an exceptional maintainer operation:

```sh
rustup toolchain install 1.88.0 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown
rustup run 1.88.0 cargo install wasm-bindgen-cli --version 0.2.105 --locked
npm run engine:rebuild
```

The rebuild script checks out the exact commit, applies the repository-pinned
lockfile, builds with `--locked`, regenerates the web bindings, and finishes by
running the artifact hash gate.
