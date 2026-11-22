# Contributing

Thanks for helping! Bug reports with a minimal login page that fails are the most useful contributions: add it to `test/fixtures/`.

## Setup

```bash
npm install
npm test           # needs Google Chrome (or set CHROME_PATH)
npm run coverage   # must stay at or above 98% for statements, branches, functions and lines
npm run typecheck
npm run build && npm run smoke
```

## Ground rules

- No code path may return, log or put into `process.env` a password. Results go through `createRedactor`.
- `src/inpage.ts` is serialized into the browser. Keep it self-contained (no imports, no module-level references).
- `src/hooks/guard.ts` is copied as a standalone file. It may only import Node built-ins.
- Every change needs tests. New login layouts get an end-to-end fixture in `test/fixtures/`.

## Releasing

One rule: **every npm release gets a new version, and that version is the same in `package.json`, the git tag `v<version>`, npm, `CHANGELOG.md`, the docs and the website.** `scripts/release.mjs` enforces it:

- CI fails when a version in the README, docs or website differs from `package.json`, when `CHANGELOG.md` has no section for it, when npm has a version without a git tag, or when `package.json` is behind npm.
- `npm publish` only runs inside the release workflow, for the tag that matches `package.json`.
- The release workflow publishes only a tag that is on `main` and newer than npm, then creates the GitHub release with the `CHANGELOG.md` section.

To release:

1. Add a `## <new version> - <date>` section at the top of `CHANGELOG.md` and commit it.
2. Run `npm version patch` (or `minor`, `major`). It bumps `package.json`, writes the new version into the README, docs and website (`node scripts/release.mjs sync`), commits `Release <version>` and tags `v<version>`.
3. Run `git push --follow-tags`. The release workflow checks everything, publishes to npm with provenance and creates the GitHub release.

Never publish from your machine, never move or delete a released tag, and never reuse a version number.
