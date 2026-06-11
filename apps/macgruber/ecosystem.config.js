// ecosystem.config.js — MacGruber v2 PM2 configuration
//
// Two fully-independent processes:
//   macgruber-api    — long-running HTTP service on 127.0.0.1:8792
//   macgruber-poller — cron-restarted fallback that catches missed failures
//
// Required env (via /opt/nous/macgruber/.env, loaded with -r dotenv/config):
//   DATABASE_URL        — Supabase Postgres connection string
//   GITHUB_TOKEN        — PAT for read-only branch/commit/PR checks
//   DISPATCH_BASE_URL   — https://oozlawunlkkuaykfunan.supabase.co/functions/v1/nous
//   NOUS_API_KEY        — x-api-key for dispatch cancel/retrigger

module.exports = {
  apps: [
    {
      name: 'macgruber-api',
      script: 'dist/src/server.js',
      node_args: '-r dotenv/config',
      cwd: '/opt/nous/macgruber',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        MACGRUBER_PORT: '8792',
        HOST: '127.0.0.1',
        MACGRUBER_PROJECT: 'nous-agents',
      },
      out_file: '/var/log/macgruber/api.out.log',
      error_file: '/var/log/macgruber/api.err.log',
    },
    {
      name: 'macgruber-poller',
      script: 'dist/src/poller/run.js',
      node_args: '-r dotenv/config',
      cwd: '/opt/nous/macgruber',
      autorestart: false,
      cron_restart: '*/5 * * * *',
      env: {
        NODE_ENV: 'production',
        MACGRUBER_PROJECT: 'nous-agents',
        MACGRUBER_POLLER_LOOKBACK_MINUTES: '60',
        MACGRUBER_POLLER_LIMIT: '50',
      },
      out_file: '/var/log/macgruber/poller.out.log',
      error_file: '/var/log/macgruber/poller.err.log',
    },
  ],
};
