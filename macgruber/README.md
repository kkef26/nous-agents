# MacGruber

Universal pipeline failure handler. Receives failure intakes from Conductor and Scoper, investigates with claude-haiku then claude-sonnet, and remediates or escalates.

## Run

```bash
cp .env.example .env  # populate
npm install
npm run build
pm2 start ecosystem.config.cjs
```

`GET /healthz` returns `{ "status": "ok" }` on `:8792`.

## Structure

- `src/index.ts` — entry point; loads env, starts HTTP server.
- `src/app.ts` — Express app factory.
- `src/env.ts` — zod-validated env schema (crashes fast on missing required vars).
- `src/routes/` — route modules. Each module exports a configured `Router`.
- `migrations/` — numbered SQL migrations applied via `npm run migrate`.

## Laws

Pushes go to `dispatch/<clause-id>` only. No direct prod deploy.
