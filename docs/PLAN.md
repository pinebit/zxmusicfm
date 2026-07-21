# ZX-MUSIC.FM Implementation Plan

`IDEA.md` is the authoritative product and technical specification. This file defines only the stable high-level implementation sequence, not a progress log or a place for detailed task notes. Complete each phase before proceeding to the next. Throughout every phase, leave all work uncommitted and unstaged; do not create tags, configure or modify remotes, publish a repository, open pull requests, or push anything.

## 1. Establish the Foundation

Prepare the directory as a local Git repository with appropriate ignore rules. Scaffold the strict TypeScript, React, and Vite application, content schemas, playback adapter boundary, test harnesses, and generated-content validation.

## 2. Prove the Playback Engine

Validate the pinned `ym2149-rs` integration against every mandatory playback, seeking, channel-output, waveform-rendering, browser, and reproducibility requirement. If it fails, run the same proof with Game Music Emu; stop and report if neither engine passes.

## 3. Deliver the PSG Vertical Slice

Build the deterministic PSG-to-YM6 and content-import pipeline, import **Solitude** as the first real track, and prove end-to-end playback, seeking, persistence, A/B/C waveforms, meters, volume, metadata, and attribution without mocked audio.

## 4. Complete the MVP

Build the polished responsive interface and all catalog, playback, sequencing, accessibility, error-handling, credits, security, and deployment behavior specified in `IDEA.md`.

## 5. Verify and Release

Run the full local verification suite, confirm the 20–30-track release catalog and source attribution, validate supported browsers, accessibility, performance, immutable assets, and production configuration, and satisfy the complete Definition of Done in `IDEA.md`. Prepare a deployment-ready Vercel build; create or change an external deployment only when separately and explicitly authorized by the user.
