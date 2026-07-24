/**
 * The pinned `ym2149-rs` revision, and the only place it is written down.
 *
 * `npm run engine:verify` asserts that `vendor/ym2149/manifest.json` records
 * this revision, so the vendored artifacts, the provenance schema, the content
 * pipeline, and `scripts/playback/rebuild-engine.sh` cannot drift apart. Change
 * it only alongside an explicit engine decision recorded in AGENTS.md.
 */
export const ENGINE_COMMIT = 'b3096aac0dcab6dd1d82c0209f579761943aadc6';
