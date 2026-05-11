'use strict';

jest.mock('../../src/config', () => ({
  getConfig: () => ({ notifs: { defaultDisabledEvents: [] } }),
}));
jest.mock('../../src/database', () => ({ prepare: () => ({ all: () => [], get: () => null, run: () => {} }) }));
jest.mock('../../src/notificationTemplates', () => ({ format: () => '' }));
jest.mock('../../src/i18n', () => ({ trad: () => '' }));
jest.mock('../../src/channels/email', () => ({ name: 'email', send: jest.fn() }));
jest.mock('../../src/channels/webpush', () => ({ name: 'webpush', send: jest.fn() }));
jest.mock('../../src/channels/pushover', () => ({ name: 'pushover', send: jest.fn() }));
jest.mock('../../src/logger', () => ({ scope: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }));

const { applyDefaultDisabledEvents } = require('../../src/notifications');

describe('applyDefaultDisabledEvents', () => {
  it('sets defaultChannels to [] for listed events', () => {
    const defs = {
      chargepoint_online: { defaultChannels: ['email'] },
      server_started: { defaultChannels: ['email'] },
    };
    applyDefaultDisabledEvents(defs, ['chargepoint_online']);
    expect(defs.chargepoint_online.defaultChannels).toEqual([]);
    expect(defs.server_started.defaultChannels).toEqual(['email']);
  });

  it('does nothing for empty list', () => {
    const defs = { server_started: { defaultChannels: ['email'] } };
    applyDefaultDisabledEvents(defs, []);
    expect(defs.server_started.defaultChannels).toEqual(['email']);
  });

  it('ignores unknown event names without throwing', () => {
    const defs = { server_started: { defaultChannels: ['email'] } };
    expect(() => applyDefaultDisabledEvents(defs, ['unknown_event'])).not.toThrow();
    expect(defs.server_started.defaultChannels).toEqual(['email']);
  });

  it('disables multiple events at once', () => {
    const defs = {
      connector_available: { defaultChannels: ['email'] },
      connector_unavailable: { defaultChannels: ['email'] },
      transaction_started: { defaultChannels: ['email'] },
    };
    applyDefaultDisabledEvents(defs, ['connector_available', 'connector_unavailable']);
    expect(defs.connector_available.defaultChannels).toEqual([]);
    expect(defs.connector_unavailable.defaultChannels).toEqual([]);
    expect(defs.transaction_started.defaultChannels).toEqual(['email']);
  });
});
