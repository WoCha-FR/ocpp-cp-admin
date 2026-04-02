'use strict';

module.exports = {
  loglevel: 'error',
  language: 'en',
  dbname: ':memory:',
  webui: { httpPort: 3000, sessionSecret: 'test-secret-32chars-minimum!!' },
  ocpp: { host: '0.0.0.0', wsPort: 9000 },
  notifs: {
    mail: { enabled: false },
    webpush: { enabled: false },
    pushover: { enabled: false },
  },
  auth: { google: { enabled: false } },
  metrics: {},
};
