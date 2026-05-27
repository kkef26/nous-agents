module.exports = {
  apps: [
    {
      name: "scoper",
      script: "npx",
      args: "tsx scoper/server.ts",
      cwd: "/opt/nous-agents/hetzner",
      env: {
        NODE_ENV: "production",
        SCOPER_PORT: "8790",
        SUPABASE_URL: "https://oozlawunlkkuaykfunan.supabase.co",
        STATION_PROXY_URL: "http://127.0.0.1:8095"
      },
      max_memory_restart: "512M",
      autorestart: true,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "/var/log/nous/scoper-error.log",
      out_file: "/var/log/nous/scoper-out.log",
      merge_logs: true
    },
    {
      name: "conductor",
      script: "npx",
      args: "tsx conductor/server.ts",
      cwd: "/opt/nous-agents/hetzner",
      env: {
        NODE_ENV: "production",
        CONDUCTOR_PORT: "8791",
        SUPABASE_URL: "https://oozlawunlkkuaykfunan.supabase.co",
        STATION_PROXY_URL: "http://127.0.0.1:8095"
      },
      max_memory_restart: "512M",
      autorestart: true,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "/var/log/nous/conductor-error.log",
      out_file: "/var/log/nous/conductor-out.log",
      merge_logs: true
    }
  ]
};
