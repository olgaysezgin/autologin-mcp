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
