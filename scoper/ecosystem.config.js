// ecosystem.config.js — Scoper PM2 configuration
// Secrets loaded from .env (not committed)
module.exports = {
  apps: [{
    name: 'scoper',
    script: 'dist/index.js',
    node_args: '-r dotenv/config',
    cwd: '/opt/nous/scoper',
    env: {
      NODE_ENV: 'production',
      SCOPER_PORT: '8790',
      // These come from .env:
      // SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NOUS_API_KEY,
      // STATION_PROXY_URL, STATION_PROXY_KEY, STATION_PROXY_API_KEY
    }
  }]
};
