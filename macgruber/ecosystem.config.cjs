module.exports = {
  apps: [
    {
      name: 'macgruber',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: ['dist'],
      ignore_watch: ['node_modules', 'src', 'logs', '.env'],
      env: {
        NODE_ENV: 'production',
        PORT: '8792',
      },
      max_memory_restart: '512M',
      out_file: './logs/macgruber.out.log',
      error_file: './logs/macgruber.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
