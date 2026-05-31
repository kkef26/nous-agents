module.exports = {
  apps: [
    {
      name: "conductor",
      script: "dist/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        CONDUCTOR_PORT: "8091",
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
