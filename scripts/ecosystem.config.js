const path = require('path');
const root = path.join(__dirname, '..');

module.exports = {
  apps: [{
    name: 'open-folio',
    script: path.join(root, 'server.js'),
    cwd: root,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
