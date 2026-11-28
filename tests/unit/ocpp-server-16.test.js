'use strict';

const mockDb = {
  getChargepointByIdentity: jest.fn(),
  getChargepointById: jest.fn(),
  updateChargepointByIdentity: jest.fn(),
  addOcppMessage: jest.fn(),
  bulkUpsertChargepointConfig: jest.fn(),
  upsertChargepointConfig: jest.fn(),
  createTransaction: jest.fn(),
  stopTransaction: jest.fn(),
  getTransactions: jest.fn(() => []),
  getTransactionByTransactionId: jest.fn(),
  getActiveTransactionByConnector: jest.fn(),
  updateChargepointStatus: jest.fn(),
  touchLastHeartbeat: jest.fn(),
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
  expireActiveReservationByConnector: jest.fn(),
  fulfillInUseReservationByConnector: jest.fn(),
  startUsingReservationByConnectorAndIdTag: jest.fn(() => 0),
  getReservationByOcppId: jest.fn(),
  fulfillReservationByConnectorAndIdTag: jest.fn(() => 0),
  updateTransactionChargingState: jest.fn(),
  correctServerClosedTransaction: jest.fn(),
  stopRejectedTransaction: jest.fn(),
  insertErrorEvent: jest.fn(),
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
    silly: jest.fn(),
  }),
}));

const mockConnectedClients = new Map();
const mockPendingRemoteStarts = new Map();
const mockBroadcast = jest.fn();
const mockTrackRepeatedAuthReject = jest.fn();
const mockDebounceAvailabilityNotif = jest.fn((identity, connectorId, fn) => fn());

jest.mock('../../src/ocpp-common', () => ({
  broadcast: mockBroadcast,
  getConnectedClients: jest.fn(() => mockConnectedClients),
  pendingRemoteStarts: mockPendingRemoteStarts,
  trackRepeatedAuthReject: mockTrackRepeatedAuthReject,
  registerCallClientImpl: jest.fn(),
  registerHandlersFn: jest.fn(),
  checkConnectorErrorCooldown: jest.fn().mockReturnValue(true),
  debounceAvailabilityNotif: mockDebounceAvailabilityNotif,
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
    expect(mockDb.updateChargepointByIdentity).toHaveBeenCalledWith(
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

  it('does not call updateChargepointStatus (handled by makeLoggedHandle)', () => {
    mockDb.updateChargepointStatus.mockClear();
    client._handlers['Heartbeat']({});
    expect(mockDb.updateChargepointStatus).not.toHaveBeenCalled();
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

  it('M7 — démarrage refusé : la transaction est enregistrée (Rejected) avec un vrai transactionId', () => {
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid', reason: 'expired' });
    mockDb.createTransaction.mockReturnValue({ transaction_id: 101, status: 'Rejected' });
    const ts = new Date().toISOString();
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'EXPIRED',
      meterStart: 40,
      timestamp: ts,
    });
    // La borne a déjà démarré la transaction : elle reçoit un identifiant unique (pas 0)
    expect(result.transactionId).toBe(101);
    expect(result.idTagInfo.status).toBe('Invalid');
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      1,
      1,
      'EXPIRED',
      40,
      ts,
      'rfid',
      expect.objectContaining({ status: 'Rejected' })
    );
    // Ni clôture d'orpheline, ni notification de démarrage
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    expect(mockNotifications.emit).not.toHaveBeenCalled();
  });

  it('M7 — StartTransaction refusée retransmise : renvoie la transaction refusée existante', () => {
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid', reason: 'expired' });
    const ts = new Date().toISOString();
    mockDb.getTransactions.mockImplementation((f) =>
      f.status === 'Rejected'
        ? [
            {
              transaction_id: '55',
              connector_id: 1,
              id_tag: 'EXPIRED',
              meter_start: 40,
              start_time: ts,
              stop_time: null,
              status: 'Rejected',
            },
          ]
        : []
    );
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'EXPIRED',
      meterStart: 40,
      timestamp: ts,
    });
    expect(result.transactionId).toBe(55);
    expect(mockDb.createTransaction).not.toHaveBeenCalled();
    mockDb.getTransactions.mockReset();
    mockDb.getTransactions.mockReturnValue([]);
  });

  it('uses remote source when pendingRemoteStarts has connector key', () => {
    mockPendingRemoteStarts.set('CP001_1', { source: 'remote', userId: null, idTag: 'TAG001' });
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
      // Refus enregistré (Rejected) : la borne reçoit un vrai identifiant
      expect(result.transactionId).toBe(100);
      expect(mockDb.createTransaction).toHaveBeenCalledWith(
        1, 1, idTag, 0, expect.any(String), 'rfid', expect.objectContaining({ status: 'Rejected' })
      );
      expect(result.idTagInfo.status).toBe('Blocked');
      expect(mockDb.authorizeIdTag).not.toHaveBeenCalled();
    }
  );

  it('does not block auto-tag when source is remote (normal RemoteStart flow)', () => {
    mockPendingRemoteStarts.set('CP001_1', { source: 'web', userId: 5, idTag: 'WEB-5' });
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
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(1, 99, 500, ts, 'Other', 'server');
    expect(mockDb.createTransaction).toHaveBeenCalled();
  });

  it('retransmitted StartTransaction (same connector, tag, meter, timestamp) returns the existing transaction', () => {
    const ts = new Date().toISOString();
    mockDb.getTransactions.mockReturnValue([
      { transaction_id: '99', connector_id: 1, id_tag: 'TAG001', meter_start: 500, start_time: ts },
    ]);
    const result = client._handlers['StartTransaction']({
      connectorId: 1,
      idTag: 'TAG001',
      meterStart: 500,
      timestamp: ts,
    });
    expect(result.transactionId).toBe(99);
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    expect(mockDb.createTransaction).not.toHaveBeenCalled();
  });

  it('a new StartTransaction with another meter/timestamp still closes the orphan', () => {
    mockDb.getTransactions.mockReturnValue([
      { transaction_id: '99', connector_id: 1, id_tag: 'TAG001', meter_start: 500, start_time: '2026-01-01T00:00:00Z' },
    ]);
    const ts = new Date().toISOString();
    client._handlers['StartTransaction']({ connectorId: 1, idTag: 'TAG001', meterStart: 900, timestamp: ts });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(1, '99', 900, ts, 'Other', 'server');
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
  const HOUR_AGO = () => new Date(Date.now() - 3600000).toISOString();
  // Transaction active telle que lue avant l'arrêt (recherche par borne + transactionId)
  const activeTx = (over = {}) => ({
    id: 7,
    chargepoint_id: 1,
    transaction_id: '42',
    connector_id: 1,
    id_tag: null,
    status: 'Active',
    meter_start: 0,
    energy: null,
    start_time: HOUR_AGO(),
    ...over,
  });
  // Résultat de db.stopTransaction : la transaction close
  const closedResult = (over = {}) => ({
    tx: {
      chargepoint_id: 1,
      transaction_id: '42',
      connector_id: 1,
      id_tag: null,
      meter_start: 0,
      meter_stop: 1000,
      start_time: HOUR_AGO(),
      stop_time: new Date().toISOString(),
      status: 'Completed',
      ...over,
    },
    closed: true,
  });
  const stop = (over = {}) =>
    client._handlers['StopTransaction']({
      transactionId: 42,
      meterStop: 1000,
      timestamp: new Date().toISOString(),
      reason: 'Local',
      ...over,
    });

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    mockDb.getTransactionByTransactionId.mockReturnValue(activeTx());
    mockDb.stopTransaction.mockReturnValue(closedResult());
    mockDb.getChargepointById.mockReturnValue({ id: 1, site_id: 1, cpname: 'CP', site_name: 'S' });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('cherche la transaction par (borne, transactionId) et la clôt côté borne', () => {
    const result = stop();
    expect(mockDb.getTransactionByTransactionId).toHaveBeenCalledWith(1, 42);
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(1, 42, 1000, expect.any(String), 'Local');
    // Sans idTag dans la requête, idTagInfo est omis (champ facultatif)
    expect(result).toEqual({});
  });

  it('emits site and user notifications when transaction found with valid tag', () => {
    mockDb.stopTransaction.mockReturnValue(closedResult({ id_tag: 'TAG001', meter_stop: 5000 }));
    mockDb.getIdTagByTag.mockReturnValue({ user_id: 99 });
    stop({ meterStop: 5000 });
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'site_transaction_stopped',
      expect.objectContaining({ energy_kwh: '5.00' }),
      expect.any(Object)
    );
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'transaction_stopped',
      expect.objectContaining({ transaction_id: '42' }),
      expect.objectContaining({ userId: 99 })
    );
  });

  it('calls updateConnectorMeterValue with meterStop when transaction found', () => {
    mockDb.stopTransaction.mockReturnValue(closedResult({ connector_id: 2, meter_stop: 6000 }));
    stop({ meterStop: 6000 });
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 2, 6000);
  });

  it('calls fulfillReservationByConnectorAndIdTag when InUse reservation matches', () => {
    mockDb.stopTransaction.mockReturnValue(closedResult({ id_tag: 'TAG001' }));
    mockDb.fulfillReservationByConnectorAndIdTag.mockReturnValue(1);
    stop();
    expect(mockDb.fulfillReservationByConnectorAndIdTag).toHaveBeenCalledWith(1, 1, 'TAG001');
    expect(mockBroadcast).toHaveBeenCalledWith(
      'reservation_updated',
      { chargepoint_id: 1 },
      expect.anything()
    );
  });

  it('does not broadcast reservation_updated when no InUse reservation matched', () => {
    mockDb.stopTransaction.mockReturnValue(closedResult({ id_tag: 'TAG001' }));
    mockDb.fulfillReservationByConnectorAndIdTag.mockReturnValue(0);
    stop();
    expect(mockDb.fulfillReservationByConnectorAndIdTag).toHaveBeenCalledWith(1, 1, 'TAG001');
    expect(mockBroadcast.mock.calls.filter((c) => c[0] === 'reservation_updated')).toHaveLength(0);
  });

  it('corrects meterStop when incoherent (meterStop <= meter_start with energy > 0)', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(
      activeTx({ meter_start: 5000, energy: 2000 })
    );
    mockDb.stopTransaction.mockReturnValue(closedResult({ meter_start: 5000, meter_stop: 7000 }));
    stop({ meterStop: 5000, reason: 'DeAuthorized' });
    // meterStop corrigé à 5000 + 2000 = 7000
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(
      1,
      42,
      7000,
      expect.any(String),
      'DeAuthorized'
    );
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 7000);
  });

  it('M2 — StopTransaction retransmis (déjà close par la borne) : aucune notification ni nouvelle clôture', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(
      activeTx({ status: 'Completed', closed_by: 'station', meter_stop: 1000 })
    );
    const result = stop();
    expect(result).toEqual({});
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    expect(mockDb.correctServerClosedTransaction).not.toHaveBeenCalled();
    expect(mockNotifications.emit).not.toHaveBeenCalled();
    expect(mockBroadcast.mock.calls.filter((c) => c[0] === 'transaction_stop')).toHaveLength(0);
  });

  it('M2 — stopTransaction sans clôture effective (closed=false) : aucune notification', () => {
    mockDb.stopTransaction.mockReturnValue({ tx: closedResult().tx, closed: false });
    stop();
    expect(mockNotifications.emit).not.toHaveBeenCalled();
  });

  it("H4 — l'arrêt réel corrige une transaction close par le serveur, sans notification", () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(
      activeTx({ status: 'Completed', closed_by: 'server', meter_stop: 3000 })
    );
    mockDb.correctServerClosedTransaction.mockReturnValue({
      transaction_id: '42',
      connector_id: 1,
      meter_stop: 4500,
      stop_reason: 'EVDisconnected',
    });
    const ts = new Date().toISOString();
    stop({ meterStop: 4500, timestamp: ts, reason: 'EVDisconnected' });
    expect(mockDb.correctServerClosedTransaction).toHaveBeenCalledWith(
      1,
      42,
      4500,
      ts,
      'EVDisconnected'
    );
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 4500);
    expect(mockBroadcast).toHaveBeenCalledWith(
      'transaction_stop',
      expect.objectContaining({ transactionId: '42', meterStop: 4500 }),
      1
    );
    expect(mockNotifications.emit).not.toHaveBeenCalled();
  });

  it("M7 — arrêt d'une transaction refusée : compteur gardé, ni clôture facturée ni notification", () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(activeTx({ status: 'Rejected' }));
    const ts = new Date().toISOString();
    const result = stop({ meterStop: 150, timestamp: ts, reason: 'DeAuthorized' });
    expect(mockDb.stopRejectedTransaction).toHaveBeenCalledWith(1, 42, 150, ts, 'DeAuthorized');
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    expect(mockNotifications.emit).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('fallback : ferme la tx active du chargeur si transactionId inconnu', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    mockDb.getTransactions.mockReturnValue([{ transaction_id: '888', start_time: HOUR_AGO() }]);
    mockDb.stopTransaction.mockReturnValue(closedResult({ transaction_id: '888' }));
    stop({ transactionId: 4242, reason: 'Other' });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(
      1,
      '888',
      1000,
      expect.any(String),
      'Other'
    );
  });

  describe('fallback sur transactionId inconnu — jamais ambigu', () => {
    const active = (id, connectorId) => ({
      transaction_id: id,
      connector_id: connectorId,
      start_time: new Date().toISOString(),
    });

    beforeEach(() => {
      mockDb.getTransactionByTransactionId.mockReturnValue(null);
    });

    it("transactionId 0 : ne ferme JAMAIS la transaction d'un autre connecteur", () => {
      mockDb.getTransactions.mockReturnValue([active('777', 1)]);
      stop({ transactionId: 0, meterStop: 10, reason: 'DeAuthorized' });
      expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    });

    it('plusieurs transactions actives : pas de repli (on ne sait pas laquelle clore)', () => {
      mockDb.getTransactions.mockReturnValue([active('701', 1), active('702', 2)]);
      stop({ transactionId: 9999, meterStop: 10 });
      expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    });
  });
});

// ── MeterValues ──
describe('ocpp-server-16 — MeterValues', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });
    mockDb.getTransactionByTransactionId.mockReturnValue({ meter_start: 0, status: 'Active' });
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
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith(1, 42, 3500, null);
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

  it('returns {} and skips DB update for unknown transactionId (no active tx on connector)', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    mockDb.getActiveTransactionByConnector.mockReturnValue(null);
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

  it('redirects MeterValues to active tx on connector when txId unknown', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    mockDb.getActiveTransactionByConnector.mockReturnValue({ transaction_id: '777', meter_start: 1000, status: 'Active' });
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 99999,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Power.Active.Import', value: '3.0', unit: 'kW' }],
        },
      ],
    });
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith(1, '777', 3000, null);
  });

  it('returns {} and logs energy for MeterValues on Completed transaction', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({ meter_start: 0, status: 'Completed' });
    const result = client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '5000', unit: 'Wh' }],
        },
      ],
    });
    expect(result).toEqual({});
    expect(mockDb.updateTransactionPowerEnergy).not.toHaveBeenCalled();
  });

  it('H4 — relevés tardifs d\'une transaction close par le serveur : gardés pour le graphe seulement', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({
      meter_start: 1000,
      status: 'Completed',
      closed_by: 'server',
    });
    const ts = new Date().toISOString();
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: ts,
          sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '4000', unit: 'Wh' }],
        },
      ],
    });
    expect(mockDb.upsertTransactionValues).toHaveBeenCalledWith(
      1,
      42,
      expect.objectContaining({ energieEntry: expect.objectContaining({ energy: 3000 }) })
    );
    expect(mockDb.updateTransactionPowerEnergy).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalledWith('transaction_updated', expect.anything(), expect.anything());
  });

  it('broadcasts transaction_updated when active transaction exists', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({ meter_start: 0, status: 'Active' });
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'Power.Active.Import', value: '7.4', unit: 'kW' },
            { measurand: 'Energy.Active.Import.Register', value: '5000', unit: 'Wh' },
          ],
        },
      ],
    });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'transaction_updated',
      expect.objectContaining({ transactionId: 42, power: 7400, energy: 5000 }),
      null
    );
  });

  it('does not broadcast transaction_updated without active transaction', () => {
    mockDb.getActiveTransactionByConnector.mockReturnValue(null);
    client._handlers['MeterValues']({
      connectorId: 1,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Power.Active.Import', value: '3.0', unit: 'kW' }],
        },
      ],
    });
    const txUpdatedCalls = mockBroadcast.mock.calls.filter((c) => c[0] === 'transaction_updated');
    expect(txUpdatedCalls).toHaveLength(0);
  });

  it('broadcasts chargepoint_meter_update when energy measurand is present', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: null, meter_value: 2000 });
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
    expect(mockBroadcast).toHaveBeenCalledWith(
      'chargepoint_meter_update',
      { identity: 'CP001', meter_value: 2000 },
      null
    );
  });

  it('does not broadcast chargepoint_meter_update when no energy measurand', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Power.Active.Import', value: '3.0', unit: 'kW' }],
        },
      ],
    });
    const calls = mockBroadcast.mock.calls.filter((c) => c[0] === 'chargepoint_meter_update');
    expect(calls).toHaveLength(0);
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

  // Aucune extension constructeur : la spec 1.6 impose UnknownVendorId pour un vendorId non reconnu
  it('returns UnknownVendorId (no vendor extension implemented)', () => {
    expect(client._handlers['DataTransfer']({ vendorId: 'ACME' })).toEqual({
      status: 'UnknownVendorId',
    });
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
    expect(mockDb.updateChargepointByIdentity).toHaveBeenCalledWith('CP001', { has_connector0: 1 });
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

  it('does not call updateChargepointStatus when cpstatus is not Unavailable (handled by makeLoggedHandle)', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1 });
    mockDb.updateChargepointStatus.mockClear();
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDb.updateChargepointStatus).not.toHaveBeenCalled();
  });

  it('closes orphan active transaction when connector becomes Available', () => {
    const ts = '2026-05-16T15:34:42Z';
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 99, connector_id: 1, meter_start: 500 }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Available', errorCode: 'NoError', timestamp: ts });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(1, 99, 500, ts, 'EVDisconnected', 'server');
  });

  it('closes the orphan with meter_start + accumulated energy (not meter_start → 0 kWh billed)', () => {
    const ts = '2026-05-16T15:34:42Z';
    mockDb.getTransactions.mockReturnValue([
      { transaction_id: 99, connector_id: 1, meter_start: 500, energy: 7200 },
    ]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Available', errorCode: 'NoError', timestamp: ts });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(1, 99, 7700, ts, 'EVDisconnected', 'server');
  });

  it('does not close transaction when connector status is not Available', () => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 99, connector_id: 1, meter_start: 500 }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
  });

  it('appelle debounceAvailabilityNotif pour connector_available (Unavailable → Available)', () => {
    mockDb.getConnectorByChargepointAndId.mockReturnValue({ cnstatus: 'Unavailable', connector_id: 1 });
    mockDebounceAvailabilityNotif.mockClear();
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Available', errorCode: 'NoError' });
    expect(mockDebounceAvailabilityNotif).toHaveBeenCalledWith('CP001', 1, expect.any(Function));
  });

  it('appelle debounceAvailabilityNotif pour connector_unavailable', () => {
    mockDebounceAvailabilityNotif.mockClear();
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Unavailable', errorCode: 'NoError' });
    expect(mockDebounceAvailabilityNotif).toHaveBeenCalledWith('CP001', 1, expect.any(Function));
  });

  it('ne déclenche pas debounceAvailabilityNotif pour les statuts non Available/Unavailable', () => {
    mockDebounceAvailabilityNotif.mockClear();
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDebounceAvailabilityNotif).not.toHaveBeenCalled();
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
    expect(mockDb.expireActiveReservationByConnector).not.toHaveBeenCalled();
  });

  it.each(['Available', 'Faulted', 'Unavailable'])(
    'calls expireActiveReservationByConnector and fulfillInUseReservationByConnector when status=%s',
    (status) => {
      mockDb.getChargepointByIdentity.mockReturnValue({
        id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1, feat_reservation: 0,
      });
      client._handlers['StatusNotification']({ connectorId: 1, status, errorCode: 'NoError' });
      expect(mockDb.expireActiveReservationByConnector).toHaveBeenCalledWith(1, 1);
      expect(mockDb.fulfillInUseReservationByConnector).toHaveBeenCalledWith(1, 1);
      expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
    }
  );

  it('does not call any reservation function when status=Finishing', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1, feat_reservation: 0,
    });
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Finishing', errorCode: 'NoError' });
    expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.expireActiveReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.fulfillInUseReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.startUsingReservationByConnectorAndIdTag).not.toHaveBeenCalled();
  });

  it('does not call reservation functions for connectorId=0', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Unavailable', has_connector0: 0, feat_reservation: 1,
    });
    client._handlers['StatusNotification']({ connectorId: 0, status: 'Reserved', errorCode: 'NoError' });
    expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.expireActiveReservationByConnector).not.toHaveBeenCalled();
  });

  it('does not call startUsingReservationByConnectorAndIdTag when Charging but no active transaction', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1, feat_reservation: 1,
    });
    mockDb.getActiveTransactionByConnector.mockReturnValue(null);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.expireActiveReservationByConnector).not.toHaveBeenCalled();
    expect(mockDb.startUsingReservationByConnectorAndIdTag).not.toHaveBeenCalled();
  });

  it.each(['Charging', 'SuspendedEV', 'SuspendedEVSE'])(
    'calls startUsingReservationByConnectorAndIdTag when status=%s and active transaction found',
    (status) => {
      mockDb.getChargepointByIdentity.mockReturnValue({
        id: 1, cpname: 'CP', site_name: 'S1', cpstatus: 'Available', has_connector0: 1, feat_reservation: 1,
      });
      mockDb.getActiveTransactionByConnector.mockReturnValue({ id_tag: 'TAG001' });
      client._handlers['StatusNotification']({ connectorId: 1, status, errorCode: 'NoError' });
      expect(mockDb.startUsingReservationByConnectorAndIdTag).toHaveBeenCalledWith(1, 1, 'TAG001');
      expect(mockDb.activateReservationByConnector).not.toHaveBeenCalled();
      expect(mockDb.expireActiveReservationByConnector).not.toHaveBeenCalled();
    }
  );
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
    expect(mockDb.updateTransactionChargingState).toHaveBeenCalledWith(1, '42', expectedState);
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

  it('broadcasts transaction_updated when charging_state changes for active transaction', () => {
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 'tx-abc', connector_id: 1 }]);
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'transaction_updated',
      expect.objectContaining({ transactionId: 'tx-abc', charging_state: 'Charging' }),
      null
    );
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

  it('sends TriggerMessage(BootNotification) + TriggerMessage(StatusNotification) when initialized=1 and cpstatus=null after 20s', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, cpstatus: null })  // register16Handlers
      .mockReturnValueOnce({ id: 1, connected: 1, cpstatus: null })    // timer check
      .mockReturnValue({ id: 1, connected: 1 });                        // callClient16 + afterBoot + callClient16
    mockConnectedClients.set('CP001', client);

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(30001); // 20s outer + 10s inner wait

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });

  it('skips TriggerMessage(StatusNotification) when StatusNotification arrives automatically during boot sequence', async () => {
    const client = makeClient('CP001');
    const lh = makeLoggedHandle(client);
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, cpstatus: null })
      .mockReturnValueOnce({ id: 1, connected: 1, cpstatus: null })
      .mockReturnValue({ id: 1, connected: 1, cpstatus: 'Available', site_id: null });
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getTransactions.mockReturnValue([]);
    mockConnectedClients.set('CP001', client);

    register16Handlers(client, lh);

    // Fire the 20s timer → TriggerMessage(Boot) sent, 10s inner wait begins
    await jest.advanceTimersByTimeAsync(20001);

    // Simulate StatusNotification arriving automatically (borne type EV-BOX)
    client._handlers['StatusNotification']({
      connectorId: 1,
      status: 'Available',
      errorCode: 'NoError',
    });
    // Drain microtasks so the Promise resolves and StateRefresh continues
    await Promise.resolve();
    await Promise.resolve();

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });

  it('does not send TriggerMessage when cpstatus is set before the timer fires', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, cpstatus: null })       // register16Handlers
      .mockReturnValue({ id: 1, connected: 1, cpstatus: 'Available' });     // timer check (BootNotification already received)

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(20001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('does not set timer when initialized=0 (new chargepoint, full boot expected)', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 0, cpstatus: null });

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(20001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('does not set timer when cpRecord is null (unknown chargepoint)', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue(null);

    register16Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(20001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('registers close listener to cancel the timer', () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 1, cpstatus: null });

    register16Handlers(client, makeLoggedHandle(client));

    expect(client.once).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('does not send TriggerMessage when chargepoint disconnects before 20s', async () => {
    const client = makeClient('CP001');
    let closeCallback;
    client.once = jest.fn((event, cb) => { if (event === 'close') closeCallback = cb; });
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 1, cpstatus: null });

    register16Handlers(client, makeLoggedHandle(client));
    closeCallback(); // simulate disconnect
    await jest.advanceTimersByTimeAsync(20001);

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
    await jest.advanceTimersByTimeAsync(20001);

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });
});

// ── Lot B : conformité spec ──
describe('ocpp-server-16 — MeterValues conformité (lot B)', () => {
  let client;
  const T1 = '2026-11-22T10:00:00Z';
  const T2 = '2026-11-22T10:05:00Z';

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    mockDb.getTransactionByTransactionId.mockReturnValue({ meter_start: 1000, status: 'Active' });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('measurand absent = Energy.Active.Import.Register (défaut spec)', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [{ timestamp: T1, sampledValue: [{ value: '4200' }] }],
    });
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith(1, 42, null, 4200);
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 4200);
  });

  it("une tension phase-à-phase n'écrase pas la tension L1", () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [{ timestamp: T1, sampledValue: [
        { measurand: 'Voltage', value: '230', phase: 'L1-N' },
        { measurand: 'Voltage', value: '398', phase: 'L1-L2' },
        { measurand: 'Voltage', value: '399', phase: 'L2-L3' },
      ]}],
    });
    const tv = mockDb.upsertTransactionValues.mock.calls[0][2];
    expect(tv.tensionEntry.l1).toBe(230);
    expect(tv.tensionEntry.l2).toBeNull();
  });

  it('puissance totale prioritaire sur les puissances par phase', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [{ timestamp: T1, sampledValue: [
        { measurand: 'Power.Active.Import', value: '2400', unit: 'W', phase: 'L1' },
        { measurand: 'Power.Active.Import', value: '7.2', unit: 'kW' },
        { measurand: 'Power.Active.Import', value: '2400', unit: 'W', phase: 'L2' },
      ]}],
    });
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith(1, 42, 7200, null);
  });

  it('puissance par phase seule : somme des phases', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [{ timestamp: T1, sampledValue: [
        { measurand: 'Power.Active.Import', value: '2400', unit: 'W', phase: 'L1' },
        { measurand: 'Power.Active.Import', value: '2400', unit: 'W', phase: 'L2' },
        { measurand: 'Power.Active.Import', value: '2400', unit: 'W', phase: 'L3' },
      ]}],
    });
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith(1, 42, 7200, null);
  });

  it('un lot (plusieurs meterValue) alimente un point de graphe PAR entrée horodatée', () => {
    client._handlers['MeterValues']({
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        { timestamp: T1, sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '1500' }] },
        { timestamp: T2, sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '2100' }] },
      ],
    });
    expect(mockDb.upsertTransactionValues).toHaveBeenCalledTimes(2);
    const xs = mockDb.upsertTransactionValues.mock.calls.map((c) => c[2].energieEntry.x);
    expect(xs).toEqual([Date.parse(T1) / 1000, Date.parse(T2) / 1000]);
    // L'énergie courante retenue est la dernière du lot
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith(1, 42, null, 2100);
  });

  it('énergie sur le connecteur 0 : compteur de la borne', () => {
    client._handlers['MeterValues']({
      connectorId: 0,
      meterValue: [{ timestamp: T1, sampledValue: [{ value: '9000' }] }],
    });
    expect(mockDb.updateChargepointMeterValue).toHaveBeenCalledWith(1, 9000);
    expect(mockDb.updateConnectorMeterValue).not.toHaveBeenCalled();
  });
});

describe('ocpp-server-16 — conformité (lot B) : divers', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 1, site_id: 1 });
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getTransactions.mockReturnValue([]);
    register16Handlers(client, makeLoggedHandle(client));
  });

  it("'StrongRiderFailure' (absent de l'énumération 1.6) est ramené à OtherError", () => {
    client._handlers['StatusNotification']({
      connectorId: 1, status: 'Faulted', errorCode: 'StrongRiderFailure',
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 1, 'Faulted', 'OtherError', null, null, null, null, 'Faulted'
    );
  });

  it.each([[undefined], [{ value: 'abc' }], [{ value: '' }]])(
    'BootNotification : interval jamais NaN (config %p)',
    (cfg) => {
      mockDb.getInitialChargepointConfigByKey.mockReturnValueOnce(cfg);
      const res = client._handlers['BootNotification']({
        chargePointVendor: 'V', chargePointModel: 'M',
      });
      expect(res.interval).toBe(300);
    }
  );

  it('Authorize : expiryDate est un date-time complet même si la date stockée est une date seule', () => {
    mockDb.authorizeIdTag.mockReturnValue({
      status: 'Accepted',
      tag: { expiry_date: '2099-12-31' },
    });
    const res = client._handlers['Authorize']({ idTag: 'TAG1' });
    expect(res.idTagInfo.expiryDate).toBe('2099-12-31T00:00:00Z');
  });
});

// ── Lot E : autorisation (H3 / M1 / M9) ──
describe('ocpp-server-16 — lot E autorisation', () => {
  let client;
  const ts = () => new Date().toISOString();

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 1, site_id: 1 });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getIdTagByTag.mockReturnValue(null);
    mockDb.getTransactions.mockReturnValue([]);
    mockDb.createTransaction.mockReturnValue({ transaction_id: 300 });
    register16Handlers(client, makeLoggedHandle(client));
  });

  describe('H3 — Authorize d’un badge généré (AuthorizeRemoteTxRequests=true)', () => {
    it('accepté si un démarrage à distance avec ce badge est en attente sur cette borne', () => {
      mockPendingRemoteStarts.set('CP001_1', { source: 'web', userId: null, idTag: 'ADMIN' });
      const result = client._handlers['Authorize']({ idTag: 'ADMIN' });
      expect(result.idTagInfo.status).toBe('Accepted');
      expect(mockDb.addIdTagEvent).not.toHaveBeenCalled();
      // L'attente n'est pas consommée : le StartTransaction qui suit en a besoin
      expect(mockPendingRemoteStarts.has('CP001_1')).toBe(true);
    });

    it('bloqué sans démarrage à distance en attente', () => {
      const result = client._handlers['Authorize']({ idTag: 'ADMIN' });
      expect(result.idTagInfo.status).toBe('Blocked');
    });

    it('bloqué si l’attente concerne un autre badge ou une autre borne', () => {
      mockPendingRemoteStarts.set('CP001_1', { source: 'web', idTag: 'MGR-1' });
      mockPendingRemoteStarts.set('CP002_1', { source: 'web', idTag: 'ADMIN' });
      expect(client._handlers['Authorize']({ idTag: 'ADMIN' }).idTagInfo.status).toBe('Blocked');
    });
  });

  describe('M9 — démarrage à distance en attente', () => {
    it('un AUTRE badge présenté sur le connecteur pendant l’attente reste contrôlé', () => {
      mockPendingRemoteStarts.set('CP001_1', { source: 'web', userId: 5, idTag: 'WEB-5' });
      mockDb.authorizeIdTag.mockReturnValue({ status: 'Blocked', reason: 'inactive_tag' });
      const result = client._handlers['StartTransaction']({
        connectorId: 1,
        idTag: 'STOLEN-BADGE',
        meterStart: 0,
        timestamp: ts(),
      });
      expect(mockDb.authorizeIdTag).toHaveBeenCalledWith('STOLEN-BADGE', 1);
      expect(result.idTagInfo.status).toBe('Blocked');
      // L'attente du vrai démarrage à distance n'est pas consommée
      expect(mockPendingRemoteStarts.has('CP001_1')).toBe(true);
    });

    it('le badge du démarrage à distance démarre sans contrôle, avec la source mémorisée', () => {
      mockPendingRemoteStarts.set('CP001_1', { source: 'web', userId: 5, idTag: 'WEB-5' });
      const result = client._handlers['StartTransaction']({
        connectorId: 1,
        idTag: 'WEB-5',
        meterStart: 0,
        timestamp: ts(),
      });
      expect(result.idTagInfo.status).toBe('Accepted');
      expect(mockDb.authorizeIdTag).not.toHaveBeenCalled();
      expect(mockDb.createTransaction.mock.calls[0][5]).toBe('web');
      expect(mockPendingRemoteStarts.has('CP001_1')).toBe(false);
    });
  });

  describe('M1 — idTagInfo de StopTransaction.conf', () => {
    const stop = (idTag, txIdTag = 'TAG001') => {
      mockDb.getTransactionByTransactionId.mockReturnValue({
        transaction_id: '42',
        status: 'Active',
        id_tag: txIdTag,
        meter_start: 0,
      });
      mockDb.stopTransaction.mockReturnValue({ tx: null, closed: false });
      return client._handlers['StopTransaction']({
        transactionId: 42,
        meterStop: 100,
        timestamp: ts(),
        ...(idTag !== undefined ? { idTag } : {}),
      });
    };

    it('badge bloqué : Blocked (la borne ne doit pas le garder Accepted en cache)', () => {
      mockDb.authorizeIdTag.mockReturnValue({ status: 'Blocked', tag: { expiry_date: null } });
      expect(stop('TAG-BLOCKED').idTagInfo).toEqual({ status: 'Blocked' });
    });

    it('badge inconnu : Invalid', () => {
      mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid', tag: null });
      expect(stop('UNKNOWN').idTagInfo).toEqual({ status: 'Invalid' });
    });

    it('badge valide : Accepted avec expiryDate quand le badge expire', () => {
      mockDb.authorizeIdTag.mockReturnValue({
        status: 'Accepted',
        tag: { expiry_date: '2030-01-01T00:00:00Z' },
      });
      expect(stop('TAG001').idTagInfo).toEqual({
        status: 'Accepted',
        expiryDate: '2030-01-01T00:00:00Z',
      });
    });

    it('sans idTag : idTagInfo omis', () => {
      expect(stop(undefined)).toEqual({});
      expect(mockDb.authorizeIdTag).not.toHaveBeenCalled();
    });

    it('badge généré : Accepted pour sa propre transaction, Blocked sinon', () => {
      expect(stop('WEB-5', 'WEB-5').idTagInfo).toEqual({ status: 'Accepted' });
      expect(stop('WEB-5', 'TAG001').idTagInfo).toEqual({ status: 'Blocked' });
    });

    it('mode libre (3) : Accepted', () => {
      mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 3, site_id: 1 });
      expect(stop('ANY').idTagInfo).toEqual({ status: 'Accepted' });
    });
  });
});

// ── Lot 2 : borne sans site = inactive, quel que soit son mode ──
describe('ocpp-server-16 — borne sans site (inactive)', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.createTransaction.mockReturnValue({ transaction_id: 200 });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getIdTagByTag.mockReturnValue(null);
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Blocked', reason: 'chargepoint_no_site', tag: null });
    register16Handlers(client, makeLoggedHandle(client));
  });

  it('Authorize : mode libre refusé sans site', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 3, site_id: null });
    const result = client._handlers['Authorize']({ idTag: 'ANY001' });
    expect(result.idTagInfo.status).toBe('Blocked');
  });

  it.each([1, 3])('StartTransaction mode %i : session enregistrée refusée (jamais facturée)', (mode) => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode, site_id: null });
    client._handlers['StartTransaction']({ connectorId: 1, idTag: 'ANY001', meterStart: 0, timestamp: new Date().toISOString() });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      1, 1, 'ANY001', 0, expect.any(String), expect.any(String),
      expect.objectContaining({ status: 'Rejected' })
    );
    expect(mockDb.addIdTagEvent).toHaveBeenCalledWith(1, null, 'ANY001', 'Blocked', 'chargepoint_no_site', 'authorize');
  });

  it('StartTransaction : un démarrage à distance en attente ne passe pas non plus', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 1, site_id: null });
    mockPendingRemoteStarts.set('CP001_1', { source: 'web', userId: 5, idTag: 'WEB-5' });
    client._handlers['StartTransaction']({ connectorId: 1, idTag: 'WEB-5', meterStart: 0, timestamp: new Date().toISOString() });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      1, 1, 'WEB-5', 0, expect.any(String), 'web',
      expect.objectContaining({ status: 'Rejected' })
    );
  });

  it('Plug & Charge (mode 2) : aucun démarrage ni badge MGR-null sans site', () => {
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 2, site_id: null, cpstatus: 'Available' });
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Preparing', errorCode: 'NoError' });
    expect(mockDb.createIdTag).not.toHaveBeenCalled();
    expect(mockPendingRemoteStarts.size).toBe(0);
  });

  it('Plug & Charge (mode 2) : démarrage normal avec un site (témoin)', () => {
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 2, site_id: 7, cpstatus: 'Available' });
    client._handlers['StatusNotification']({ connectorId: 1, status: 'Preparing', errorCode: 'NoError' });
    expect(mockPendingRemoteStarts.size).toBe(1);
    expect([...mockPendingRemoteStarts.values()][0].idTag).toBe('MGR-7');
  });

  it('StopTransaction.conf : mode libre sans site → pas « Accepted » d’office', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 3, site_id: null });
    mockDb.stopTransaction.mockReturnValue({ tx: { id: 9, transaction_id: 200 }, closed: true });
    mockDb.getTransactionByTransactionId.mockReturnValue({ id: 9, transaction_id: 200, status: 'Active', id_tag: 'ANY001' });
    const result = client._handlers['StopTransaction']({ transactionId: 200, idTag: 'ANY001', meterStop: 100, timestamp: new Date().toISOString() });
    expect(result.idTagInfo.status).toBe('Blocked');
  });
});
