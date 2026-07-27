/**
 * The pinned `ym2149-rs` revision, and the only place it is written down.
 *
 * `npm run engine:verify` asserts that `vendor/ym2149/manifest.json` records
 * this revision, so the vendored artifacts, the provenance schema, the content
 * pipeline, and `scripts/playback/rebuild-engine.sh` cannot drift apart. Change
 * it only alongside an explicit engine decision recorded in AGENTS.md.
 */
export const ENGINE_COMMIT = '5bb4886fb35032db07980e5fdac408db54c7796f';
