// ecosystem.config.js — MacGruber PM2 configuration
//
// Two fully-independent processes:
//   macgruber-api    — long-running HTTP service on port :8792
//   macgruber-poller — cron-restarted fallback that catches missed failures
//
// The poller process owns NO shared state with the API. A crash on either
// side does not affect the other (per FEAT.MACGRUBER.9 D9 constraint).

module.exports = {
  apps: [
    {
      name: 'macgruber-api',
      script: 'dist/server.js',
      node_args: '-r dotenv/config',
      cwd: '/opt/nous/macgruber',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        MACGRUBER_PORT: '8792',
        MACGRUBER_PROJECT: 'nous-agents',
      },
      out_file: '/var/log/macgruber/api.out.log',
      error_file: '/var/log/macgruber/api.err.log',
    },
    {
      name: 'macgruber-poller',
      script: 'dist/poller/pollMissedFailures.js',
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
