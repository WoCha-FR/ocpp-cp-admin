'use strict';

const mockDb = {
  getChargepointByIdentity: jest.fn(),
  getChargepointById: jest.fn(),
  upsertChargepoint: jest.fn(),
  addOcppMessage: jest.fn(),
  bulkUpsertChargepointConfig: jest.fn(),
  upsertChargepointConfig: jest.fn(),
  createTransaction: jest.fn(),
  stopTransaction: jest.fn(),
  getTransactions: jest.fn(() => []),
  getTransactionByTransactionId: jest.fn(),
  updateChargepointStatus: jest.fn(),
  upsertConnector: jest.fn(),
  getConnectorByChargepointAndId: jest.fn(),
  getConnectorsByChargepoint: jest.fn(() => []),
  authorizeIdTag: jest.fn(),
  addIdTagEvent: jest.fn(),
  getIdTagByTag: jest.fn(),
  createIdTag: jest.fn(),
  updateConnectorMeterValue: jest.fn(),
  updateChargepointMeterValue: jest.fn(),
  updateTransactionPowerEnergy: jest.fn(),
  upsertTransactionValues: jest.fn(),
  getEnabledInitialChargepointConfig: jest.fn(() => []),
  getInitialChargepointConfigByKey: jest.fn(() => ({ value: '300' })),
  markChargepointInitialized: jest.fn(),
  getChargepointConfigByKey: jest.fn(),
};

jest.mock('../../src/database', () => mockDb);

const mockNotifications = { emit: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/notifications', () => mockNotifications);

jest.mock('../../src/logger', () => ({
  scope: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockConnectedClients = new Map();
const mockPendingRemoteStarts = new Map();
const mockBroadcast = jest.fn();
const mockTrackRepeatedAuthReject = jest.fn();

jest.mock('../../src/ocpp-common', () => ({
  broadcast: mockBroadcast,
  getConnectedClients: jest.fn(() => mockConnectedClients),
  pendingRemoteStarts: mockPendingRemoteStarts,
  trackRepeatedAuthReject: mockTrackRepeatedAuthReject,
  registerCallClientImpl: jest.fn(),
  registerHandlersFn: jest.fn(),
}));

const { callClient16, register16Handlers } = require('../../src/ocpp-server-16');

// Simplified loggedHandle that stores handlers directly (skips DB logging overhead)
function makeLoggedHandle(client) {
  return function loggedHandle(action, handler) {
    client._handlers[action] = handler;
  };
}

function makeClient(identity) {
  return {
    identity,
    protocol: 'ocpp1.6',
    call: jest.fn().mockResolvedValue({}),
    handle: jest.fn(),
    _handlers: {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnectedClients.clear();
  mockPendingRemoteStarts.clear();
});

// ── callClient16 ──
describe('ocpp-server-16 — callClient16', () => {
  it('throws when chargepoint not connected', async () => {
    await expect(callClient16('UNKNOWN', 'Reset', {})).rejects.toThrow('not connected');
  });

  it('calls the client and returns result', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({ status: 'Accepted' }) };
    mockConnectedClients.set('CP001', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });

    const result = await callClient16('CP001', 'Reset', { type: 'Soft' });
    expect(result).toEqual({ status: 'Accepted' });
    expect(mockClient.call).toHaveBeenCalledWith('Reset', { type: 'Soft' });
  });

  it('broadcasts outbound CALL and inbound CALLRESULT', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({ status: 'Accepted' }) };
    mockConnectedClients.set('CP001', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });

    await callClient16('CP001', 'Reset', { type: 'Soft' });
    expect(mockBroadcast).toHaveBeenCalledWith('ocpp_message', expect.objectContaining({ message_type: 'CALL' }));
    expect(mockBroadcast).toHaveBeenCalledWith('ocpp_message', expect.objectContaining({ message_type: 'CALLRESULT' }));
  });

  it('bulkUpserts config after GetConfiguration', async () => {
    const configKey = [{ key: 'HeartbeatInterval', value: '60', readonly: false }];
    const mockClient = { call: jest.fn().mockResolvedValue({ configurationKey: configKey }) };
    mockConnectedClients.set('CP002', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 2 });

    await callClient16('CP002', 'GetConfiguration', {});
    expect(mockDb.bulkUpsertChargepointConfig).toHaveBeenCalledWith(2, configKey);
    expect(mockBroadcast).toHaveBeenCalledWith('chargepoint_config_update', expect.any(Object));
  });

  it('works when cp is null (no DB record)', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({}) };
    mockConnectedClients.set('CP003', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue(null);

    await expect(callClient16('CP003', 'Reset', {})).resolves.toEqual({});
  });
});

// ── BootNotification ──
describe('ocpp-server-16 — BootNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: false, site_id: 1 });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('registers the handler', () => {
    expect(client._handlers['BootNotification']).toBeDefined();
  });

  it('returns Accepted with heartbeat interval and currentTime', () => {
    const result = client._handlers['BootNotification']({
      chargePointVendor: 'ABB',
      chargePointModel: 'Terra DC',
    });
    expect(result.status).toBe('Accepted');
    expect(result.interval).toBe(300);
    expect(result.currentTime).toBeDefined();
  });

  it('uses default 300s interval when config not found', () => {
    mockDb.getInitialChargepointConfigByKey.mockReturnValue(null);
    const result = client._handlers['BootNotification']({ chargePointVendor: 'X' });
    expect(result.interval).toBe(300);
  });

  it('sends ChangeConfiguration even when GetConfiguration fails', async () => {
    mockDb.getEnabledInitialChargepointConfig.mockReturnValue([
      { key: 'HeartbeatInterval', value: '60' },
    ]);
    mockDb.getChargepointConfigByKey.mockReturnValue(null);

    client.call
      .mockResolvedValueOnce({})                             // ClearCache
      .mockResolvedValueOnce({})                             // ClearChargingProfile
      .mockRejectedValueOnce(new Error('Not supported'))     // GetConfiguration {}
      .mockResolvedValueOnce({})                             // GetConfiguration fallback (key list)
      .mockResolvedValueOnce({ status: 'Accepted' });        // ChangeConfiguration

    mockConnectedClients.set('CP001', client);

    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.call).toHaveBeenCalledWith('ChangeConfiguration', {
      key: 'HeartbeatInterval',
      value: '60',
    });
    expect(mockDb.upsertChargepointConfig).toHaveBeenCalledWith(1, 'HeartbeatInterval', '60', false);
  });

  it('retries GetConfiguration with standard OCPP 1.6 key list when initial call fails', async () => {
    client.call
      .mockResolvedValueOnce({})                             // ClearCache
      .mockResolvedValueOnce({})                             // ClearChargingProfile
      .mockRejectedValueOnce(new Error('Not supported'))     // GetConfiguration {}
      .mockResolvedValueOnce({});                            // GetConfiguration fallback

    mockConnectedClients.set('CP001', client);
    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.call).toHaveBeenCalledWith('GetConfiguration', {});
    expect(client.call).toHaveBeenCalledWith('GetConfiguration', {
      key: expect.arrayContaining(['SupportedFeatureProfiles', 'HeartbeatInterval', 'MeterValueSampleInterval']),
    });
  });

  it('calls bulkUpsertChargepointConfig with configurationKey returned by fallback GetConfiguration', async () => {
    const configKeys = [{ key: 'HeartbeatInterval', value: '300', readonly: false }];
    client.call
      .mockResolvedValueOnce({})                                       // ClearCache
      .mockResolvedValueOnce({})                                       // ClearChargingProfile
      .mockRejectedValueOnce(new Error('Not supported'))               // GetConfiguration {}
      .mockResolvedValueOnce({ configurationKey: configKeys });        // GetConfiguration fallback

    mockConnectedClients.set('CP001', client);
    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.bulkUpsertChargepointConfig).toHaveBeenCalledWith(1, configKeys);
  });

  it('emits init_config_result with reboot, rejected and notSupported keys grouped', async () => {
    mockDb.getEnabledInitialChargepointConfig.mockReturnValue([
      { key: 'KeyA', value: '1' },
      { key: 'KeyB', value: '2' },
      { key: 'KeyC', value: '3' },
    ]);
    mockDb.getChargepointConfigByKey.mockReturnValue(null);

    client.call
      .mockResolvedValueOnce({})                                  // ClearCache
      .mockResolvedValueOnce({})                                  // ClearChargingProfile
      .mockResolvedValueOnce({})                                  // GetConfiguration
      .mockResolvedValueOnce({ status: 'RebootRequired' })        // KeyA
      .mockResolvedValueOnce({ status: 'Rejected' })              // KeyB
      .mockResolvedValueOnce({ status: 'NotSupported' });         // KeyC

    mockConnectedClients.set('CP001', client);

    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockNotifications.emit).toHaveBeenCalledTimes(1);
    expect(mockNotifications.emit).toHaveBeenCalledWith('init_config_result', {
      identity: 'CP001',
      rebootKeys: ['KeyA'],
      rejectedKeys: ['KeyB'],
      notSupportedKeys: ['KeyC'],
    });
  });

  it('does not emit init_config_result when all ChangeConfiguration are Accepted', async () => {
    mockDb.getEnabledInitialChargepointConfig.mockReturnValue([
      { key: 'KeyA', value: '1' },
    ]);
    mockDb.getChargepointConfigByKey.mockReturnValue(null);

    client.call
      .mockResolvedValueOnce({})                           // ClearCache
      .mockResolvedValueOnce({})                           // ClearChargingProfile
      .mockResolvedValueOnce({})                           // GetConfiguration
      .mockResolvedValueOnce({ status: 'Accepted' });      // KeyA

    mockConnectedClients.set('CP001', client);

    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockNotifications.emit).not.toHaveBeenCalledWith('init_config_result', expect.anything());
  });
});

// ── Heartbeat ──
describe('ocpp-server-16 — Heartbeat', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, last_heartbeat: new Date().toISOString() });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('returns currentTime', () => {
    const result = client._handlers['Heartbeat']({});
    expect(result.currentTime).toBeDefined();
  });

  it('calls updateChargepointStatus', () => {
    client._handlers['Heartbeat']({});
    expect(mockDb.updateChargepointStatus).toHaveBeenCalledWith('CP001', undefined, true);
  });

  it('broadcasts chargepoint_heartbeat', () => {
    client._handlers['Heartbeat']({});
    expect(mockBroadcast).toHaveBeenCalledWith('chargepoint_heartbeat', expect.any(Object));
  });
});

// ── Authorize ──
describe('ocpp-server-16 — Authorize', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 1, site_id: 1 });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('returns Accepted for valid tag', () => {
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Accepted', tag: null });
    const result = client._handlers['Authorize']({ idTag: 'TAG001' });
    expect(result.idTagInfo.status).toBe('Accepted');
  });

  it('returns Invalid for unknown tag and tracks rejection', () => {
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid', reason: 'unknown', tag: null });
    const result = client._handlers['Authorize']({ idTag: 'BAD' });
    expect(result.idTagInfo.status).toBe('Invalid');
    expect(mockTrackRepeatedAuthReject).toHaveBeenCalledWith('BAD', 'CP001', expect.any(Object));
  });

  it('always accepts in mode 3 (free charging)', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 3, site_id: 1 });
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid' });
    const result = client._handlers['Authorize']({ idTag: 'ANY' });
    expect(result.idTagInfo.status).toBe('Accepted');
  });

  it('includes expiryDate when tag has expiry_date', () => {
    mockDb.authorizeIdTag.mockReturnValue({
      status: 'Accepted',
      tag: { expiry_date: '2030-01-01T00:00:00Z' },
    });
    const result = client._handlers['Authorize']({ idTag: 'TAG_EXP' });
    expect(result.idTagInfo.expiryDate).toBe('2030-01-01T00:00:00Z');
  });

  it.each(['WEB-5', 'ADMIN', 'MGR-3'])(
    'blocks auto-tag prefix "%s" via Authorize (clone protection)',
    (idTag) => {
      const result = client._handlers['Authorize']({ idTag });
      expect(result.idTagInfo.status).toBe('Blocked');
      expect(mockDb.authorizeIdTag).not.toHaveBeenCalled();
      expect(mockDb.addIdTagEvent).toHaveBeenCalledWith(
        1, null, idTag, 'Blocked', 'auto_tag_rfid', 'authorize'
      );
    }
  );

  it('blocks auto-tag even in mode 3', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 3, site_id: 1 });
    const result = client._handlers['Authorize']({ idTag: 'WEB-1' });
    expect(result.idTagInfo.status).toBe('Blocked');
  });
});

// ── StartTransaction ──
describe('ocpp-server-16 — StartTransaction', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 1, site_id: 1 });
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Accepted' });
    mockDb.createTransaction.mockReturnValue({ transaction_id: 100 });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getIdTagByTag.mockReturnValue(null);
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('creates a transaction and returns transactionId', () => {
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(result.transactionId).toBe(100);
    expect(result.idTagInfo.status).toBe('Accepted');
  });

  it('returns transactionId=0 when auth fails (mode 1, rfid)', () => {
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid', reason: 'expired' });
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'EXPIRED',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(result.transactionId).toBe(0);
    expect(result.idTagInfo.status).toBe('Invalid');
  });

  it('uses remote source when pendingRemoteStarts has connector key', () => {
    mockPendingRemoteStarts.set('CP001_1', { source: 'remote', userId: null });
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(result.transactionId).toBe(100);
    expect(mockPendingRemoteStarts.has('CP001_1')).toBe(false);
  });

  it('uses local source in mode 3', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 3, site_id: 1 });
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(result.idTagInfo.status).toBe('Accepted');
  });

  it.each(['WEB-5', 'ADMIN', 'MGR-3'])(
    'blocks auto-tag prefix "%s" in mode 1 rfid (StartTransaction defense)',
    (idTag) => {
      const result = client._handlers['StartTransaction']({
        connectorId: 1,
        idTag,
        meterStart: 0,
        timestamp: new Date().toISOString(),
      });
      expect(result.transactionId).toBe(0);
      expect(result.idTagInfo.status).toBe('Blocked');
      expect(mockDb.authorizeIdTag).not.toHaveBeenCalled();
    }
  );

  it('does not block auto-tag when source is remote (normal RemoteStart flow)', () => {
    mockPendingRemoteStarts.set('CP001_1', { source: 'web', userId: 5 });
    mockDb.createTransaction.mockReturnValue({ transaction_id: 200 });
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'WEB-5',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(result.transactionId).toBe(200);
    expect(result.idTagInfo.status).toBe('Accepted');
  });
});

// ── StopTransaction ──
describe('ocpp-server-16 — StopTransaction', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('calls stopTransaction and returns Accepted', () => {
    const result = client._handlers['StopTransaction']({
      transactionId: 42,
      meterStop: 1000,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(42, 1000, expect.any(String), 'Local');
    expect(result.idTagInfo.status).toBe('Accepted');
  });

  it('emits site and user notifications when transaction found with valid tag', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({
      chargepoint_id: 1,
      connector_id: 1,
      id_tag: 'TAG001',
      meter_start: 0,
      meter_stop: 5000,
      start_time: new Date(Date.now() - 3600000).toISOString(),
      stop_time: new Date().toISOString(),
    });
    mockDb.getChargepointById.mockReturnValue({ id: 1, site_id: 1, cpname: 'TestCP', site_name: 'Site1' });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getIdTagByTag.mockReturnValue({ user_id: 99 });

    client._handlers['StopTransaction']({
      transactionId: 42,
      meterStop: 5000,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });

    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'site_transaction_stopped',
      expect.objectContaining({ energy_kwh: '5.00' }),
      expect.any(Object)
    );
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'transaction_stopped',
      expect.objectContaining({ transaction_id: 42 }),
      expect.objectContaining({ userId: 99 })
    );
  });
});

// ── MeterValues ──
describe('ocpp-server-16 — MeterValues', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });
    mockDb.getTransactionByTransactionId.mockReturnValue({ meter_start: 0 });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('returns empty object', () => {
    const result = client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'Energy.Active.Import.Register', value: '1500', unit: 'Wh' },
          ],
        },
      ],
    });
    expect(result).toEqual({});
  });

  it('processes Power.Active.Import in kW', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'Power.Active.Import', value: '3.5', unit: 'kW' },
          ],
        },
      ],
    });
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith(42, 3500, null);
  });

  it('processes SoC and current values', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'SoC', value: '80' },
            { measurand: 'Current.Import', value: '16', phase: 'L1' },
            { measurand: 'Current.Import', value: '14', phase: 'L2' },
            { measurand: 'Current.Import', value: '15', phase: 'L3' },
            { measurand: 'Current.Offered', value: '32' },
          ],
        },
      ],
    });
    expect(mockDb.upsertTransactionValues).toHaveBeenCalled();
  });

  it('does nothing when cp is null', () => {
    mockDb.getChargepointByIdentity.mockReturnValue(null);
    const result = client._handlers['MeterValues']({ connectorId: 1, meterValue: [] });
    expect(result).toEqual({});
    expect(mockDb.updateTransactionPowerEnergy).not.toHaveBeenCalled();
  });

  it('handles connector 0 energy update', () => {
    client._handlers['MeterValues']({
      connectorId: 0,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'Energy.Active.Import.Register', value: '2000', unit: 'Wh' },
          ],
        },
      ],
    });
    expect(mockDb.updateChargepointMeterValue).toHaveBeenCalledWith(1, 2000);
  });
});

// ── DataTransfer ──
describe('ocpp-server-16 — DataTransfer', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('returns Accepted', () => {
    expect(client._handlers['DataTransfer']({})).toEqual({ status: 'Accepted' });
  });
});

// ── DiagnosticsStatusNotification ──
describe('ocpp-server-16 — DiagnosticsStatusNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1' });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('returns empty object', () => {
    const result = client._handlers['DiagnosticsStatusNotification']({ status: 'Uploaded' });
    expect(result).toEqual({});
  });

  it('broadcasts and notifies on Uploaded', () => {
    client._handlers['DiagnosticsStatusNotification']({ status: 'Uploaded' });
    expect(mockBroadcast).toHaveBeenCalledWith('diagnostics_upload', expect.objectContaining({ status: 'Uploaded' }));
    expect(mockNotifications.emit).toHaveBeenCalledWith('diagnostics_upload', expect.any(Object));
  });

  it('does not broadcast on intermediate status', () => {
    client._handlers['DiagnosticsStatusNotification']({ status: 'Uploading' });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
