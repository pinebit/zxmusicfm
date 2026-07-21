# ZX-SPECTRUM.FM

The implementation follows [IDEA.md](./IDEA.md) and the gated sequence in
[PLAN.md](./PLAN.md). The current code is the Phase 1 foundation and deliberately
contains no playback-engine integration or polished product interface.

## Toolchain

- Node.js 24.14.1
- npm 11.12.1

Install exactly from the lockfile:

```sh
npm ci
```

## Commands

```sh
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:e2e
npm run content:generate
npm run content:validate
npm run build
```

Remote import, update, and removal commands are reserved by the stable command
contract but intentionally fail until Phase 3 implements their complete atomic
workflows.

Release validation is enabled by `--release`, `CONTENT_RELEASE=1`, or
`VERCEL_ENV=production`. The empty catalog is valid only for development and
Phase 1 verification.

## Repository policy

Implementation work must remain unstaged and uncommitted. Do not configure
remotes or push from the implementation workflow.
