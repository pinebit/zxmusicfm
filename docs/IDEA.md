# ZX-MUSIC.FM

It is a simple, polished public web application for listening to a curated collection of ZX Spectrum music tracks. The MVP is a music player rather than a community archive or a technical emulation showcase. It does not include user accounts or an administration interface.

## User Experience

The webapp is a single-page application. Its visual direction is a modern, polished interface strongly inspired by ZX Spectrum hardware and branding, rather than a literal recreation of a 1980s interface. It uses one consistent dark charcoal and graphite hardware palette, warm cream text, amber controls and meters, and muted pastel rose/sand/cyan channel traces. Saturated red is reserved for live/error meaning, while bright cyan is reserved for keyboard focus; restrained Spectrum-inspired red, yellow, green, and cyan remain in the brand stripe. The playback deck evokes a low, wide black-metal hi-fi signal monitor with inset orange meter glass, fine printed scales, tactile circular controls, and subtle edge highlights; it does not copy another manufacturer's branding. On narrow layouts, this deck appears before the track catalog so playback status and controls remain prominent. The MVP has no light theme.

It uses an original **ZX-MUSIC.FM** wordmark, a Spectrum-inspired color stripe motif, and an original CSS-rendered DIP microchip graphic marked `AY-3-8910`. It must not present itself as an official Sinclair or ZX Spectrum product or use a historical logo in a way that implies endorsement. Appropriately licensed fonts are bundled locally, with a geometric display face for branding and a highly legible sans-serif for controls and metadata. The application makes no remote font requests and does not use a pixel font for body text.

The top-level design is a two-pane layout:

- One pane is a list of curated ZX Spectrum music tracks.
- Second pane is three analogue indicators rendering each channel's level (A, B, C).

For Desktop layout, the two panes are side-by-side, with approximately 60% of the available width assigned to the track list and 40% to the meter panel. The ratio adapts fluidly rather than relying on fixed pixel widths. The meter panel remains sticky within the viewport while the document and track list scroll normally; the track pane does not introduce a nested internal scrollbar.

For mobile layout, the two panes are stacked vertically with the track list first and the channel meters second, both in normal document flow. Within the mobile meter panel, the A/B/C meters remain side by side in one compact row while preserving readable labels and scales; the page does not require horizontal scrolling.

Responsive behavior is content-driven rather than tied to a device brand. Acceptance screenshots and interaction checks cover viewport widths of 320, 375, 768, 1024, and 1440 CSS pixels at normal zoom, plus 200% browser zoom on desktop. The implementation chooses the exact pane-stacking breakpoint based on the layout meeting these requirements; it must not special-case user agents.

The track list is a single scrollable collection. Search, filtering, and categories are outside the MVP. The playback deck offers **Auto-Play Next** and **Shuffle** as independent labeled hardware push-button toggles with visible on/off lamps. On a user's first visit, Auto-Play Next is enabled and Shuffle is disabled. Their settings persist across page reloads. Shuffle avoids repeating a track until every track in the current collection has played. When Auto-Play Next reaches the end of the collection, playback wraps to the beginning and continues.

When the catalog contains only one valid track, Auto-Play Next stops at its end rather than implicitly repeating it. Shuffle is disabled whenever fewer than two valid tracks are present, with an accessible explanation that more tracks are required.

A valid empty catalog shows the normal application shell, a clear **No tracks available** empty state, and disabled playback, sequencing, seek, and volume controls. It does not show a catalog error or placeholder track. Catalog size is a curatorial and deployment choice rather than a validation constraint.

The player also persists the selected track and its playback position locally. While playing, it checkpoints the position at most once every five seconds; it also saves immediately after pause, a committed seek, a track change, and the browser's `pagehide` event. Persistence is best-effort and never delays or blocks playback or navigation. After a page reload, it restores that track and position along with the volume, Auto-Play Next, and Shuffle settings. The restored track is visibly selected at the saved position but remains paused until the user presses Play.

The application never starts audio merely because the page was opened or reloaded. Initial playback always requires the user to press Play. Auto-Play Next applies only after user-initiated playback reaches the end of a track.

On initial page load, the application fetches the generated catalog and one compact binary waveform pack containing peak data for the complete catalog, but it does not download every music file. A music file is fetched only when its track is selected. The application does not prefetch the next sequential or shuffled track, even while the current track is playing. Before decoding the waveform pack or a runtime music asset, compare its fetched byte length and SHA-256 digest with the catalog using the Web Crypto API. A mismatch follows the corresponding waveform or track error path and the bytes are never passed to a decoder. While a selected file is loading or being verified, the row shows a clear loading state and prevents duplicate playback actions.

If the catalog request, schema validation, or catalog decoding fails at runtime, the application shell remains usable and displays a page-level recoverable error with a Retry action and an actionable but non-technical message. No track rows or invented fallback metadata are shown from an invalid catalog. Retry refetches and revalidates the catalog without requiring a full page reload. A catalog failure is distinct from the waveform-pack and individual music-file failure states below.

Failure to fetch or decode the waveform pack does not disable music playback. Each row substitutes an accessible conventional seek slider for its canvas waveform and presents one concise non-blocking waveform-unavailable status. The fallback exposes the same range value, keyboard commands, pointer behavior, and played position where applicable. Retrying the page-level waveform request may restore the visual waveforms without reloading or restarting the selected music file.

If the browser lacks a required Web Audio, WebAssembly, or Web Crypto capability, the catalog remains readable, playback controls are disabled, and the application shows a clear compatibility message. It does not fail to a blank page or attempt a separate prerecorded-audio fallback. Canvas failure alone uses the conventional seek-slider fallback rather than disabling playback.

If a music-file request fails, playback stops and the row presents an inline error with a Retry action. The selected track and requested playback position are preserved so a successful retry can continue from the intended point. If browser audio is suspended or startup is blocked, present a non-destructive **Tap/click to enable audio** action and retry from the requested position after a user gesture.

Playback should continue when the page is backgrounded where the browser permits it. Reliable playback while a device is locked or the browser suspends the page is not an MVP guarantee, and the application must recover cleanly when it returns to the foreground.

If Shuffle is enabled while a track is playing, the current track continues uninterrupted. When it finishes, the player starts a randomized cycle containing every other track exactly once. After that cycle is exhausted, it creates a new shuffled cycle, avoiding an immediate repeat across the cycle boundary when possible.

Track transitions do not crossfade or overlap. When Auto-Play Next is enabled, the current track reaches its defined end, settles its controls and meters, and then the next track enters its loading state and begins once ready. A short network or decoding gap is acceptable and must be represented honestly as loading rather than filled by repeated or prerecorded audio.

If Shuffle is turned off during a shuffled cycle, the current track continues, the remaining shuffled queue is discarded, and the next automatic or manual Next action uses the current track's successor in curated order. Enabling Auto-Play Next after a track has already finished does not start audio; the user must press Play again.

If the user manually selects a track during a shuffled cycle, it plays immediately and is removed from the remaining cycle so it cannot repeat before that cycle resets. The exact shuffled queue is not persisted. After a reload, Shuffle remains enabled but a fresh cycle is created that excludes the restored selected track.

The Media Session Next action follows the active curated or shuffled sequence. Previous walks backward through tracks actually listened to during the current page session. If there is no prior listening history, Previous restarts the selected track. Listening history is not persisted across reloads.

Around the two panes, there are stylized, original ZX Spectrum-inspired graphics and the original ZX-MUSIC.FM wordmark.

An Equalizer panel may be considered after the MVP but is explicitly outside the MVP scope.

### Songs List Panel

Each track has a play/pause button that allows the user to listen to the track. Only one track can play at a time. Starting another track stops the current track rather than preserving its playback position.

Each row renders its title and author together on one compact `TITLE / AUTHOR` line in the same bold type size, immediately followed by an accessible external-link icon for the original source. The icon has no visible "Original source" label. The row also includes its total duration, waveform, and a compact hardware-style play/pause push button. That button shares the deck's graphite surface, bevel, highlight, and physical pressed state, but uses a softly rectangular mounting shape so it remains distinct from the deck transport. Rows are not numbered. Year and notes remain optional catalog metadata and are not shown inline.

For each track, it renders a real waveform of the track. The waveform also acts as the seek control, allowing the user to move playback to a specific position without a separate playback slider.

Clicking or tapping an inactive track's waveform selects that track, seeks to the chosen position, and starts playback. The active waveform shows played and unplayed portions and exposes its current position accessibly. Pointer or touch dragging previews the prospective time in the UI without repeatedly seeking the engine; releasing commits one seek. Cancelling the gesture restores the displayed actual position. A simple click or tap commits immediately.

When the combined waveform seek control has focus, Left and Down seek backward five seconds, Right and Up seek forward five seconds, Page Down seeks backward 10% of total duration, Page Up seeks forward 10%, Home seeks to zero, and End seeks to the track duration. All results clamp to the valid range. Keyboard actions commit immediately and update the accessible elapsed-time value.

The active track shows elapsed and total time. Inactive rows show total duration only. Times use a compact `m:ss` representation for tracks under one hour and `h:mm:ss` when needed. The playback deck renders elapsed/total time with a self-contained CSS seven-segment LED display, while catalog-row durations remain simple text. The segmented shapes are decorative; the semantic time exposes the complete elapsed and total values to assistive technology.

Pressing Pause preserves the current position, and pressing Play on the same track resumes it. When a track finishes with Auto-Play Next disabled, it remains selected at the end; pressing Play restarts it from the beginning. Starting a different track resets the previous track to its beginning.

Waveform peak data is generated separately from the exact pre-pan, pre-master-volume output of AY/YM channels A, B, and C and cached during content preparation or the production build, rather than calculated in the listener's browser. It therefore shows genuine channel activity, remains stable when the listener changes volume, and requires no runtime audio analysis. This keeps all waveforms quick to display. The peak data is derived content and does not need to be entered by hand.

The UI presents those three envelopes as three labeled, vertically stacked lanes within one waveform and one seek control. Channel A is always a muted pastel rose, B is always warm pastel sand, and C is always powder cyan; the ambient, low-saturation palette identifies logical channels without competing with the playback deck and does not change when `channelLayout` changes their stereo positions. Each channel letter sits in a compact dark instrument-style badge with a matching pastel border so it remains legible over every waveform. Lane position and text labels communicate channel identity without relying on color. All three channels are always visible in the MVP, with no per-channel waveform toggles. Playback progress is applied consistently across all three lanes, making the played and unplayed regions distinguishable by more than color alone. Only the selected track renders the vertical position marker; inactive rows do not show a zero-position bar. The accessible name, current value, keyboard behavior, and pointer/touch hit target belong to the combined seek control rather than to three separate interactive elements.

Waveforms render with the Canvas 2D API, using device-pixel-ratio-aware backing dimensions while their CSS size follows the responsive row layout. Canvas is only the visual layer: an overlaid or enclosing semantic seek control provides focus, range semantics, keyboard operation, and accessible value text. Rendering and progress updates must not cause React rerenders at animation-frame frequency.

If a track cannot be loaded, decoded, or played, its row displays a clear inline error and playback stops. The player does not silently skip the track, even when Auto-Play Next is enabled.

### Channel Level Indicators Panel

Each indicator is a physical analogue-style VU meter shaped as an old hi-fi half-dome, with a moving needle, arched scale, warm illumination, glass highlight, metal pivot, and a clear A, B, or C label. It shows the current level of the corresponding AY/YM audio channel in real time. Genuine per-channel data is used on every supported proof-of-concept path. A defensive visual approximation may be used only on an unsupported browser/runtime path where audio still works but channel taps are unavailable; it must be labeled as approximate in an accessible status and cannot be used to pass engine or supported-browser acceptance.

The meter panel uses the conventional broadcast label **ON AIR** with a red hardware lamp that illuminates only while playback is active. While live, the lamp uses a restrained looping CSS brightness/glow pulse; reduced-motion mode presents it as a steady light. The lamp is decorative: playback state remains apparent from the Play/Pause control and is live-announced to assistive technology without adding a visible status word. The panel shows the selected metadata as one large scrolling `TITLE / AUTHOR` dot-matrix LED line alongside the elapsed/total seven-segment display. The marquee uses the full available metadata width and moves slowly and seamlessly; reduced-motion mode shows static truncated text. Both displays expose their complete values to assistive technology rather than requiring the visual effects to be interpreted. Before any track has been selected, the panel displays a concise invitation to choose a track without inventing placeholder metadata.

Needles update at animation-frame cadence from a 50 ms rolling RMS level per channel. Map `-48 dBFS` or lower to the resting position and `0 dBFS` to full scale, clamp outside that range, and apply exponential smoothing with a 60 ms attack time and 300 ms release time. They settle to zero when playback is paused, stopped, finished, loading, or in an error state. Meter animation must not drive React component renders on every frame; use an animation-appropriate rendering path and clean it up when the component unmounts or the page is hidden.
The MVP includes a hardware-inspired rotary master-volume knob with accessible slider semantics and range `0` through `100`. Up/Right increase and Down/Left decrease by one percentage point, Page Up/Down change by ten points, and Home/End set zero/100. Pointer dragging uses a linear gesture—up or right increases and down or left decreases—rather than requiring the user to trace a circle. Values clamp to the range and are announced as percentages. The volume setting persists locally across page reloads.

Previous, Play/Pause, and Next use matching circular machined controls with the same dimensional graphite surface, bevel, highlight, and shadow language as the volume knob. Play/Pause is larger and uses an amber symbol, while all controls retain native button semantics and visible focus treatment. The three transport controls and the volume knob stay aligned in one control row at every supported responsive width.

On a first visit, master volume is 80%. Moving it to zero produces silent output.

Playback uses conventional equal-power stereo placement derived from `channelLayout`. For `ABC`, channel A is fully left, B is centered, and C is fully right. For `ACB`, A is fully left, C is centered, and B is fully right. The adapter applies one fixed, track-independent mix headroom that prevents ordinary three-channel output from clipping. It uses the pinned engine's chip-accurate nonlinear AY or YM amplitude model selected by `chipType`; it does not apply per-track peak normalization, loudness normalization, automatic gain control, compression, or limiting. The master-volume control is the only listener-controlled gain stage.

### The Footer

The footer renders the application version from the root package metadata, links to the planned source repository at https://github.com/pinebit/zxmusicfm and to [ZX-Art's ZX Spectrum music collection](https://zxart.ee/eng/music/), and contains a Credits/License control similar in purpose to https://aym-js.emaxilde.net/license/. These secondary footer controls use a muted neutral gray rather than the brighter amber reserved for playback interactions. The displayed version must not be maintained separately from `package.json`.

Activating Credits/License opens an accessible modal dialog without changing routes. The dialog groups notices into application, playback engine, and dependencies; its application notice credits creator Andrei Smirnov and links safely to `https://github.com/pinebit`. It traps focus while open, closes by its close control or Escape, and restores focus to the trigger. Track attribution is provided directly in each catalog row rather than duplicated in this dialog.

The source repository, ZX-Art, and individual track-source links open in a new tab using safe `noopener noreferrer` behavior. The planned repository URL is allowed to remain unavailable during initial specification work but must resolve before the public launch.

The MVP does not offer direct downloads of bundled music files. Each track provides its original source link instead.

A Support button may be added after the MVP but is explicitly outside the MVP scope.

### Accessibility

The target is WCAG 2.2 Level AA. All interactive controls must be keyboard-operable and have accessible names, visible focus states, and sufficient color contrast. Status and error information must not rely on color alone. Motion respects the user's `prefers-reduced-motion` setting; reduced motion simplifies or disables decorative animation without hiding playback state.

Standard focused-control keyboard interaction is required. When focus is not in a text-entry or range control, Space toggles play/pause for the selected track and prevents page scrolling. Where the browser supports the Media Session API, expose play, pause, next, and previous actions and current track metadata. Lack of Media Session support must not affect normal playback.

Automated component and browser checks include an accessibility scanner and fail on serious or critical findings. Manual acceptance covers complete keyboard-only journeys, 200% zoom, forced/high-contrast behavior where supported, reduced motion, and one current screen-reader/browser combination on macOS or iOS plus one on Windows when that platform is available. Automated scanning supplements rather than replaces the manual WCAG 2.2 AA review.

## Development

### Playback Engine

The application owns one playback controller and at most one active playback-engine instance. Components issue commands to this controller rather than calling the engine or Web Audio APIs directly. The controller owns selection, requested and actual position, playback lifecycle, volume, sequencing, history, errors, and engine cleanup. It lazily creates at most one `AudioContext` after an allowed user gesture, reuses it across track changes, resumes it after browser suspension only through a user-permitted path, and closes it when the controller is permanently disposed. A new track replaces the previous engine content; simultaneous or overlapping track engines are outside the MVP.

The controller exposes an explicit discriminated state machine:

- `idle`: no track is selected or loaded.
- `loading`: a track is selected and its engine code, music bytes, decoding, or requested initial seek is pending.
- `ready`: the selected track is loaded at its requested position but has not started in the current action flow.
- `playing`: the selected track is producing or scheduled to produce audible playback.
- `paused`: playback began previously and is stopped at a resumable position before the end.
- `ended`: the track reached its defined duration and is positioned at the end.
- `error`: a catalog-independent playback operation failed; the state carries the affected track, operation, recoverability, requested position, and user-facing error category.

Selection from any state starts `loading`. Successful loading enters `ready`, then enters `playing` only when the triggering action is permitted to start audio; restoration after reload remains `ready`. Pause moves `playing` to `paused`; Play moves `ready` or `paused` to `playing`; natural completion moves `playing` to `ended` before any Auto-Play Next selection begins. Retry moves a recoverable track error back to `loading`. Selecting a different track clears the prior track-scoped error and position as specified elsewhere. Invalid commands are ignored safely and must not create impossible mixed states such as simultaneously loading and playing.

Every asynchronous selection/load operation has an `AbortController` where the underlying API supports cancellation and a monotonically increasing selection generation regardless. Changing selection, retrying, or disposing the controller aborts applicable fetches and invalidates the prior generation. A late fetch, decoder, WebAssembly, or seek completion must compare its generation before mutating state, attaching audio nodes, or starting playback; stale results are disposed and ignored. Tests must cover rapid selection changes, a stale failure arriving after a newer success, and controller disposal during loading.

The controller is an external state source with subscribed immutable snapshots integrated into React through `useSyncExternalStore`. High-frequency playback position, waveform progress, and meter samples use animation-oriented mutable data paths and must not publish React snapshots on every audio or animation frame. The controller still publishes semantic transitions, user-committed seeks, checkpoint times, and coarse display-time updates needed by accessible text. Subscription and animation callbacks are removed on unmount or controller disposal.

The selected playback engine is [`ym2149-rs`](https://github.com/slippyex/ym2149-rs), using its Rust/WebAssembly browser integration behind an application-owned TypeScript adapter. It is MIT-licensed, loads the canonical runtime files directly, exposes metadata and playback controls, produces exact per-channel samples for the A/B/C meters, and renders audio for waveform generation. The mandatory proof of concept passed at pinned commit `b3096aac0dcab6dd1d82c0209f579761943aadc6`; objective results are recorded in `docs/playback-engine-proof.md`.

This selection is subject to a mandatory proof of concept that is completed and documented before the main interface is implemented. PSG is expected to be the predominant authoritative source format in the catalog, so PSG import and conversion are a primary proof-of-concept path rather than an edge case. Test multiple representative `.psg` tracks, including the seed track below, plus representative `.ay` and `.ym` tracks and every canonical-runtime conversion path described below, and verify all of the following:

- Loading and playback are reliable and audibly correct.
- Play, pause, resume, stop, end detection, and volume behave correctly.
- Seeking and restoration of a persisted playback position work accurately.
- Exact per-channel sample output can drive the A/B/C meters in real time.
- The same engine can render complete tracks during content preparation to generate real waveform peak data.
- Playback works in the supported desktop browsers, iOS Safari, and Android Chrome.
- The engine and its WebAssembly assets can be built and deployed reproducibly without a runtime dependency on a third-party service.

The minimum proof-of-concept matrix includes the real `pator-solitude` PSG, one small synthetic PSG exercising register writes and short/extended delays, one finite AY subsong, one looping AY subsong using an explicit duration override, one compliant seekable YM source copied unchanged, and one supported YM source that requires YM6 normalization. Fixtures may satisfy more than one criterion but every input and runtime path must be represented. Automated checks run in Chromium, Firefox, and WebKit through Playwright; the later release gate adds the specified real mobile browsers and manual listening.

The current `ym2149-rs` browser API supports native seeking for YM files but not for AY files. Because seeking is an MVP requirement, the browser does not play authoritative AY files directly and does not implement reset-and-fast-forward seeking. Content preparation executes the selected AY subsong deterministically through the pinned engine, captures its chip-register frames, and converts it to a finite, seekable YM6 runtime asset. AY support is complete only when that capture and conversion pass the same duration, channel, register, audio, seeking, and waveform equivalence gate required of PSG conversion.

If the proof of concept exposes unacceptable compatibility, audio accuracy, seeking, browser, or maintenance problems, the fallback is [Game Music Emu](https://github.com/libgme/game-music-emu) with a project-owned WebAssembly integration. The fallback must pass the same proof-of-concept criteria. `aym-js` is not the preferred engine because its public player relies on preconverted JavaScript tracks and does not publish the required direct-file conversion pipeline.

The browser has one runtime music contract: every catalog entry points to `generated/playback.ym`, which must be a validated, finite, seekable YM-family asset. Content preparation always converts authoritative PSG and AY sources to YM6 while retaining the original bytes unchanged. An authoritative YM source that already passes all runtime requirements is copied byte-for-byte to `generated/playback.ym`; if it is supported but not compliant with the runtime contract, content preparation normalizes it to YM6. The generated copy or conversion is never presented as the authoritative original.

PSG is a first-class authoritative catalog source format and is expected to account for many tracks. AY and YM remain supported curator inputs. PT3, STC, and ASC tracker modules are also accepted curator sources because the selected ZX-Art candidates use those formats. No source-format parser or seeking difference escapes into the browser-facing player controller. The generated catalog records the authoritative source format separately from the derived PSG and generated runtime formats and points only to the generated runtime asset.

PSG conversion must preserve the declared chip type, chip clock, frame rate, channel layout, register-event sequence, duration, A/B/C channel behavior, and audible result. The converter must not silently assume machine timing: these properties are conditionally required PSG sidecar metadata and are included in generated provenance. Conversion and validation operate deterministically from the authoritative PSG bytes and sidecar. PSG streams are finite: playback ends after the final encoded frame, no loop is inferred, and leading or trailing silence is not trimmed. A format is considered supported only after playback, seeking, duration, end detection, persisted-position restoration, exact channel output, and waveform generation all pass validation. Other formats exposed by the engine, including `.aks` and `.sndh`, are outside the MVP until they are explicitly added and pass the same validation.

PT3, STC, and ASC preparation uses the official ZXTune `zxtune123` CLI pinned to commit `8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a` and its `mode=psg` conversion. It runs only in a project-defined Linux Docker image on the curator's macOS machine; no Android application or Android build is involved. The container has no network while processing music, runs read-only without capabilities, and receives only an isolated working directory. ZXTune's index output must identify the same format as the supplied `.pt3`, `.stc`, or `.asc` extension before conversion. The original tracker bytes remain authoritative. `generated/source.psg` is a derived finite register stream, and `generated/tracker-conversion.json` records the ZXTune commit, detected format, original hash, PSG hash, and byte length. Content generation rebuilds those two files; read-only production validation verifies their hashes and then applies the complete PSG-to-YM6, seek, channel, waveform, and freshness gates. The deployed application has no ZXTune or Docker runtime dependency.

Pin the playback engine to an exact upstream release or commit and provide a reproducible build for it. Prepare the generated WebAssembly module and its JavaScript/TypeScript bindings as repository-tracked release artifacts so ordinary application development, production builds, and Vercel deployment require only the Node.js toolchain. Document how to rebuild the engine artifacts and provide a build-time check that detects stale generated artifacts.

The frontend stack is React, TypeScript, and Vite. Styling uses project-owned custom CSS without a heavyweight component library. The project must remain easy to install, run, test, and build locally with the Node.js toolchain.

Use npm with a lockfile prepared for source control and reproducible dependency resolution. During Phase 1, select the then-current Active LTS Node.js major, pin that major in `engines`, pin the exact development patch in the repository's version-manager file, and pin the exact npm version in `packageManager`. Do not float these versions during implementation. A clean checkout installs with `npm ci`; documentation and automation must not substitute `npm install` when verifying the lockfile. TypeScript runs in strict mode. ESLint uses its flat configuration, Prettier owns formatting, and production compilation must report unchecked errors rather than silently accepting them. The project is one root npm package, not a monorepo, and has no Git hook framework in the MVP.

The root package exposes this stable command contract:

- `npm run dev`: start the Vite development server.
- `npm run build`: run read-only content validation and generated-artifact freshness checks, run the TypeScript sanity compilation, and only then create the Vite production build. Any stage failure stops the command with a nonzero exit status.
- `npm run typecheck`: run the strict TypeScript sanity check without emitting application files.
- `npm run lint`: run ESLint across project-owned source, tests, and tooling.
- `npm run format:check`: check formatting without rewriting files.
- `npm test`: run the Vitest unit, component, content-tooling, and real-engine automated tests that do not require full browser journeys.
- `npm run test:e2e`: run the Playwright desktop and mobile browser journeys.
- `npm run content:import`: add one local or remote track through the import workflow.
- `npm run content:update`: update metadata, ordering, or—only with its explicit option—the authoritative source for one existing track.
- `npm run content:remove`: run the confirmed removal workflow for one track.
- `npm run content:generate`: reproducibly regenerate all derived track assets, provenance, the catalog, and the waveform pack from authoritative sources.
- `npm run content:validate`: perform read-only schema, rights, format, conversion-equivalence, catalog, waveform-pack, and freshness validation.

The content commands forward documented command-line arguments after `--`, support the interactive and non-interactive behavior defined below, print actionable errors to standard error, and return a nonzero status for any failure. `build` must call the same validation implementation as `content:validate`, not maintain a weaker duplicate validator.

Use Vitest and React Testing Library for application logic and component tests, and Playwright for essential desktop and mobile user journeys. UI tests use an adapter mock for deterministic playback state. Separate real-engine fixture tests cover representative PSG-to-YM6 and AY-to-YM6 conversions, direct-copy compliant YM sources, normalized YM sources, and the common generated-YM runtime path. They verify loading, seeking, duration, end detection, exact per-channel output, and waveform generation. Manual listening remains useful but is not a substitute for these automated behavioral checks.

Test fixtures should be small, project-created synthetic files where practical. Any third-party fixture must have documented redistribution permission, source, author, and license. Do not assume that an upstream engine example track's source-code license also licenses its music.

Continuous integration is intentionally minimal: it performs a TypeScript sanity check and a production build only. No separate CI jobs are required for linting, formatting, unit tests, browser tests, or accessibility checks. These checks remain documented local development commands. The production build itself performs content validation and generated-artifact freshness checks, so invalid or stale content still fails the build.

The MVP has no service worker, installable PWA behavior, or offline mode. It also has no analytics, advertising, tracking, cookies, or remote telemetry. Local storage is used only for the user-controlled playback state described in this document.

Unavailable, quota-limited, or corrupt local storage never blocks playback. The application uses safe in-memory defaults for the session and discards only stored values that fail validation. If a persisted track ID no longer exists in the generated catalog, clear only the saved track and position while retaining valid volume, Auto-Play Next, and Shuffle settings.

Persist all player preferences under the single local-storage key `zxmusicfm.player.v1` as JSON with exactly these fields. On first read after the project rename, migrate valid preferences from the former project-name key and remove that key when storage permits:

- `schemaVersion`: `1`.
- `selectedTrackId`: a track ID string or `null`.
- `positionSeconds`: a finite nonnegative number.
- `volume`: a finite number from `0` through `1`.
- `autoPlayNext`: a boolean.
- `shuffle`: a boolean.

A missing, non-object, unparsable, or wrong-version value uses all first-visit defaults. For schema version `1`, validate fields independently: an invalid preference uses its default without discarding other valid preferences. A position is retained only with a valid selected track ID and is clamped to that track's generated duration after the catalog loads. Unknown fields are ignored. Writes serialize a fresh complete object and catch storage exceptions. Listening history, the shuffled queue, transient errors, loading state, and playing/paused state are never persisted.

Playback engine code and WebAssembly are lazy-loaded rather than included in the initial application bundle. Music files remain lazy-loaded per the user-experience requirements. On a cold cache, the total encoded transfer for HTML, CSS, initial JavaScript, catalog, waveform pack, initially used fonts, and above-the-fold images before playback-engine or music downloads must remain below 500 KB. Measure the production build with a 375-by-812 viewport, four-times CPU slowdown, 1.6 Mbps downstream, 750 Kbps upstream, and 150 ms round-trip latency. Record three runs and use their median; Largest Contentful Paint must be below 2.5 seconds and Cumulative Layout Shift below 0.1. During a separate ten-second playback trace on the same CPU profile, waveform and meter animation must average at least 55 rendered frames per second with no audible underrun attributable to UI work.

All generated public playback, waveform, and other track-asset URLs contain a digest of the served bytes and use `Cache-Control: public, max-age=31536000, immutable`. The public waveform filename is `waveforms.<sha256>.bin`, using the lowercase hexadecimal SHA-256 digest of the complete served file. HTML and the stable catalog manifest use `Cache-Control: public, max-age=0, must-revalidate`, so a deployment can point clients to new hashed assets immediately. The catalog must never reuse a URL for different bytes. Authoritative `source.*`, sidecars, and internal provenance are excluded from public build output. Repository-side generated filenames may remain stable, including `generated/playback.ym`; fingerprinting occurs when producing public build output.

Support the current and previous major versions of Chrome, Firefox, Safari, and Edge, as well as the current versions of iOS Safari and Android Chrome.

The public site is indexable. It provides a descriptive document title and description, canonical URL, Open Graph metadata, and equivalent social metadata. The canonical production URL is configuration rather than hard-coded speculation and must be supplied and verified before public launch.

Implementation includes original Spectrum-inspired favicon, application-icon, and Open Graph preview assets consistent with the visual system. These assets must use original artwork and locally bundled resources.

Vercel deployment sets a restrictive but practical Content Security Policy and standard security headers. The baseline is `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`; `style-src 'self'`; `img-src 'self' data:`; `font-src 'self'`; `media-src 'self'`; `connect-src 'self'`; `worker-src 'self' blob:` only if the validated engine needs a worker/worklet blob; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; and `frame-ancestors 'none'`. Add `'unsafe-eval'` only if a supported browser demonstrably requires it for the pinned WebAssembly build and document that result; do not add broad remote origins or `'unsafe-inline'` as a convenience. Also send `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a Permissions Policy disabling camera, microphone, geolocation, payment, and other unused capabilities. Application code, audio, generated data, and fonts are self-hosted.

The project will be open-source from day zero, available on GitHub. Project-owned source code is licensed under the MIT License. Third-party engine, dependency, and music licenses remain separate and are reproduced or linked as their terms require; adopting a fallback component must not silently change the license of project-owned code.

The implementation agent initializes the local Git repository when it is not already initialized and prepares ignore rules, but must leave all work uncommitted and unstaged. It must not create commits or tags, configure or change remotes, publish a repository, open pull requests, or push anything. GitHub publication and the eventual commits are user-owned release actions after implementation handoff. Read-only Git inspection remains allowed.

Likewise, preparing and locally validating Vercel configuration is part of implementation, but creating or changing an external Vercel project or production deployment requires a separate explicit user instruction. The plan itself grants no authority to mutate external services. Without that authority, the implementation agent hands off a locally verified deployment-ready build and reports the remaining release action rather than weakening deployment acceptance.

All development will be driven by AI coding agents, like Claude Code and Codex CLI.

The interface is English-only in the MVP. User-facing strings are kept out of playback and business logic and centralized enough that future localization does not require architectural rework; a full internationalization framework is not required.

### Deployment

The production version will be deployed with Vercel.

### Content Import and Preparation Tooling

The repository includes a project-owned Node.js command-line tool for adding tracks. AY, YM, and PSG import and preparation require only the prepared Node-compatible playback-engine artifacts; they do not require Rust, `wasm-pack`, a native converter, or an external service. PT3, STC, and ASC import additionally requires Docker on macOS to build or run the pinned Linux ZXTune conversion image. The curator never installs or builds an Android application. The PSG parser and PSG-to-YM6 converter are project-owned TypeScript modules shared by the import, regeneration, and validation commands.

The importer accepts exactly one of:

- A local `.ay`, `.ym`, `.psg`, `.pt3`, `.stc`, or `.asc` file path.
- A direct HTTPS URL whose response is one of those supported files.

The importer does not scrape archive webpages or guess download links. A remote download URL and the required `sourceUrl` attribution value are separate inputs: the former retrieves the file, while the latter identifies the human-facing original source page. Local imports also require a `sourceUrl`. AY, YM, and PSG are detected from their signatures and structure. For PT3, STC, and ASC, the extension selects the candidate decoder and the pinned ZXTune index result independently confirms the actual module type before any write. A mismatch is reported explicitly and blocks import; the tool does not rename one format into another to bypass validation.

Remote retrieval follows these rules:

- The initial URL and every redirect target must use HTTPS and must not contain a username or password. URL fragments are discarded and credentials are never inferred from the environment.
- Redirects are handled explicitly, permit the standard redirect status codes only, and stop after at most five hops. Missing or invalid `Location` values, redirect loops, HTTPS downgrades, and a sixth redirect fail the import.
- Before every request, including each redirect, resolve and validate the destination. Reject localhost names and any destination resolving to a loopback, unspecified, link-local, private, carrier-grade NAT, unique-local, multicast, reserved, or IPv4-mapped equivalent address. If any returned address is prohibited, reject the destination rather than selecting another address. The HTTP connection must use the validated resolution so a second DNS lookup cannot redirect it to a prohibited address.
- Use one 30-second end-to-end deadline covering DNS, all redirects, headers, and the complete response body. Timeout aborts the request and removes temporary output.
- The final response must have a successful `2xx` status. Requests send no cookies, authorization, proxy authorization, or referrer and do not reuse credentials across redirects.
- A remote music file may contain at most 16 MiB (`16 * 1024 * 1024` bytes) after content decoding. Reject an excessive declared `Content-Length` before reading, and independently count streamed decoded bytes so a missing or dishonest header cannot bypass the limit. Empty responses also fail.

All remote failures report the sanitized URL or hostname, redirect hop when applicable, and failure category without echoing credentials or unrelated response-body content. Download into an import-scoped temporary location and calculate the authoritative content hash while streaming; only the already-defined atomic success path may move it into the collection.

For the MVP, PSG input means an uncompressed AY Emulator PSG register stream with the `PSG` plus `0x1A` signature and only commands implemented and tested by the project parser. ZIP, gzip, and archive-page inputs are rejected rather than unpacked implicitly. Malformed, truncated, or unknown PSG commands fail with a byte offset and actionable error. Supporting another PSG dialect or compressed container is a future explicit format addition and requires fixtures plus the same conversion-equivalence checks.

Every import requires the permanent `id`, unique `order`, and `sourceUrl`. The tool extracts title, author, year, duration, format, subsong information, and other usable metadata when the engine exposes it. In its default interactive mode, it shows the extracted values and prompts for any missing required metadata before proceeding. It must never invent placeholder titles, authors, attribution, or licenses. A non-interactive mode accepts metadata through arguments and fails with actionable missing-field errors rather than prompting.

Before writing, the importer validates the ID, order, URL, file type, selected subsong, and collisions against the existing collection. Importing never overwrites an existing track directory. Order is a contiguous, one-based display position. Importing at an occupied position atomically increments that track and every later track, including their sidecars; importing at the end uses the next position. Gaps and positions beyond the next valid position are rejected.

A successful import performs the complete workflow:

1. Copy or download the original file. For PT3, STC, or ASC, validate its ZXTune module type and deterministically generate the provenance-bound intermediate PSG in the sandboxed container.
2. Create the authoritative `track.json` sidecar.
3. Generate normalized per-track waveform peak data and rebuild the catalog-wide binary waveform pack.
4. Generate `generated/playback.ym`: convert every PSG, tracker-derived PSG, and AY source to YM6, copy a compliant seekable YM source byte-for-byte, or normalize another supported YM source to YM6.
5. Regenerate the collection catalog.
6. Run full content and generated-artifact validation.

Writes are atomic: a failed download, prompt, generation step, or validation must not leave a partial track directory or partially updated catalog. On success, the tool prints the created track ID, paths, detected format and duration, warnings, and validation result.

The tooling also provides explicit update and removal workflows:

- Updating a track may edit metadata and regenerate all affected derived data. Replacing the authoritative source file requires an explicit option. An update can never change the permanent track ID. Reordering a track shifts intervening tracks so order remains contiguous.
- Removing a track first displays the exact track directory and catalog entry affected, then requires confirmation. Non-interactive removal requires an explicit confirmation option. Removal closes the ordering gap, regenerates the catalog, and verifies all remaining content. Implementation must still follow the repository's safety guidance for destructive actions.

The curated set of music tracks will be manually prepared by myself and be part of this repository in an explicitly curated order. There is no minimum or maximum catalog size for development, preview, or release builds; deployment may proceed with any valid number of tracks, including an empty catalog. Every track that is present must still pass the complete schema, attribution, provenance, conversion-equivalence, runtime, waveform, ordering, and freshness checks. The implementation repository is seeded with the first real track below as soon as the import and PSG conversion tooling exists.

#### Seed Track

The first real catalog entry is [**Solitude** by Pator](https://zxart.ee/eng/authors/p/pator/solitude/), released in 2024 and listed by ZX-Art with a duration of 2:53.02. ZX-Art supplies a 63,474-byte PSG register dump. The ZX-Art page is the track's required original-source attribution.

No authoritative AY-format release was identified during specification research. ZX-Art consistently identifies this work as PSG, offers a separate modified-Vortex-Tracker source and an MP3 render, and records the author's warning that this particular tune needs PSG playback. Do not relabel an unofficial conversion as the original or replace the source with the MP3. PSG is a first-class authoritative curator input even though the browser consumes the generated YM6 representation.

Import it with these intended values:

- `id`: `pator-solitude`
- `order`: `1`
- `title`: `Solitude`
- `author`: `Pator`
- `sourceUrl`: `https://zxart.ee/eng/authors/p/pator/solitude/`
- `subsong`: `1`
- `chipType`: `AY`
- `chipClockHz`: `1773400`
- `frameRateHz`: `50`
- `channelLayout`: `ABC`
- `year`: `2024`
- Expected source duration: `173.02` seconds; use this for validation, not automatically as a duration override.
- Direct import URL: `https://zxart.ee/file/id%3A522870/filename%3APator_-_Solitude_%282024%29_%28Lost_Party_2024%2C_1%29.psg`

The importer retains this file as `source.psg`, converts it to a validated seekable YM6 playback asset using the declared AY chip, 1,773,400 Hz clock, 50 Hz frame rate, and ABC channel layout, and generates its waveform from the converted playback output. A conversion failure blocks the seed import and the engine proof of concept; it must not fall back to the available MP3 because that would lose genuine A/B/C channel data.

#### Initial Tracker Catalog

The next requested tunes are imported with their authoritative ZX-Art tracker formats:

- **Insomnia** by Mast (1999), PT3, AY, ABC: `https://zxart.ee/eng/authors/m/mast/insomnia/`
- **Hibernation** by MmcM (2016), PT3, YM, ABC: `https://zxart.ee/eng/authors/m/mmcm1/hibernation/`
- **LyraII8** by Ziutek (1991), STC, YM, ACB: `https://zxart.ee/eng/authors/z/ziutek/lyraii8/`
- **Insult3m** by Klav (1994), STC, AY, ACB: `https://zxart.ee/eng/authors/k/klav/insult3m/`
- **Batman** by Titus / Andrey Titov (1995), ASC, AY, ACB: `https://zxart.ee/eng/authors/t/andrey-titov/batman4/`
- **Assorty2** by IMP (1994), STC, AY, ACB: `https://zxart.ee/eng/authors/i/imp1/assorty2/`

The pinned ZXTune converter has been proven locally to produce valid finite PSG streams for these tracker formats, with durations consistent with the ZX-Art listings. Each imported track retains its ZX-Art page as the required original-source attribution. Per-track license fields are deliberately absent from the content and catalog contracts.

Each track has a directory named with its permanent track ID. The directory contains exactly one authoritative original music file, normalized to `source.ay`, `source.ym`, `source.psg`, `source.pt3`, `source.stc`, or `source.asc`, and one `track.json` sidecar. Generated waveform peaks, provenance, intermediate tracker PSG, and runtime music live under a clearly separated generated subdirectory within that track directory and must not be mistaken for curator-authored input. Every track has `generated/playback.ym`; it is YM6 when derived from PSG, a tracker-derived PSG, or AY, and is either a byte-identical validated YM source or normalized YM6 when derived from YM. Generated provenance records the original local filename or final remote download filename, detected authoritative format and hash, tracker conversion tool and intermediate hash when applicable, playback-environment fields, selected AY subsong when applicable, whether the YM output was copied or converted, runtime format and hash, frame count, calculated duration, and preparation-tool/engine versions needed to diagnose stale output.

Every `track.json` has the following required fields:

- `schemaVersion`: the integer `1` for the initial schema.
- `id`: the permanent slug-like track ID, identical to the containing directory name.
- `order`: a unique integer defining the curated display order.
- `title`: the display title.
- `author`: the known composer or credited author.
- `sourceUrl`: a valid HTTPS URL for the original source.
- `subsong`: a one-based integer identifying the single subsong to expose; ordinary single-song files use `1`.

For a PSG, PT3, STC, or ASC source, `track.json` additionally requires all of the following because its prepared PSG data does not reliably carry a complete portable playback environment:

- `chipType`: the supported sound chip identifier; the MVP accepts `AY` or `YM`.
- `chipClockHz`: an integer clock frequency from `1` through `4294967295` hertz.
- `frameRateHz`: an integer playback frame frequency from `1` through `65535` hertz, matching the YM runtime representation.
- `channelLayout`: the source channel order; the MVP accepts the explicitly validated values `ABC` and `ACB`.

For AY and YM sources, content preparation first extracts `chipType`, `chipClockHz`, `frameRateHz`, and `channelLayout`. Any value that is absent or ambiguous becomes required in `track.json` and is confirmed interactively or supplied explicitly in non-interactive mode; the tool never assumes it. A sidecar value that conflicts with unambiguous embedded data requires explicit confirmation in interactive mode and an explicit override option in non-interactive mode.

The schema permits `year`, `notes`, and `durationOverrideSeconds` as additional fields. The duration override is allowed only under the exceptional duration rule below. `sourceUrl` is the sole per-track source and attribution field; per-track license fields are not part of the schema. Every real track included in a public or release catalog must provide a valid human-facing HTTPS source URL.

Sidecar validation is strict. `id` matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` and is at most 80 characters. Required strings are trimmed and nonempty; metadata is plain text rather than HTML. URLs are HTTPS, contain no credentials, and meet their field-specific purpose. Numeric values must be finite and within the ranges stated here. Unknown sidecar properties fail validation so misspelled metadata cannot be silently ignored.

Each music file produces exactly one row in the collection. If a file contains multiple subsongs, the sidecar selects the single subsong that the application exposes; the MVP does not display a subsong selector or create multiple rows for one file.

Each exposed track has a manually assigned, permanent, slug-like ID. The ID is not derived from the music filename, title, or author, and must remain unchanged when those values change so persisted playback state remains valid.

The sidecar JSON is authoritative. Embedded music-file metadata may fill missing optional fields, but it never silently replaces a sidecar value. Content preparation emits a warning when the two sources contain conflicting values.

Content preparation calculates track duration using the selected playback engine. A naturally finite source retains its complete duration without leading/trailing trimming or a fade and must not specify `durationOverrideSeconds`. The browser never loops a track.

If an AY or YM source loops indefinitely or the engine cannot identify a reliable finite end, `durationOverrideSeconds` is required. It must be a finite value greater than zero and no greater than 1,800 seconds. Capture begins at the source start and ends after the first complete source frame whose end time is at or after the requested duration; no fade is added. The resulting whole-frame duration is authoritative for playback and display. Provenance records the reason for the override, requested seconds, actual frame count, frame rate, and actual duration. PSG and supported tracker inputs are already finite and cannot use a duration override. A missing required override or an override on a reliably finite source fails validation.

The generated catalog records `durationSeconds` using the generated runtime asset and `durationSource` as either `source` or `override`. All end detection, seeking bounds, persistence clamping, waveform bucketing, time display, and Auto-Play Next behavior use this generated duration.

#### Generated Catalog Contract

Content generation writes one deterministic UTF-8 JSON catalog with `schemaVersion: 1`. It uses two-space indentation, LF endings, a final newline, curated track order, and stable property ordering. It contains no generation timestamp, absolute filesystem path, host name, or other machine-dependent value. Its top-level shape is:

- `schemaVersion`: `1`.
- `waveforms`: an object containing the root-relative content-hashed `url`, lowercase hexadecimal `sha256`, exact `byteLength`, `formatVersion: 1`, `bucketCount: 2048`, and `channelCount: 3`.
- `tracks`: the ordered array of generated public track records.

Every generated track record contains:

- `id`, `order`, `title`, `author`, `sourceUrl`, and `subsong` copied from validated authoritative metadata.
- `sourceFormat`: `PSG`, `AY`, `PT3`, `STC`, `ASC`, or the detected authoritative YM variant.
- `runtimeFormat`: the detected format of `generated/playback.ym`, including the YM version rather than only the generic extension.
- `runtimeUrl`: a root-relative public URL of the form `tracks/<id>.<sha256>.ym`.
- `runtimeSha256`: the full lowercase hexadecimal SHA-256 of the served runtime bytes.
- `runtimeByteLength`: the exact positive byte length of the served runtime asset.
- `durationSeconds` and `durationSource` as defined above.
- `chipType`, `chipClockHz`, `frameRateHz`, and `channelLayout` after validated extraction/override resolution.
- `waveformByteOffset` and `waveformByteLength` as defined by the waveform-pack contract.
- `year` and `notes` only when present in authoritative metadata. Notes remain plain text.

The public catalog deliberately excludes the remote download URL, local filenames, absolute paths, build-machine information, and internal provenance details. Full provenance remains in generated repository data rather than being sent to every listener. Catalog and runtime validation reject missing required or unknown properties, wrong scalar types, non-finite numbers, unsafe or non-root-relative asset URLs, duplicate IDs/orders, noncontiguous ordering, hashes with the wrong shape, asset length/hash mismatches, waveform slices outside the pack, and catalog metadata inconsistent with the sidecar or provenance.

The production build is network-independent after `npm ci`: it never redownloads authoritative music, scrapes attribution pages, tests external-link availability, builds the ZXTune image, or contacts a conversion service. It reads repository content, committed tracker-conversion artifacts, and prepared engine artifacts only. Importing a new remote source or regenerating a tracker conversion is a separate explicit curator command; the first tracker generation may use the network only to build the pinned Docker image. Checking public links before release is a documented manual verification.

Content preparation and production builds fail on missing required metadata, duplicate track IDs, duplicate order values, invalid source URLs, missing music files, extension/signature mismatches, unsupported formats, invalid subsong selections, unsupported PSG playback-environment values, or otherwise invalid sidecar data. These errors must identify the affected file and field; invalid tracks are not silently omitted or rendered as unavailable.

Every conversion or normalization to YM6 passes an automated equivalence gate before its output may enter the catalog. For PSG, validation compares the parsed source stream with generated YM6. For PT3, STC, and ASC, content generation first requires the pinned ZXTune conversion and records a byte-level provenance binding from the authoritative tracker to its derived PSG; validation then compares that PSG register stream with generated YM6. For AY, it compares uninterrupted playback of the selected source subsong with the captured frames and generated YM6. For normalized YM, it compares the authoritative YM interpretation with generated YM6. In every case, normalized register values must match at every frame, frame count must be identical, calculated durations may differ by no more than one source frame, and A/B/C channel identity and order must be unchanged. Validation renders both register representations through the same pinned synthesis path at 48,000 Hz and requires each channel and the final mix to have a maximum absolute normalized-sample difference no greater than `0.000001`. A compliant YM byte-copy verifies byte identity plus the same runtime behavioral checks but does not need a conversion comparison.

The seek check opens `generated/playback.ym` independently at zero, 25%, 50%, 75%, and at the later of zero or one second before the end, seeks to that position, and compares the following one second or remaining duration against uninterrupted playback using the same audio tolerance. Very short tracks use every distinct applicable position. These thresholds, positions, and sample rate are fixed in project code and covered by fixtures; they must not be relaxed per track merely to make a failing conversion pass. Any mismatch fails import and reports the track, frame or seek position, channel or mix, expected value, actual value, and permitted tolerance.

Original music files and their hand-authored sidecar JSON files are the authoritative content sources. Generated waveform peaks and `generated/playback.ym` are derived data, produced by a documented command and prepared as repository-tracked release artifacts for fast, deterministic application builds. Waveform data contains exactly 2,048 time-aligned min/max buckets for each of channels A, B, and C before stereo placement and master volume. Tracks shorter than 2,048 rendered samples still emit 2,048 buckets, using zero for empty buckets.

Peak values use the pinned synthesizer's fixed normalized full-scale range of `-1` through `1`; content preparation must not normalize values independently by track or channel. Consequently, relative channel strength and loudness remain comparable within and between tracks. Peaks are encoded as signed eight-bit integers: minimum values use `floor(sample * 127)`, maximum values use `ceil(sample * 127)`, and both clamp to `-127...127`; `-128` is invalid and reserved for a future format version. Decoding divides by `127`. This outward rounding prevents quantization from understating an envelope. The UI downsamples all three channels identically to its physical canvas width and never rerenders the source audio merely because the viewport changes.

All catalog waveforms are concatenated in curated `order` into one versioned binary pack. Its byte layout is:

1. Four ASCII magic bytes `ZXWF`.
2. Little-endian unsigned 16-bit format version `1`.
3. Little-endian unsigned 16-bit bucket count `2048`.
4. Unsigned 8-bit channel count `3`.
5. Unsigned 8-bit value-encoding identifier `1`, meaning signed 8-bit outward-rounded min/max pairs.
6. Little-endian unsigned 16-bit reserved value `0`.
7. Little-endian unsigned 32-bit track count.
8. Contiguous track payloads with no padding.

Each track payload is exactly 12,288 bytes and is channel-major in A, B, C order. Within each channel, every time bucket stores its minimum byte followed by its maximum byte. Each generated catalog entry contains the absolute `waveformByteOffset` from the beginning of the pack and `waveformByteLength: 12288`. The catalog also contains the pack URL, full SHA-256 digest, format version, and bucket count once at its top level rather than duplicating them per track.

Content generation and the production build recompute and validate the pack digest, header, exact total length, track count, payload order, offsets, lengths, reserved values, min/max ordering, and absence of the reserved `-128` value. Runtime decoding also checks the magic, supported version, header values, bounds, and per-track offset before reading; malformed data activates the seek-slider fallback rather than throwing an uncaught error.

The production build verifies derived data and fails when prepared output is missing or stale. Derived data must never require manual editing.

## Automated Implementation Order and Gates

Implementation proceeds in the following order. A coding agent must satisfy each gate before beginning work whose only purpose belongs to a later phase. It may add focused tests and minimal diagnostic UI needed to prove the current phase, but it must not substitute polished mock behavior for an unproven audio path.

### Phase 1: Foundation

Scaffold the strict TypeScript, React, and Vite application; npm scripts; test harnesses; application-owned playback adapter interfaces; content directory conventions; sidecar and generated-catalog schemas; and deterministic generated-artifact validation. Establish a minimal page that can display diagnostic results, but do not build the finished visual design yet.

The phase passes when a clean install can run the TypeScript sanity check and production build, synthetic valid content passes schema validation, deliberately invalid content produces actionable failures, and no playback-engine implementation has leaked outside the application-owned adapter boundary.

### Phase 2: Playback-Engine Proof of Concept

Integrate the pinned `ym2149-rs` build and exercise representative AY and YM fixtures plus enough of the project-owned PSG-to-YM6, AY-to-YM6, compliant-YM-copy, and YM-normalization paths to test each runtime case. Use a minimal diagnostic harness to execute every proof-of-concept criterion in the Playback Engine section, including browser playback, lifecycle controls, accurate seeking, end detection, exact A/B/C samples, full-track offline rendering, waveform input, persistence restoration, and supported-browser checks.

Record the tested engine revision, artifact hashes, fixtures, browsers, results, known limitations, and reproduction commands in repository documentation. The phase passes only when all mandatory criteria have objective passing evidence. A partially working engine is not accepted merely because basic audio can be heard.

If `ym2149-rs` fails a mandatory criterion, reproduce the failure with the smallest applicable fixture, identify the failing API or behavior, and test any project-owned adapter/configuration fix that does not weaken the contract or require an unmaintainable engine fork. If no such fix passes the same automated criterion, preserve the adapter contract and run the proof of concept with Game Music Emu. If Game Music Emu also fails, stop implementation before the polished UI, report both sets of evidence and the unresolved criteria, and request a product decision. The agent must not choose a third engine, weaken the requirements, remove seeking or exact channel data, or introduce prerecorded audio without explicit approval.

### Phase 3: Real PSG Vertical Slice

Complete the production PSG parser, PSG-to-YM6 converter, common canonical-runtime generator contract, waveform packer, catalog generator, import/update/remove commands, provenance, atomic writes, and stale-output checks. Use the specified direct URL and metadata to import `pator-solitude` as the first real catalog entry. Then implement the smallest end-to-end application slice that loads the real catalog and waveform pack, starts `Solitude` after a user gesture, plays the generated YM6, pauses and resumes, seeks, restores a saved position paused, displays true A/B/C waveform lanes and live meters, changes volume, reaches the correct end, and links to its original source.

This phase passes only when the authoritative PSG, derived YM6, waveform data, provenance, and catalog all pass the automated equivalence and freshness checks; the track is audibly reviewed in at least one supported desktop browser; and the vertical slice works without mocked audio or metadata. A problem with the real seed track reopens the engine or converter gate rather than being hidden in UI code.

### Phase 4: Complete Product

Build the polished responsive interface, full player state machine, curated and shuffled sequencing, Media Session integration, persistence edge cases, error and capability states, Credits/License dialog, branding assets, security headers, and all other MVP behavior in this specification. Populate the remaining curated tracks through the import tool rather than hand-editing generated data. Every additional track must pass its applicable canonical-runtime and equivalence gates.

### Phase 5: Verification and Release

Complete unit, component, real-engine, browser-journey, responsive, reduced-motion, keyboard, and accessibility verification. Confirm catalog source attribution, immutable asset URLs, performance targets, supported browsers, production metadata, canonical URL, GitHub link, Vercel headers, and a clean production build. The implementation is complete only when the Definition of Done below is satisfied; passing the intentionally minimal CI jobs alone is not sufficient.

## Definition of Done

The MVP is done only when all of the following are true:

- A clean checkout installs reproducibly with the documented Node.js and npm versions. Ordinary application development, AY/YM/PSG content work, validation, and production builds need no undeclared native tools; PT3/STC/ASC curator imports use the explicitly documented Docker requirement.
- The TypeScript sanity check and production build pass from documented commands. The documented local lint, formatting check, unit/component tests, real-engine tests, Playwright journeys, and generated-artifact validation also pass.
- The selected playback engine has passed and documented every mandatory proof-of-concept criterion. Its pinned source revision, prepared browser artifacts, licenses, hashes, and rebuild procedure are present and reproducible.
- The real `pator-solitude` PSG vertical slice and every public track pass source-format validation, canonical-runtime generation, applicable equivalence, seeking, channel, waveform, provenance, and freshness checks.
- The release catalog may contain any number of tracks, including zero. Any tracks present remain in contiguous curated order, have valid source attribution, and present the corresponding source link in their catalog row.
- All specified player states, controls, sequencing rules, persistence behavior, waveform interactions, meters, error recovery, capability fallback, and Media Session behavior pass their automated or explicitly documented manual acceptance checks.
- The finished interface works without horizontal overflow at supported mobile widths, preserves the desktop layout and sticky meter behavior, meets WCAG 2.2 AA requirements, supports keyboard-only use, and respects reduced motion.
- The current and previous major desktop browsers and the current iOS Safari and Android Chrome pass the defined smoke journeys. Any browser-specific limitation allowed by this specification is documented and recovers cleanly.
- A representative production build meets the initial-transfer, Largest Contentful Paint, Cumulative Layout Shift, and smooth-meter targets defined above, with the measurement profile and result recorded.
- The deployed Vercel site uses the verified canonical URL, resolving GitHub link, production social metadata and original artwork, required security headers, self-hosted assets, content-hashed immutable track assets, and a revalidated catalog manifest.
- The deployed application contains no analytics, tracking, advertising, cookies, remote telemetry, service worker, PWA behavior, unintended remote asset dependency, or direct bundled-music download control.
- There are no known severity-one playback/data-loss defects, no silently omitted invalid tracks, no placeholder metadata, and no unresolved requirement in this specification marked as deferred unless it is explicitly outside the MVP.
