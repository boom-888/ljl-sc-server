module.exports = {
  apps: [
    {
      name: 'ljl-sc-api',
      script: 'node',
      args: 'node_modules/tsx/dist/cli.mjs src/index.ts',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'development',
        PORT: 3001,
      },
    },
  ],
};
