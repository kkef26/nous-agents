-- AGT.2.6 — nous.agent_cost_summary view
-- Aggregates per-agent cost / runs / token / GitHub-call / error counts
-- across rolling 1h / 24h / 7d windows. Station COSTS drawer reads this view directly.
--
-- DEPENDS ON: scoper_log (001) and conductor_log (002) tables.
--
-- Apply via Supabase MCP: apply_migration({"name":"agt_006_agent_cost_summary_view", "query": "<this file>"})
-- ROLLBACK: DROP VIEW IF EXISTS nous.agent_cost_summary;

BEGIN;

CREATE OR REPLACE VIEW nous.agent_cost_summary AS
WITH windows AS (
  SELECT * FROM (VALUES
    ('scoper'::text,    '1h'::text,  interval '1 hour'),
    ('scoper',          '24h',       interval '24 hours'),
    ('scoper',          '7d',        interval '7 days'),
    ('conductor',       '1h',        interval '1 hour'),
    ('conductor',       '24h',       interval '24 hours'),
    ('conductor',       '7d',        interval '7 days')
  ) AS w(agent, window_label, window_interval)
),
scoper_rolled AS (
  SELECT 'scoper'::text AS agent,
         CASE
           WHEN created_at > now() - interval '1 hour'   THEN '1h'
           WHEN created_at > now() - interval '24 hours' THEN '24h'
           WHEN created_at > now() - interval '7 days'   THEN '7d'
         END AS window_label,
         actual_cost_usd,
         tokens_in + tokens_out AS total_tokens,
         github_api_calls,
         duration_ms,
         CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END AS is_error
  FROM nous.scoper_log
  WHERE created_at > now() - interval '7 days'
),
conductor_rolled AS (
  SELECT 'conductor'::text AS agent,
         CASE
           WHEN created_at > now() - interval '1 hour'   THEN '1h'
           WHEN created_at > now() - interval '24 hours' THEN '24h'
           WHEN created_at > now() - interval '7 days'   THEN '7d'
         END AS window_label,
         actual_cost_usd,
         tokens_in + tokens_out + COALESCE(sentinel_tokens, 0) AS total_tokens,
         github_api_calls,
         duration_ms,
         CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END AS is_error
  FROM nous.conductor_log
  WHERE created_at > now() - interval '7 days'
),
all_runs AS (
  -- Note: a row in `1h` is ALSO counted in `24h` and `7d` per window-cascade logic
  -- expand each row into its applicable windows
  SELECT agent, '1h'::text AS window_label, actual_cost_usd, total_tokens, github_api_calls, duration_ms, is_error
  FROM scoper_rolled WHERE window_label = '1h'
  UNION ALL
  SELECT agent, '24h', actual_cost_usd, total_tokens, github_api_calls, duration_ms, is_error
  FROM scoper_rolled WHERE window_label IN ('1h', '24h')
  UNION ALL
  SELECT agent, '7d', actual_cost_usd, total_tokens, github_api_calls, duration_ms, is_error
  FROM scoper_rolled WHERE window_label IN ('1h', '24h', '7d')
  UNION ALL
  SELECT agent, '1h', actual_cost_usd, total_tokens, github_api_calls, duration_ms, is_error
  FROM conductor_rolled WHERE window_label = '1h'
  UNION ALL
  SELECT agent, '24h', actual_cost_usd, total_tokens, github_api_calls, duration_ms, is_error
  FROM conductor_rolled WHERE window_label IN ('1h', '24h')
  UNION ALL
  SELECT agent, '7d', actual_cost_usd, total_tokens, github_api_calls, duration_ms, is_error
  FROM conductor_rolled WHERE window_label IN ('1h', '24h', '7d')
)
SELECT
  w.agent,
  w.window_label AS window,
  COALESCE(COUNT(a.actual_cost_usd), 0)::int            AS runs,
  COALESCE(SUM(a.actual_cost_usd), 0)::numeric(10, 4)   AS total_cost_usd,
  COALESCE(SUM(a.total_tokens), 0)::int                 AS total_tokens,
  COALESCE(SUM(a.github_api_calls), 0)::int             AS github_calls,
  COALESCE(SUM(a.is_error), 0)::int                     AS errors,
  COALESCE(AVG(a.duration_ms)::int, 0)                  AS avg_duration_ms
FROM windows w
LEFT JOIN all_runs a ON a.agent = w.agent AND a.window_label = w.window_label
GROUP BY w.agent, w.window_label
ORDER BY w.agent, w.window_label;

COMMIT;

-- Verification (run separately):
-- SELECT * FROM nous.agent_cost_summary ORDER BY agent, window;
-- Expect 6 rows initially, all zeros.
--
-- Insert a test row and verify aggregation:
-- INSERT INTO nous.scoper_log(run_id, feature_id, project, mode, step, step_name, model_used,
--                             tokens_in, tokens_out, actual_cost_usd, github_api_calls, duration_ms)
-- VALUES (gen_random_uuid(), 'test-feat', 'test-project', 'plan', 1, 'mode_lock',
--         'claude-opus-4-7', 100, 50, 0.05, 2, 1500);
-- SELECT runs, total_cost_usd, total_tokens, github_calls FROM nous.agent_cost_summary
-- WHERE agent='scoper' AND window='1h';
-- Expect runs=1, total_cost_usd=0.05, total_tokens=150, github_calls=2.
-- DELETE FROM nous.scoper_log WHERE feature_id='test-feat';
--
-- Performance check:
-- EXPLAIN ANALYZE SELECT * FROM nous.agent_cost_summary;
-- Expect <100ms on empty / small tables.
