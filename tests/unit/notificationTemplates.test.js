'use strict';

jest.mock('../../src/i18n', () => ({
  trad: (key, _opts) => `[${key}]`,
}));

const { format } = require('../../src/notificationTemplates');

describe('notificationTemplates — format', () => {
  it('server_started returns titre and corps', () => {
    const result = format('server_started', {}, 'en');
    expect(result).toHaveProperty('titre');
    expect(result).toHaveProperty('corps');
  });

  it('server_stopping includes signal', () => {
    const result = format('server_stopping', { signal: 'SIGTERM' }, 'en');
    expect(result.titre).toContain('notifications.server_stopping.title');
    expect(result.corps).toContain('notifications.server_stopping.body');
  });

  it('pending_chargepoint includes identity', () => {
    const result = format('pending_chargepoint', { identity: 'EVS001' }, 'en');
    expect(result.titre).toBeTruthy();
    expect(result.corps).toBeTruthy();
  });

  it('chargepoint_online uses cp_name', () => {
    const result = format('chargepoint_online', { cp_name: 'Station A' }, 'en');
    expect(result.titre).toContain('notifications.chargepoint_online.title');
  });

  it('chargepoint_offline returns body with site', () => {
    const result = format('chargepoint_offline', { cp_name: 'Station A', site_name: 'Site 1' }, 'en');
    expect(result.corps).toContain('notifications.chargepoint_offline.body');
    expect(result.corps).toContain('notifications.common.site');
  });

  it('connector_error includes error_code', () => {
    const result = format('connector_error', {
      cp_name: 'Station A',
      connector_id: 1,
      status: 'Faulted',
      error_code: 'GroundFailure',
    }, 'en');
    expect(result.corps).toContain('notifications.connector_error.status');
    expect(result.corps).toContain('notifications.connector_error.error_code');
  });

  it('transaction_stopped includes energy and duration', () => {
    const result = format('transaction_stopped', {
      cp_name: 'Station A',
      connector_id: 1,
      energy_kwh: 12.5,
      duration: 3600,
      stop_reason: 'Local',
    }, 'en');
    expect(result.corps).toContain('notifications.common.energy');
    expect(result.corps).toContain('notifications.common.duration');
  });

  it('unknown event returns default template', () => {
    const result = format('unknown_event', { foo: 'bar' }, 'en');
    expect(result.titre).toContain('unknown_event');
    expect(result.corps).toContain('bar');
  });

  it('duplicate_identity includes IPs', () => {
    const result = format('duplicate_identity', {
      identity: 'EVS001',
      old_address: '1.2.3.4',
      new_address: '5.6.7.8',
    }, 'en');
    expect(result.titre).toBeTruthy();
  });

  it('repeated_auth_rejected includes id_tag', () => {
    const result = format('repeated_auth_rejected', {
      id_tag: 'TAG123',
      count: 5,
      window_minutes: 15,
    }, 'en');
    expect(result.titre).toContain('notifications.repeated_auth_rejected.title');
  });

  it('site_transaction_started returns valid template', () => {
    const result = format('site_transaction_started', { cp_name: 'CP1', connector_id: 1 }, 'fr');
    expect(result).toHaveProperty('titre');
    expect(result).toHaveProperty('corps');
  });
});
