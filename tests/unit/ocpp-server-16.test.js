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
  getActiveTransactionByConnector: jest.fn(),
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
  getChargepointOverrideConfigs: jest.fn(() => []),
  getChargingProfiles: jest.fn(() => []),
  activateReservationByConnector: jest.fn(),
  expireReservationByConnector: jest.fn(),
  updateTransactionChargingState: jest.fn(),
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
  checkConnectorErrorCooldown: jest.fn().mockReturnValue(true),
}));

const { callClient16, register16Handlers, OCPP16_STANDARD_KEYS } = require('../../src/ocpp-server-16');

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
    once: jest.fn(),
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
    expect(mockBroadcast).toHaveBeenCalledWith('ocpp_message', expect.objectContaining({ message_type: 'CALL' }), null);
    expect(mockBroadcast).toHaveBeenCalledWith('ocpp_message', expect.objectContaining({ message_type: 'CALLRESULT' }), null);
  });

  it('bulkUpserts config after GetConfiguration', async () => {
    const configKey = [{ key: 'HeartbeatInterval', value: '60', readonly: false }];
    const mockClient = { call: jest.fn().mockResolvedValue({ configurationKey: configKey }) };
    mockConnectedClients.set('CP002', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 2 });

    await callClient16('CP002', 'GetConfiguration', {});
    expect(mockDb.bulkUpsertChargepointConfig).toHaveBeenCalledWith(2, configKey);
    expect(mockBroadcast).toHaveBeenCalledWith('chargepoint_config_update', expect.any(Object), null);
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

  it('sanitizes BootNotification text fields before persisting', () => {
    client._handlers['BootNotification']({
      chargePointVendor: '<img src=x onerror=alert(1)>Vendor',
      chargePointModel: 'M' + 'X'.repeat(80),
      meterType: '  \u0000Bad<Type>  ',
    });
    expect(mockDb.upsertChargepoint).toHaveBeenCalledWith(
      'CP001',
      expect.objectContaining({
        vendor: 'img src=x onerror=alert(1',
        model: 'M' + 'X'.repeat(19),
        meter_type: 'BadType',
      })
    );
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
      .mockRejectedValueOnce(new Error('Not supported'))     // GetConfiguration {} fails
      .mockResolvedValueOnce({ configurationKey: [{ key: 'GetConfigurationMaxKeys', value: '50', readonly: true }] }) // GetConfigurationMaxKeys
      .mockResolvedValueOnce({})                             // GetConfiguration chunk (42 keys fit in 1 chunk of 50)
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

  it('skips ClearChargingProfile when chargepoint has managed profiles in DB', async () => {
    mockDb.getChargingProfiles.mockReturnValue([{ id: 1, profile_id: 10 }]);

    client.call
      .mockResolvedValueOnce({})  // ClearCache
      .mockResolvedValueOnce({});  // GetConfiguration {} (no ClearChargingProfile slot)

    mockConnectedClients.set('CP001', client);
    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.call).not.toHaveBeenCalledWith('ClearChargingProfile', expect.anything());
    expect(client.call).toHaveBeenCalledWith('GetConfiguration', {});
  });

  it('sends ClearChargingProfile when chargepoint has no profiles in DB', async () => {
    mockDb.getChargingProfiles.mockReturnValue([]);

    client.call
      .mockResolvedValueOnce({})  // ClearCache
      .mockResolvedValueOnce({})  // ClearChargingProfile
      .mockResolvedValueOnce({});  // GetConfiguration {}

    mockConnectedClients.set('CP001', client);
    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.call).toHaveBeenCalledWith('ClearChargingProfile', {});
  });

  it('calls GetConfiguration without params first (happy path, no pagination)', async () => {
    client.call
      .mockResolvedValueOnce({})  // ClearCache
      .mockResolvedValueOnce({})  // ClearChargingProfile
      .mockResolvedValueOnce({});  // GetConfiguration {}

    mockConnectedClients.set('CP001', client);
    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.call).toHaveBeenCalledWith('GetConfiguration', {});
    const getCalls = client.call.mock.calls.filter((c) => c[0] === 'GetConfiguration');
    expect(getCalls.length).toBe(1);
    expect(client.call).not.toHaveBeenCalledWith('GetConfiguration', { key: ['GetConfigurationMaxKeys'] });
  });

  it('paginates GetConfiguration into chunks when GetConfiguration {} fails and maxKeys < OCPP16_STANDARD_KEYS.length', async () => {
    const maxKeys = 10;
    client.call
      .mockResolvedValueOnce({})  // ClearCache
      .mockResolvedValueOnce({})  // ClearChargingProfile
      .mockRejectedValueOnce(new Error('Not supported'))  // GetConfiguration {} fails
      .mockResolvedValueOnce({ configurationKey: [{ key: 'GetConfigurationMaxKeys', value: String(maxKeys), readonly: true }] })
      .mockResolvedValue({});  // all pagination calls

    mockConnectedClients.set('CP001', client);
    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    const getCalls = client.call.mock.calls.filter((c) => c[0] === 'GetConfiguration');
    expect(getCalls[0][1]).toEqual({});  // initial attempt (fails)
    expect(getCalls[1][1]).toEqual({ key: ['GetConfigurationMaxKeys'] });
    expect(getCalls.length).toBe(2 + Math.ceil(OCPP16_STANDARD_KEYS.length / maxKeys));
  });

  it('falls back to default maxKeys=20 and paginates when both GetConfiguration and GetConfigurationMaxKeys fail', async () => {
    client.call
      .mockResolvedValueOnce({})  // ClearCache
      .mockResolvedValueOnce({})  // ClearChargingProfile
      .mockRejectedValueOnce(new Error('Not supported'))  // GetConfiguration {} fails
      .mockRejectedValueOnce(new Error('Not supported'))  // GetConfigurationMaxKeys also fails
      .mockResolvedValue({});  // pagination calls

    mockConnectedClients.set('CP001', client);
    client._handlers['BootNotification']({ chargePointVendor: 'X' });
    await new Promise((resolve) => setImmediate(resolve));

    const getCalls = client.call.mock.calls.filter((c) => c[0] === 'GetConfiguration');
    expect(getCalls[0][1]).toEqual({});  // initial attempt (fails)
    expect(getCalls[1][1]).toEqual({ key: ['GetConfigurationMaxKeys'] });  // also fails
    expect(getCalls.length).toBe(2 + Math.ceil(OCPP16_STANDARD_KEYS.length / 20));
  });

  it('calls bulkUpsertChargepointConfig with configurationKey from GetConfiguration response', async () => {
    const configKeys = [{ key: 'HeartbeatInterval', value: '300', readonly: false }];
    client.call
      .mockResolvedValueOnce({})  // ClearCache
      .mockResolvedValueOnce({})  // ClearChargingProfile
      .mockResolvedValueOnce({ configurationKey: configKeys });  // GetConfiguration {}

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
      .mockResolvedValueOnce({})                                  // GetConfiguration {}
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
      .mockResolvedValueOnce({})                           // GetConfiguration {}
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
    expect(mockBroadcast).toHaveBeenCalledWith('chargepoint_heartbeat', expect.any(Object), null);
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

  it('creates transaction with charging_state=Charging', () => {
    client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ charging_state: 'Charging' })
    );
  });

  it('closes orphan active transaction on same connector before creating new one', () => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 99, connector_id: 1 }]);
    const ts = new Date().toISOString();
    client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 500,
      timestamp: ts,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(99, 500, ts, 'Other');
    expect(mockDb.createTransaction).toHaveBeenCalled();
  });

  it('does not close active transaction on a different connector', () => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 99, connector_id: 2 }]);
    client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    expect(mockDb.createTransaction).toHaveBeenCalled();
  });

  it('calls updateConnectorMeterValue with meterStart when meterStart > 0', () => {
    client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 5000,
      timestamp: new Date().toISOString(),
    });
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 5000);
  });

  it('does not call updateConnectorMeterValue when meterStart === 0', () => {
    client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    expect(mockDb.updateConnectorMeterValue).not.toHaveBeenCalled();
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

  it('clears charging_state on stop (no 5th arg passed to stopTransaction)', () => {
    client._handlers['StopTransaction']({
      transactionId: 42,
      meterStop: 1000,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    const call = mockDb.stopTransaction.mock.calls[0];
    expect(call).toHaveLength(4);
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

  it('calls updateConnectorMeterValue with meterStop when transaction found', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({
      chargepoint_id: 1,
      connector_id: 2,
      id_tag: null,
      meter_start: 1000,
      meter_stop: 6000,
      start_time: new Date(Date.now() - 3600000).toISOString(),
      stop_time: new Date().toISOString(),
    });
    mockDb.getChargepointById.mockReturnValue({ id: 1, site_id: 1, cpname: 'CP', site_name: 'S' });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);

    client._handlers['StopTransaction']({
      transactionId: 42,
      meterStop: 6000,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 2, 6000);
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

  it('calls updateConnectorMeterValue for connector > 0 energy update', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'Energy.Active.Import.Register', value: '3500', unit: 'Wh' },
          ],
        },
      ],
    });
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 3500);
  });

  it('returns {} and skips DB update for unknown transactionId', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    const result = client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 99999,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Power.Active.Import', value: '3.5', unit: 'kW' }],
        },
      ],
    });
    expect(result).toEqual({});
    expect(mockDb.updateTransactionPowerEnergy).not.toHaveBeenCalled();
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

// ── StatusNotification ──
describe('ocpp-server-16 — StatusNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 0 });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('updates cpstatus and has_connector0 for connectorId=0', () => {
    client._handlers['StatusNotification']({ connectorId: 0, status: 'Unavailable', errorCode: 'NoError' });
    expect(mockDb.updateChargepointStatus).toHaveBeenCalledWith(
      'CP001', 'Unavailable', true,
      expect.objectContaining({ error_code: 'NoError' })
    );
    expect(mockDb.upsertChargepoint).toHaveBeenCalledWith('CP001', { has_connector0: 1 });
  });

  it('sanitizes StatusNotification fields before DB writes and notifications', () => {
    client._handlers['StatusNotification']({
      connectorId: 1,
      status: 'InvalidStatus',
      errorCode: 'BadCode',
      info: '<script>alert(1)</script>',
      vendorId: '  \u0001Vendor<id> ',
      vendorErrorCode: '<err>',
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1,
      1,
      'Unavailable',
      'OtherError',
      'scriptalert(1)/script',
      'Vendorid',
      'err',
      null,
      'Unavailable'
    );
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'connector_error',
      expect.objectContaining({
        status: 'Unavailable',
        error_code: 'OtherError',
        info: 'scriptalert(1)/script',
      }),
      expect.any(Object)
    );
  });

  it('derives cpstatus from connectors when cpstatus=Unavailable and connector0 absent', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Unavailable', has_connector0: 0 });
    mockDb.getConnectorsByChargepoint.mockReturnValue([{ cnstatus: 'Available' }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Available', errorCode: 'NoError' });
    expect(mockDb.updateChargepointStatus).toHaveBeenCalledWith('CP001', 'Available', true);
  });

  it('derives cpstatus from connectors even when has_connector0=1 (regression: CP shows Unavailable but connector is Available)', () => {
    // Scenario: CP sent connector0=Unavailable first, then connector1=Available
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Unavailable', has_connector0: 1 });
    mockDb.getConnectorsByChargepoint.mockReturnValue([{ cnstatus: 'Available' }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Available', errorCode: 'NoError' });
    expect(mockDb.updateChargepointStatus).toHaveBeenCalledWith('CP001', 'Available', true);
  });

  it('keeps cpstatus=Unavailable when all connectors are Unavailable and has_connector0=1', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Unavailable', has_connector0: 1 });
    mockDb.getConnectorsByChargepoint.mockReturnValue([{ cnstatus: 'Unavailable' }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Unavailable', errorCode: 'NoError' });
    expect(mockDb.updateChargepointStatus).toHaveBeenCalledWith('CP001', 'Unavailable', true);
  });

  it('updates last_heartbeat without changing cpstatus when cpstatus is not Unavailable', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1 });
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDb.updateChargepointStatus).toHaveBeenCalledWith('CP001', undefined, true);
  });

  it('closes orphan active transaction when connector becomes Available', () => {
    const ts = '2026-05-16T15:34:42Z';
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 99, connector_id: 1, meter_start: 500 }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Available', errorCode: 'NoError', timestamp: ts });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(99, 500, ts, 'EVDisconnected');
  });

  it('does not close transaction when connector status is not Available', () => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 99, connector_id: 1, meter_start: 500 }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
  });
});

// ── StatusNotification — reservation sync ──
describe('ocpp-server-16 — StatusNotification reservation sync', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('calls activateReservationByConnector when status=Reserved', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1, feat_reservation: 0,
    });
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Reserved', errorCode: 'NoError' });
    expect(mockDb.activateReservationByConnector).toHaveBeenCalledWith(1, 1);
    expect(mockDb.expireReservationByConnector).not.toHaveBeenCalled();
  });

  it.each(['Available', 'Faulted', 'Unavailable', 'Finishing'])(
    'calls expireReservationByConnector when status=%s',
    (status) => {
      mockDb.getChargepointByIdentity.mockReturnValue({
        id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1, feat_reservation: 0,
      });
      client._handlers['StatusNotification']({ connectorId: 1, status, errorCode: 'NoError' });
      expect(mockDb.expireReservationByConnector).toHaveBeenCalledWith(1, 1);
      expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
    }
  );

  it('does not call reservation functions for connectorId=0', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Unavailable', has_connector0: 0, feat_reservation: 1,
    });
    client._handlers['StatusNotification']({ connectorId: 0, status: 'Reserved', errorCode: 'NoError' });
    expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.expireReservationByConnector).not.toHaveBeenCalled();
  });

  it('does not call reservation functions for status=Charging (not in trigger list)', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1, feat_reservation: 1,
    });
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.expireReservationByConnector).not.toHaveBeenCalled();
  });
});

// ── StatusNotification — charging_state ──
describe('ocpp-server-16 — StatusNotification charging_state', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1,
    });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it.each([
    ['Charging', 'Charging'],
    ['SuspendedEV', 'SuspendedEV'],
    ['SuspendedEVSE', 'SuspendedEVSE'],
    ['Finishing', 'EVConnected'],
    ['Preparing', 'EVConnected'],
  ])('maps status=%s to chargingState=%s on active transaction', (status, expectedState) => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: '42', connector_id: 1 }]);
    client._handlers['StatusNotification']({ connectorId: 1, status, errorCode: 'NoError' });
    expect(mockDb.updateTransactionChargingState).toHaveBeenCalledWith('42', expectedState);
  });

  it('does not call updateTransactionChargingState when no active transaction', () => {
    mockDb.getTransactions.mockReturnValue([]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDb.updateTransactionChargingState).not.toHaveBeenCalled();
  });

  it('does not call updateTransactionChargingState for connectorId=0', () => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: '42', connector_id: 0 }]);
    client._handlers['StatusNotification']({ connectorId: 0, status: 'Unavailable', errorCode: 'NoError' });
    expect(mockDb.updateTransactionChargingState).not.toHaveBeenCalled();
  });

  it('does not call updateTransactionChargingState when status maps to null (e.g. Available)', () => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: '42', connector_id: 1 }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Available', errorCode: 'NoError' });
    expect(mockDb.updateTransactionChargingState).not.toHaveBeenCalled();
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
    expect(mockBroadcast).toHaveBeenCalledWith('diagnostics_upload', expect.objectContaining({ status: 'Uploaded' }), null);
    expect(mockNotifications.emit).toHaveBeenCalledWith('diagnostics_upload', expect.any(Object));
  });

  it('does not broadcast on intermediate status', () => {
    client._handlers['DiagnosticsStatusNotification']({ status: 'Uploading' });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

// ── FirmwareStatusNotification ──
describe('ocpp-server-16 — FirmwareStatusNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1' });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('returns empty object', () => {
    const result = client._handlers['FirmwareStatusNotification']({ status: 'Installed' });
    expect(result).toEqual({});
  });

  it('always broadcasts on any status', () => {
    client._handlers['FirmwareStatusNotification']({ status: 'Downloading' });
    expect(mockBroadcast).toHaveBeenCalledWith('firmware_status', expect.objectContaining({ status: 'Downloading' }), null);
  });

  it('notifies on Installed', () => {
    client._handlers['FirmwareStatusNotification']({ status: 'Installed' });
    expect(mockNotifications.emit).toHaveBeenCalledWith('firmware_status', expect.objectContaining({ status: 'Installed' }));
  });

  it('notifies on InstallationFailed', () => {
    client._handlers['FirmwareStatusNotification']({ status: 'InstallationFailed' });
    expect(mockNotifications.emit).toHaveBeenCalledWith('firmware_status', expect.objectContaining({ status: 'InstallationFailed' }));
  });

  it('notifies on DownloadFailed', () => {
    client._handlers['FirmwareStatusNotification']({ status: 'DownloadFailed' });
    expect(mockNotifications.emit).toHaveBeenCalledWith('firmware_status', expect.objectContaining({ status: 'DownloadFailed' }));
  });

  it('does not notify on intermediate status', () => {
    client._handlers['FirmwareStatusNotification']({ status: 'Downloading' });
    expect(mockNotifications.emit).not.toHaveBeenCalled();
  });
});

// ── StateRefresh (TriggerMessage on reconnect without BootNotification) ──
describe('ocpp-server-16 — StateRefresh TriggerMessage', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends TriggerMessage(BootNotification) + TriggerMessage(StatusNotification) when initialized=1 and cpstatus=null after 8s', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, cpstatus: null })   // register16Handlers
      .mockReturnValueOnce({ id: 1, connected: 1, cpstatus: null })     // timer check
      .mockReturnValue({ id: 1 });                                        // callClient16 calls
    mockConnectedClients.set('CP001', client);

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });

  it('does not send TriggerMessage when cpstatus is set before the timer fires', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, cpstatus: null })       // register16Handlers
      .mockReturnValue({ id: 1, connected: 1, cpstatus: 'Available' });     // timer check (BootNotification already received)

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('does not set timer when initialized=0 (new chargepoint, full boot expected)', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 0, cpstatus: null });

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('does not set timer when cpRecord is null (unknown chargepoint)', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue(null);

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('registers close listener to cancel the timer', () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 1, cpstatus: null });

    register16Handlers(client, makeLoggedHandle(client));

    expect(client.once).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('does not send TriggerMessage when chargepoint disconnects before 8s', async () => {
    const client = makeClient('CP001');
    let closeCallback;
    client.once = jest.fn((event, cb) => { if (event === 'close') closeCallback = cb; });
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 1, cpstatus: null });

    register16Handlers(client, makeLoggedHandle(client));
    closeCallback(); // simulate disconnect
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('does not send StatusNotification TriggerMessage when BootNotification TriggerMessage fails', async () => {
    const client = makeClient('CP001');
    client.call = jest.fn().mockRejectedValue(new Error('not connected'));
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, cpstatus: null })
      .mockReturnValueOnce({ id: 1, connected: 1, cpstatus: null })
      .mockReturnValue({ id: 1 });
    mockConnectedClients.set('CP001', client);

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });
});
