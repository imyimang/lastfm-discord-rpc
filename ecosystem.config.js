module.exports = {
  apps: [{
    name: 'lastfm-sync',
    script: 'app.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: 'logs/error.log',
    out_file: 'logs/output.log',
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
