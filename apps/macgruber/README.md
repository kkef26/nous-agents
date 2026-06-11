# MacGruber v2

Mechanical pipeline failure handler. Receives failure intakes from Conductor
(push) and a 5-minute poller (pull), remediates infra-class failures
deterministically, and escalates everything else to `nous.decision_queue`.

**This directory is the ONLY MacGruber.** The legacy `macgruber/` service
(zod v1 schema, LLM diagnoser, no executor) was removed 2026-06-11: its
intake schema rejected 100% of conductor traffic and its breaker/investigation
tables never existed in prod.

## Intake contract (v2, conductor-canon)

`POST /intake` — required: `project`, `failure_class`. Optional:
`intake_event_id` (server-generates), `dispatch_id`, `clause_id`, `run_id`,
`source`, `timestamp`, `detail{}`. This is exactly the payload
`hetzner/conductor-v4/src/macgruber.ts` already sends. Schema lives in
`src/contract/intakeContract.ts` — change it there or nowhere.

## Remediation model

- mechanical classes (`branch_not_found`, `workspace_error`, `stale_verifying`,
  `stale_branch`, `stale_orphan`, `no_build_artifacts`, `exhausted_attempts`,
  `stall_*`, `silent_death`): clause shipped → noop; else cancel dead dispatch
  + `POST /dispatch/tree {tree_run_id}` retrigger (unfinished clauses only).
- everything else (`merge_conflict`, `gate_failure`, `merge_api_error`,
  unknown): escalate to decision_queue with the full investigation report.
- circuit breaker: 3 intakes per (clause, class) per 24h, 20 global per hour,
  counted against `nous.macgruber_intake_log` (also the audit trail).

## Deploy (Hetzner)

```bash
ssh deploy@5.161.190.85
cd /opt/nous/macgruber && git pull
npm ci && npm run build
pm2 restart macgruber-api macgruber-poller || pm2 start ecosystem.config.js
curl -s localhost:8792/healthz   # expect {"status":"ok","intake_schema_version":2}
```

## Smoke test

```bash
curl -s -X POST localhost:8792/intake -H 'content-type: application/json' \
  -d '{"project":"nous","failure_class":"branch_not_found","dispatch_id":"<uuid>","clause_id":"X.1"}'
```
