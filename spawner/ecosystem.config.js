module.exports = {
  apps: [{
    name: "spawner",
    cwd: "/opt/nous/spawner",
    script: "/usr/bin/python3",
    args: "-m uvicorn main:app --host 0.0.0.0 --port 8787",
    autorestart: true,
    max_restarts: 50,
    min_uptime: "30s",
    max_memory_restart: "2G",
    env: {
      SPAWNER_PORT: "8787",
      SPAWNER_INSTANCE: "hetzner-pipeline",
      PYTHONUNBUFFERED: "1",
      HOME: "/opt/nous/spawner",
    },
    out_file: "/var/log/nous/spawner.out.log",
    error_file: "/var/log/nous/spawner.err.log",
    time: true,
  }]
};
