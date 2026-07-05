module.exports = {
  apps: [{
    name: 'predict-arb',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
    },
    env_file: '.env',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '500M',
  }]
};
