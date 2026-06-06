'use strict';

const mockDb = {
  getChargepointByIdentity: jest.fn(),
  getChargepointById: jest.fn(),
  upsertChargepoint: jest.fn(),
  addOcppMessage: jest.fn(),
  createTransaction: jest.fn(),
  stopTransaction: jest.fn(),
  getTransactions: jest.fn(() => []),
  getTransactionByTransactionId: jest.fn(),
  getActiveTransactionByConnector: jest.fn(),
  updateChargepointStatus: jest.fn(),
  upsertConnector: jest.fn(),
  upsertEvse: jest.fn(),
  getConnectorByChargepointAndId: jest.fn(),
  getConnectorsByChargepoint: jest.fn(() => []),
  authorizeIdTag: jest.fn(),
  addIdTagEvent: jest.fn(),
  getIdTagByTag: jest.fn(),
  updateConnectorMeterValue: jest.fn(),
  updateChargepointMeterValue: jest.fn(),
  updateTransactionPowerEnergy: jest.fn(),
  upsertTransactionValues: jest.fn(),
  updateTransactionChargingState: jest.fn(),
  getInitialChargepointConfigByKey: jest.fn(() => ({ value: '300' })),
  getInitialChargepointVariableByKey: jest.fn(() => ({ value: '300' })),
  getEnabledInitialChargepointVariables: jest.fn(() => []),
  getChargingProfiles: jest.fn(() => []),
  markChargepointInitialized: jest.fn(),
  upsertChargepointVariable: jest.fn(),
  updateChargepointFeatures201: jest.fn(),
  activateReservationByConnector: jest.fn(),
  expireActiveReservationByConnector: jest.fn(),
  fulfillInUseReservationByConnector: jest.fn(),
  startUsingReservationByConnectorAndIdTag: jest.fn(() => 0),
  getReservationByOcppId: jest.fn(),
  fulfillReservationByConnectorAndIdTag: jest.fn(() => 0),
  updateReservationStatus: jest.fn(),
  insertErrorEvent: jest.fn(),
  updateConnectorCnstatus: jest.fn(),
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
const mockBroadcast = jest.fn();
const mockTrackRepeatedAuthReject = jest.fn();
const mockDebounceAvailabilityNotif = jest.fn((identity, connectorId, fn) => fn());

jest.mock('../../src/ocpp-common', () => ({
  broadcast: mockBroadcast,
  getConnectedClients: jest.fn(() => mockConnectedClients),
  trackRepeatedAuthReject: mockTrackRepeatedAuthReject,
  registerCallClientImpl: jest.fn(),
  registerHandlersFn: jest.fn(),
  debounceAvailabilityNotif: mockDebounceAvailabilityNotif,
}));

const { callClient201, register201Handlers } = require('../../src/ocpp-server-201');

function makeLoggedHandle(client) {
  return function loggedHandle(action, handler) {
    client._handlers[action] = handler;
  };
}

function makeClient(identity) {
  return {
    identity,
    protocol: 'ocpp2.0.1',
    call: jest.fn().mockResolvedValue({}),
    handle: jest.fn(),
    once: jest.fn(),
    _handlers: {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnectedClients.clear();
});

// ── callClient201 ──
describe('ocpp-server-201 — callClient201', () => {
  it('throws when chargepoint not connected', async () => {
    await expect(callClient201('UNKNOWN', 'Reset', {})).rejects.toThrow('not connected');
  });

  it('calls the client and returns result', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({ status: 'Accepted' }) };
    mockConnectedClients.set('CP001', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });

    const result = await callClient201('CP001', 'Reset', { type: 'Soft' });
    expect(result).toEqual({ status: 'Accepted' });
    expect(mockClient.call).toHaveBeenCalledWith('Reset', { type: 'Soft' });
  });

  it('broadcasts outbound CALL and inbound CALLRESULT', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({ status: 'Accepted' }) };
    mockConnectedClients.set('CP001', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1 });

    await callClient201('CP001', 'Reset', { type: 'Soft' });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'ocpp_message',
      expect.objectContaining({ message_type: 'CALL' }),
      null
    );
    expect(mockBroadcast).toHaveBeenCalledWith(
      'ocpp_message',
      expect.objectContaining({ message_type: 'CALLRESULT' }),
      null
    );
  });

  it('works when cp is null (no DB record)', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({}) };
    mockConnectedClients.set('CP002', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue(null);

    await expect(callClient201('CP002', 'Reset', {})).resolves.toEqual({});
  });

  it('broadcasts CALLERROR and rethrows on client.call error', async () => {
    const mockClient = { call: jest.fn().mockRejectedValue(new Error('timeout')) };
    mockConnectedClients.set('CP003', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 3 });

    await expect(callClient201('CP003', 'Reset', {})).rejects.toThrow('timeout');
    expect(mockBroadcast).toHaveBeenCalledWith(
      'ocpp_message',
      expect.objectContaining({ message_type: 'CALLERROR' }),
      null
    );
  });
});

// ── BootNotification ──
describe('ocpp-server-201 — BootNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('registers the handler', () => {
    expect(client._handlers['BootNotification']).toBeDefined();
  });

  it('returns Accepted with heartbeat interval and currentTime', () => {
    const result = client._handlers['BootNotification']({
      chargingStation: { vendorName: 'ABB', model: 'Terra DC' },
    });
    expect(result.status).toBe('Accepted');
    expect(result.interval).toBe(300);
    expect(result.currentTime).toBeDefined();
  });

  it('maps chargingStation fields to upsertChargepoint', () => {
    client._handlers['BootNotification']({
      chargingStation: {
        vendorName: 'ABB',
        model: 'Terra',
        serialNumber: 'SN123',
        firmwareVersion: '1.0.0',
        modem: { iccid: '12345', imsi: '67890' },
      },
    });
    expect(mockDb.upsertChargepoint).toHaveBeenCalledWith(
      'CP001',
      expect.objectContaining({
        vendor: 'ABB',
        model: 'Terra',
        serial_number: 'SN123',
        firmware_version: '1.0.0',
        iccid: '12345',
        imsi: '67890',
      })
    );
  });

  it('sanitizes vendor/model fields (strips XSS and truncates)', () => {
    client._handlers['BootNotification']({
      chargingStation: {
        vendorName: '<script>alert(1)</script>',
        model: 'M' + 'X'.repeat(80),
      },
    });
    expect(mockDb.upsertChargepoint).toHaveBeenCalledWith(
      'CP001',
      expect.objectContaining({
        vendor: 'scriptalert(1)/script',
        model: 'M' + 'X'.repeat(19),
      })
    );
  });

  it('broadcasts chargepoint_update after upsert', () => {
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'chargepoint_update',
      expect.any(Object),
      expect.anything()
    );
  });

  it('uses default 300s interval when variable not found', () => {
    mockDb.getInitialChargepointVariableByKey.mockReturnValue(null);
    const result = client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    expect(result.interval).toBe(300);
  });
});

// ── Heartbeat ──
describe('ocpp-server-201 — Heartbeat', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1,
      site_id: 1,
      last_heartbeat: new Date().toISOString(),
    });
    register201Handlers(client, makeLoggedHandle(client));
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
    expect(mockBroadcast).toHaveBeenCalledWith(
      'chargepoint_heartbeat',
      expect.any(Object),
      expect.anything()
    );
  });
});

// ── Authorize ──
describe('ocpp-server-201 — Authorize', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 1, site_id: 1 });
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Accepted', tag: null });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('returns idTokenInfo.status Accepted for valid tag', () => {
    const result = client._handlers['Authorize']({
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
    });
    expect(result.idTokenInfo.status).toBe('Accepted');
  });

  it('reads idToken from idToken.idToken (not flat idTag)', () => {
    client._handlers['Authorize']({ idToken: { idToken: 'TAG002', type: 'ISO14443' } });
    expect(mockDb.authorizeIdTag).toHaveBeenCalledWith('TAG002', 1, 'ISO14443');
  });

  it('passes token type to authorizeIdTag for type validation', () => {
    client._handlers['Authorize']({ idToken: { idToken: 'TAG003', type: 'KeyCode' } });
    expect(mockDb.authorizeIdTag).toHaveBeenCalledWith('TAG003', 1, 'KeyCode');
  });

  it('passes null token type when idToken has no type field', () => {
    client._handlers['Authorize']({ idToken: { idToken: 'TAG004' } });
    expect(mockDb.authorizeIdTag).toHaveBeenCalledWith('TAG004', 1, null);
  });

  it('returns Invalid when token type mismatches stored type', () => {
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid', reason: 'type_mismatch', tag: {} });
    const result = client._handlers['Authorize']({ idToken: { idToken: 'TAG005', type: 'KeyCode' } });
    expect(result.idTokenInfo.status).toBe('Invalid');
  });

  it('returns idTokenInfo.status Invalid for unknown tag and tracks rejection', () => {
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid', reason: 'unknown', tag: null });
    const result = client._handlers['Authorize']({
      idToken: { idToken: 'BAD', type: 'ISO14443' },
    });
    expect(result.idTokenInfo.status).toBe('Invalid');
    expect(mockTrackRepeatedAuthReject).toHaveBeenCalledWith('BAD', 'CP001', expect.any(Object));
  });

  it('always accepts in mode 3 (free charging)', () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 3, site_id: 1 });
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Invalid' });
    const result = client._handlers['Authorize']({
      idToken: { idToken: 'ANY', type: 'ISO14443' },
    });
    expect(result.idTokenInfo.status).toBe('Accepted');
  });

  it.each(['WEB-5', 'ADMIN', 'MGR-3'])(
    'blocks auto-tag prefix "%s" (clone protection)',
    (idTag) => {
      const result = client._handlers['Authorize']({ idToken: { idToken: idTag, type: 'ISO14443' } });
      expect(result.idTokenInfo.status).toBe('Blocked');
      expect(mockDb.authorizeIdTag).not.toHaveBeenCalled();
      expect(mockDb.addIdTagEvent).toHaveBeenCalledWith(
        1, null, idTag, 'Blocked', 'auto_tag_rfid', 'authorize'
      );
    }
  );
});

// ── StatusNotification ──
describe('ocpp-server-201 — StatusNotification', () => {
  let client;
  const TS = new Date().toISOString();

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    mockDb.getConnectorByChargepointAndId.mockReturnValue(null);
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getTransactions.mockReturnValue([]);
    mockDb.getActiveTransactionByConnector.mockReturnValue(null);
    mockDb.startUsingReservationByConnectorAndIdTag.mockReturnValue(0);
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('evseId=0 updates chargepoint status and does not touch connectors', () => {
    client._handlers['StatusNotification']({
      evseId: 0,
      connectorId: 0,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(mockDb.updateChargepointStatus).toHaveBeenCalledWith('CP001', 'Available', true);
    expect(mockDb.upsertConnector).not.toHaveBeenCalled();
  });

  it('maps Occupied → cnstatus=Preparing + cnstatus_raw=Occupied', () => {
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Occupied',
      timestamp: TS,
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 1, 'Preparing', 'NoError', null, null, null, 1, 'Occupied'
    );
  });

  it('maps Available → cnstatus=Available', () => {
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 1, 'Available', 'NoError', null, null, null, 1, 'Available'
    );
  });

  it('calls upsertEvse with evseId and mapped cnstatus', () => {
    client._handlers['StatusNotification']({
      evseId: 2,
      connectorId: 1,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(mockDb.upsertEvse).toHaveBeenCalledWith(1, 2, 'Available');
    // connector_id en DB doit être params.connectorId (1), pas evseId (2)
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 1, 'Available', 'NoError', null, null, null, 2, 'Available'
    );
  });

  it('EVSE1-Connector2 et EVSE2-Connector1 appellent upsertConnector avec le bon connectorId', () => {
    jest.clearAllMocks();
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 2,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 2, 'Available', 'NoError', null, null, null, 1, 'Available'
    );

    jest.clearAllMocks();
    client._handlers['StatusNotification']({
      evseId: 2,
      connectorId: 1,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 1, 'Available', 'NoError', null, null, null, 2, 'Available'
    );
  });

  it('activates reservation and broadcasts when status is Reserved', () => {
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Reserved',
      timestamp: TS,
    });
    expect(mockDb.activateReservationByConnector).toHaveBeenCalledWith(1, 1);
    expect(mockBroadcast).toHaveBeenCalledWith(
      'reservation_updated',
      { chargepoint_id: 1 },
      expect.anything()
    );
  });

  it('calls debounceAvailabilityNotif when transitioning from Unavailable to Available', () => {
    mockDb.getConnectorByChargepointAndId.mockReturnValue({ cnstatus: 'Unavailable' });
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(mockDebounceAvailabilityNotif).toHaveBeenCalledWith('CP001', 1, expect.any(Function));
  });

  it('inserts error event for Faulted status', () => {
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Faulted',
      timestamp: TS,
    });
    expect(mockDb.insertErrorEvent).toHaveBeenCalledWith(
      1,
      'status_error',
      expect.objectContaining({ ocpp_version: '2.0.1', evse_id: 1 })
    );
    expect(mockBroadcast).toHaveBeenCalledWith('error_event', { chargepoint_id: 1 }, expect.anything());
  });

  it('closes orphan transaction when connector becomes Available', () => {
    mockDb.getTransactions.mockReturnValue([
      { transaction_id: 'TX-OLD', connector_id: 1, meter_start: 500 },
    ]);
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith('TX-OLD', 500, TS, 'EVDisconnected');
  });

  it('returns empty object', () => {
    const result = client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Available',
      timestamp: TS,
    });
    expect(result).toEqual({});
  });

  it('preserves Charging when StatusNotification(Occupied) fires during active Charging transaction', () => {
    mockDb.getActiveTransactionByConnector.mockReturnValueOnce({
      transaction_id: 'TX-001',
      charging_state: 'Charging',
    });
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Occupied',
      timestamp: TS,
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 1, 'Charging', 'NoError', null, null, null, 1, 'Occupied'
    );
    expect(mockBroadcast).toHaveBeenCalledWith('status_update', expect.any(Object), expect.anything());
  });

  it('uses Preparing when StatusNotification(Occupied) fires with no active transaction', () => {
    mockDb.getActiveTransactionByConnector.mockReturnValueOnce(null);
    client._handlers['StatusNotification']({
      evseId: 1,
      connectorId: 1,
      connectorStatus: 'Occupied',
      timestamp: TS,
    });
    expect(mockDb.upsertConnector).toHaveBeenCalledWith(
      1, 1, 'Preparing', 'NoError', null, null, null, 1, 'Occupied'
    );
  });
});

// ── TransactionEvent Started ──
describe('ocpp-server-201 — TransactionEvent Started', () => {
  let client;
  const TS = new Date().toISOString();

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, mode: 1, site_id: 1 });
    mockDb.authorizeIdTag.mockReturnValue({ status: 'Accepted' });
    mockDb.createTransaction.mockReturnValue({ transaction_id: 'TX-ABC' });
    mockDb.getTransactions.mockReturnValue([]);
    mockDb.getIdTagByTag.mockReturnValue(null);
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('creates a transaction and returns idTokenInfo Accepted', () => {
    const result = client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-001' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(result.idTokenInfo.status).toBe('Accepted');
    expect(mockDb.createTransaction).toHaveBeenCalled();
  });

  it('maps triggerReason Authorized → start_source rfid', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-002' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      'rfid',
      expect.any(Object)
    );
  });

  it('maps triggerReason RemoteStart → start_source remote', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'RemoteStart',
      transactionInfo: { transactionId: 'TX-003' },
      idToken: { idToken: 'WEB-1', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      'remote',
      expect.any(Object)
    );
  });

  it('maps triggerReason CablePluggedIn → start_source local', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'CablePluggedIn',
      transactionInfo: { transactionId: 'TX-004' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      'local',
      expect.any(Object)
    );
  });

  it('passes transactionId as string (not Number)', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-STRING-001' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.anything(),
      expect.objectContaining({ transactionId: 'TX-STRING-001' })
    );
  });

  it('creates transaction with evse_id and charging_state=EVConnected when absent', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-005' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 2 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.anything(),
      expect.objectContaining({ evse_id: 2, charging_state: 'EVConnected' })
    );
  });

  it('creates transaction with charging_state from message when provided', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-006', chargingState: 'Charging' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 2 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.createTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.anything(),
      expect.objectContaining({ evse_id: 2, charging_state: 'Charging' })
    );
  });

  it('closes orphan active transaction on same connector before creating new one', () => {
    mockDb.getTransactions.mockReturnValue([
      { transaction_id: 'TX-OLD', connector_id: 1 },
    ]);
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-NEW' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith('TX-OLD', null, TS, 'Other');
    expect(mockDb.createTransaction).toHaveBeenCalled();
  });

  it('does not close active transaction on a different connector', () => {
    mockDb.getTransactions.mockReturnValue([
      { transaction_id: 'TX-OTHER', connector_id: 2 },
    ]);
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-NEW' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).not.toHaveBeenCalled();
    expect(mockDb.createTransaction).toHaveBeenCalled();
  });

  it('blocks auto-tag prefix in mode 1 rfid (StartTransaction defense)', () => {
    const result = client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-BLOCK' },
      idToken: { idToken: 'WEB-5', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(result.idTokenInfo.status).toBe('Blocked');
    expect(mockDb.createTransaction).not.toHaveBeenCalled();
  });

  it('does not block auto-tag when source is remote (RemoteStart flow)', () => {
    mockDb.createTransaction.mockReturnValue({ transaction_id: 'TX-WEB' });
    const result = client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'RemoteStart',
      transactionInfo: { transactionId: 'TX-WEB' },
      idToken: { idToken: 'WEB-5', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(result.idTokenInfo.status).toBe('Accepted');
    expect(mockDb.createTransaction).toHaveBeenCalled();
  });

  it('broadcasts transaction_start', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-BCAST' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'transaction_start',
      expect.any(Object),
      expect.anything()
    );
  });

  it('calls updateConnectorMeterValue when meterStart > 0', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-METER' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [{
        timestamp: TS,
        sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '5000', unitOfMeasure: { unit: 'Wh' } }],
      }],
      timestamp: TS,
    });
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 5000);
  });

  it('does not call updateConnectorMeterValue when meterStart === 0', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-NOMTR' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.updateConnectorMeterValue).not.toHaveBeenCalled();
  });

  it('broadcasts status_update even when chargingState absent (fallback EVConnected→Preparing)', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-SU1' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockBroadcast).toHaveBeenCalledWith('status_update', expect.any(Object), expect.anything());
    expect(mockDb.updateConnectorCnstatus).toHaveBeenCalledWith(1, 1, 1, 'Preparing');
  });

  it('broadcasts status_update with Charging when chargingState is Charging', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-SU2', chargingState: 'Charging' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockBroadcast).toHaveBeenCalledWith('status_update', expect.any(Object), expect.anything());
    expect(mockDb.updateConnectorCnstatus).toHaveBeenCalledWith(1, 1, 1, 'Charging');
  });

  it('broadcasts status_update even when evseId is null (skips DB update, still broadcasts)', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Started',
      triggerReason: 'Authorized',
      transactionInfo: { transactionId: 'TX-SU3' },
      idToken: { idToken: 'TAG001', type: 'ISO14443' },
      // pas d'evse
      meterValue: [],
      timestamp: TS,
    });
    expect(mockBroadcast).toHaveBeenCalledWith('status_update', expect.any(Object), expect.anything());
    expect(mockDb.updateConnectorCnstatus).not.toHaveBeenCalled();
  });
});

// ── TransactionEvent Updated ──
describe('ocpp-server-201 — TransactionEvent Updated', () => {
  let client;
  const TS = new Date().toISOString();

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    mockDb.getTransactionByTransactionId.mockReturnValue({
      transaction_id: 'TX-001',
      status: 'Active',
      meter_start: 0,
      connector_id: 1,
    });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('returns empty object', () => {
    const result = client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001' },
      meterValue: [],
      timestamp: TS,
    });
    expect(result).toEqual({});
  });

  it('calls updateTransactionChargingState when chargingState present', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001', chargingState: 'SuspendedEV' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.updateTransactionChargingState).toHaveBeenCalledWith('TX-001', 'SuspendedEV');
  });

  it('broadcasts transaction_updated', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'transaction_updated',
      expect.any(Object),
      expect.anything()
    );
  });

  it('processes Energy.Active.Import.Register in Wh from unitOfMeasure', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001' },
      meterValue: [{
        timestamp: TS,
        sampledValue: [{
          measurand: 'Energy.Active.Import.Register',
          value: '5000',
          unitOfMeasure: { unit: 'Wh' },
        }],
      }],
      timestamp: TS,
    });
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith('TX-001', null, 5000);
  });

  it('processes Power.Active.Import in W from unitOfMeasure', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001' },
      meterValue: [{
        timestamp: TS,
        sampledValue: [{
          measurand: 'Power.Active.Import',
          value: '7400',
          unitOfMeasure: { unit: 'W' },
        }],
      }],
      timestamp: TS,
    });
    expect(mockDb.updateTransactionPowerEnergy).toHaveBeenCalledWith('TX-001', 7400, null);
  });

  it('returns early without crash when tx not found', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    expect(() => {
      client._handlers['TransactionEvent']({
        eventType: 'Updated',
        transactionInfo: { transactionId: 'TX-UNKNOWN' },
        meterValue: [],
        timestamp: TS,
      });
    }).not.toThrow();
  });

  it('broadcasts status_update with Preparing fallback for unknown chargingState', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001', chargingState: 'UnknownFutureState' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.updateConnectorCnstatus).toHaveBeenCalledWith(1, 1, 1, 'Preparing');
    expect(mockBroadcast).toHaveBeenCalledWith('status_update', expect.any(Object), expect.anything());
  });

  it('broadcasts meter_values when meterValue array is not empty', () => {
    const mv = [{
      timestamp: TS,
      sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '1000', unitOfMeasure: { unit: 'Wh' } }],
    }];
    client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001' },
      evse: { id: 1 },
      meterValue: mv,
      timestamp: TS,
    });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'meter_values',
      expect.objectContaining({ identity: 'CP001', connectorId: 1 }),
      expect.anything()
    );
  });

  it('does not broadcast meter_values when meterValue array is empty', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Updated',
      transactionInfo: { transactionId: 'TX-001' },
      evse: { id: 1 },
      meterValue: [],
      timestamp: TS,
    });
    const meterValuesBroadcasts = mockBroadcast.mock.calls.filter(c => c[0] === 'meter_values');
    expect(meterValuesBroadcasts).toHaveLength(0);
  });
});

// ── TransactionEvent Ended ──
describe('ocpp-server-201 — TransactionEvent Ended', () => {
  let client;
  const TS = new Date().toISOString();

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('calls stopTransaction', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Local',
      transactionInfo: { transactionId: 'TX-001' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith('TX-001', null, TS, 'Local');
  });

  it('maps triggerReason EVDisconnected → stop_reason EVDisconnected', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'EVDisconnected',
      transactionInfo: { transactionId: 'TX-002' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith('TX-002', null, TS, 'EVDisconnected');
  });

  it('maps triggerReason Deauthorized → stop_reason DeAuthorized', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Deauthorized',
      transactionInfo: { transactionId: 'TX-003' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith('TX-003', null, TS, 'DeAuthorized');
  });

  it('maps triggerReason ImmediateReset → stop_reason HardReset', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'ImmediateReset',
      transactionInfo: { transactionId: 'TX-RESET' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith('TX-RESET', null, TS, 'HardReset');
  });

  it('broadcasts transaction_stop when transaction exists', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({
      transaction_id: 'TX-004',
      chargepoint_id: 1,
      connector_id: 1,
      id_tag: null,
      meter_start: 0,
      meter_stop: null,
      start_time: TS,
      stop_time: TS,
    });
    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Local',
      transactionInfo: { transactionId: 'TX-004' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'transaction_stop',
      expect.any(Object),
      expect.anything()
    );
  });

  it('does not broadcast transaction_stop when transaction not found (idToken invalide)', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue(null);
    mockDb.getTransactions.mockReturnValue([]);
    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Deauthorized',
      transactionInfo: { transactionId: 'TX-INVALID' },
      meterValue: [],
      timestamp: TS,
    });
    expect(mockBroadcast).not.toHaveBeenCalledWith('transaction_stop', expect.any(Object), expect.anything());
  });

  it('emits site and user notifications when transaction found with valid tag', () => {
    const start = new Date(Date.now() - 3600000).toISOString();
    mockDb.getTransactionByTransactionId.mockReturnValue({
      transaction_id: 'TX-005',
      chargepoint_id: 1,
      connector_id: 1,
      id_tag: 'TAG001',
      meter_start: 0,
      meter_stop: 5000,
      start_time: start,
      stop_time: TS,
    });
    mockDb.getChargepointById.mockReturnValue({
      id: 1,
      site_id: 1,
      cpname: 'TestCP',
      site_name: 'Site1',
    });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.getIdTagByTag.mockReturnValue({ user_id: 99 });

    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Local',
      transactionInfo: { transactionId: 'TX-005' },
      meterValue: [],
      timestamp: TS,
    });

    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'site_transaction_stopped',
      expect.objectContaining({ energy_kwh: '5.00' }),
      expect.any(Object)
    );
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'transaction_stopped',
      expect.objectContaining({ transaction_id: 'TX-005' }),
      expect.objectContaining({ userId: 99 })
    );
  });

  it('calls fulfillReservationByConnectorAndIdTag when transaction found', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({
      transaction_id: 'TX-006',
      chargepoint_id: 1,
      connector_id: 1,
      id_tag: 'TAG001',
      meter_start: 0,
      meter_stop: null,
      start_time: new Date(Date.now() - 60000).toISOString(),
      stop_time: TS,
    });
    mockDb.getChargepointById.mockReturnValue({ id: 1, site_id: 1, cpname: 'CP', site_name: 'S' });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.fulfillReservationByConnectorAndIdTag.mockReturnValue(1);

    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Local',
      transactionInfo: { transactionId: 'TX-006' },
      meterValue: [],
      timestamp: TS,
    });

    expect(mockDb.fulfillReservationByConnectorAndIdTag).toHaveBeenCalledWith(1, 1, 'TAG001');
    expect(mockBroadcast).toHaveBeenCalledWith(
      'reservation_updated',
      { chargepoint_id: 1 },
      expect.anything()
    );
  });

  it('does not broadcast reservation_updated when no InUse reservation matched', () => {
    mockDb.getTransactionByTransactionId.mockReturnValue({
      transaction_id: 'TX-007',
      chargepoint_id: 1,
      connector_id: 1,
      id_tag: 'TAG001',
      meter_start: 0,
      meter_stop: null,
      start_time: new Date(Date.now() - 60000).toISOString(),
      stop_time: TS,
    });
    mockDb.getChargepointById.mockReturnValue({ id: 1, site_id: 1, cpname: 'CP', site_name: 'S' });
    mockDb.getConnectorsByChargepoint.mockReturnValue([]);
    mockDb.fulfillReservationByConnectorAndIdTag.mockReturnValue(0);

    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Local',
      transactionInfo: { transactionId: 'TX-007' },
      meterValue: [],
      timestamp: TS,
    });

    const reservationBroadcasts = mockBroadcast.mock.calls.filter(
      (c) => c[0] === 'reservation_updated'
    );
    expect(reservationBroadcasts).toHaveLength(0);
  });

  it('extracts meterStop from meterValue Energy.Active.Import.Register', () => {
    client._handlers['TransactionEvent']({
      eventType: 'Ended',
      triggerReason: 'Local',
      transactionInfo: { transactionId: 'TX-ENERGY' },
      meterValue: [{
        timestamp: TS,
        sampledValue: [{
          measurand: 'Energy.Active.Import.Register',
          value: '12500',
          unitOfMeasure: { unit: 'Wh' },
        }],
      }],
      timestamp: TS,
    });
    expect(mockDb.stopTransaction).toHaveBeenCalledWith('TX-ENERGY', 12500, TS, 'Local');
  });
});

// ── MeterValues (hors-transaction) ──
describe('ocpp-server-201 — MeterValues', () => {
  let client;
  const TS = new Date().toISOString();

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('returns empty object', () => {
    const result = client._handlers['MeterValues']({ evseId: 1, meterValue: [] });
    expect(result).toEqual({});
  });

  it('updates connector meter value when evseId > 0 and energyWh present', () => {
    client._handlers['MeterValues']({
      evseId: 1,
      meterValue: [{
        timestamp: TS,
        sampledValue: [{
          measurand: 'Energy.Active.Import.Register',
          value: '3000',
          unitOfMeasure: { unit: 'Wh' },
        }],
      }],
    });
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 3000);
  });

  it('converts kWh to Wh', () => {
    client._handlers['MeterValues']({
      evseId: 1,
      meterValue: [{
        timestamp: TS,
        sampledValue: [{
          measurand: 'Energy.Active.Import.Register',
          value: '3.5',
          unitOfMeasure: { unit: 'kWh' },
        }],
      }],
    });
    expect(mockDb.updateConnectorMeterValue).toHaveBeenCalledWith(1, 1, 3500);
  });

  it('updates chargepoint meter when evseId=0', () => {
    client._handlers['MeterValues']({
      evseId: 0,
      meterValue: [{
        timestamp: TS,
        sampledValue: [{
          measurand: 'Energy.Active.Import.Register',
          value: '7500',
          unitOfMeasure: { unit: 'Wh' },
        }],
      }],
    });
    expect(mockDb.updateChargepointMeterValue).toHaveBeenCalledWith(1, 7500);
  });

  it('broadcasts meter_values for each meterValue entry', () => {
    client._handlers['MeterValues']({
      evseId: 1,
      meterValue: [{
        timestamp: TS,
        sampledValue: [{
          measurand: 'Power.Active.Import',
          value: '11000',
          unitOfMeasure: { unit: 'W' },
        }],
      }],
    });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'meter_values',
      expect.any(Object),
      expect.anything()
    );
  });
});

// ── NotifyReport ──
describe('ocpp-server-201 — NotifyReport', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('returns empty object', () => {
    const result = client._handlers['NotifyReport']({ seqNo: 0, tbc: false, reportData: [] });
    expect(result).toEqual({});
  });

  it('calls upsertChargepointVariable for each report entry', () => {
    client._handlers['NotifyReport']({
      seqNo: 0,
      tbc: true,
      reportData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'HeartbeatInterval' },
          variableAttribute: [{ type: 'Actual', value: '300' }],
        },
      ],
    });
    expect(mockDb.upsertChargepointVariable).toHaveBeenCalledWith(
      1, 'OCPPCommCtrlr', 'HeartbeatInterval', 'Actual', '300', 0
    );
  });

  it('passes readonly=1 when mutability is ReadOnly', () => {
    client._handlers['NotifyReport']({
      seqNo: 0,
      tbc: false,
      reportData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'CertificateEntries' },
          variableAttribute: [{ type: 'Actual', value: '5', mutability: 'ReadOnly' }],
        },
      ],
    });
    expect(mockDb.upsertChargepointVariable).toHaveBeenCalledWith(
      1, 'SecurityCtrlr', 'CertificateEntries', 'Actual', '5', 1
    );
  });

  it('passes readonly=0 when mutability is ReadWrite', () => {
    client._handlers['NotifyReport']({
      seqNo: 0,
      tbc: false,
      reportData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'HeartbeatInterval' },
          variableAttribute: [{ type: 'Actual', value: '60', mutability: 'ReadWrite' }],
        },
      ],
    });
    expect(mockDb.upsertChargepointVariable).toHaveBeenCalledWith(
      1, 'OCPPCommCtrlr', 'HeartbeatInterval', 'Actual', '60', 0
    );
  });

  it('calls upsertChargepointVariable for multiple attributes on one variable', () => {
    client._handlers['NotifyReport']({
      seqNo: 0,
      tbc: false,
      reportData: [
        {
          component: { name: 'ChargingStation' },
          variable: { name: 'SupplyPhases' },
          variableAttribute: [
            { type: 'Actual', value: '3' },
            { type: 'Target', value: '3' },
          ],
        },
      ],
    });
    expect(mockDb.upsertChargepointVariable).toHaveBeenCalledTimes(2);
  });

  it('does NOT broadcast config_refreshed when tbc=true (more batches coming)', () => {
    client._handlers['NotifyReport']({ seqNo: 0, tbc: true, reportData: [] });
    const configBroadcasts = mockBroadcast.mock.calls.filter((c) => c[0] === 'config_refreshed');
    expect(configBroadcasts).toHaveLength(0);
  });

  it('broadcasts config_refreshed when tbc=false (last batch)', () => {
    client._handlers['NotifyReport']({ seqNo: 1, tbc: false, reportData: [] });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'config_refreshed',
      expect.objectContaining({ identity: 'CP001' }),
      expect.anything()
    );
  });

  it('calls updateChargepointFeatures201 when tbc=false (last batch)', () => {
    client._handlers['NotifyReport']({ seqNo: 0, tbc: false, reportData: [] });
    expect(mockDb.updateChargepointFeatures201).toHaveBeenCalledWith(1);
  });

  it('does NOT call updateChargepointFeatures201 when tbc=true (more batches coming)', () => {
    client._handlers['NotifyReport']({ seqNo: 0, tbc: true, reportData: [] });
    expect(mockDb.updateChargepointFeatures201).not.toHaveBeenCalled();
  });

  it('skips entries with missing component or variable name', () => {
    client._handlers['NotifyReport']({
      seqNo: 0,
      tbc: false,
      reportData: [
        { component: null, variable: { name: 'X' }, variableAttribute: [{ type: 'Actual', value: '1' }] },
        { component: { name: 'C' }, variable: null, variableAttribute: [{ type: 'Actual', value: '1' }] },
      ],
    });
    expect(mockDb.upsertChargepointVariable).not.toHaveBeenCalled();
  });
});

// ── ReservationStatusUpdate ──
describe('ocpp-server-201 — ReservationStatusUpdate', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    mockDb.getReservationByOcppId.mockReturnValue({ id: 10, status: 'Active' });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('returns empty object', () => {
    const result = client._handlers['ReservationStatusUpdate']({
      reservationId: 5,
      reservationUpdateStatus: 'Expired',
    });
    expect(result).toEqual({});
  });

  it('maps Expired → updates reservation status to Expired', () => {
    client._handlers['ReservationStatusUpdate']({
      reservationId: 5,
      reservationUpdateStatus: 'Expired',
    });
    expect(mockDb.updateReservationStatus).toHaveBeenCalledWith(10, 'Expired');
  });

  it('maps Removed → updates reservation status to Expired', () => {
    client._handlers['ReservationStatusUpdate']({
      reservationId: 5,
      reservationUpdateStatus: 'Removed',
    });
    expect(mockDb.updateReservationStatus).toHaveBeenCalledWith(10, 'Expired');
  });

  it('maps Failed → updates reservation status to Expired', () => {
    client._handlers['ReservationStatusUpdate']({
      reservationId: 5,
      reservationUpdateStatus: 'Failed',
    });
    expect(mockDb.updateReservationStatus).toHaveBeenCalledWith(10, 'Expired');
  });

  it('broadcasts reservation_updated', () => {
    client._handlers['ReservationStatusUpdate']({
      reservationId: 5,
      reservationUpdateStatus: 'Expired',
    });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'reservation_updated',
      { chargepoint_id: 1 },
      expect.anything()
    );
  });

  it('does nothing when reservation not found', () => {
    mockDb.getReservationByOcppId.mockReturnValue(null);
    expect(() => {
      client._handlers['ReservationStatusUpdate']({
        reservationId: 99,
        reservationUpdateStatus: 'Expired',
      });
    }).not.toThrow();
    expect(mockDb.updateReservationStatus).not.toHaveBeenCalled();
  });
});

// ── BootNotification — séquence d'init async (setImmediate) ──
describe('ocpp-server-201 — BootNotification init sequence', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: false, site_id: 1 });
    mockConnectedClients.set('CP001', client);
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('envoie ClearCache', async () => {
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.call).toHaveBeenCalledWith('ClearCache', {});
  });

  it('envoie ClearChargingProfile quand aucun profil en DB', async () => {
    mockDb.getChargingProfiles.mockReturnValue([]);
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.call).toHaveBeenCalledWith('ClearChargingProfile', {});
  });

  it('saute ClearChargingProfile quand des profils gérés existent', async () => {
    mockDb.getChargingProfiles.mockReturnValue([{ id: 1 }]);
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.call).not.toHaveBeenCalledWith('ClearChargingProfile', expect.anything());
  });

  it('envoie GetBaseReport', async () => {
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.call).toHaveBeenCalledWith('GetBaseReport', expect.objectContaining({ reportBase: 'FullInventory' }));
  });

  it('envoie SetVariables pour chaque variable initiale activée', async () => {
    mockDb.getEnabledInitialChargepointVariables.mockReturnValue([
      { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', attribute: 'Actual', value: '60' },
    ]);
    client.call.mockResolvedValue({ setVariableResult: [{ attributeStatus: 'Accepted' }] });
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.call).toHaveBeenCalledWith('SetVariables', {
      setVariableData: [{
        component: { name: 'OCPPCommCtrlr' },
        variable: { name: 'HeartbeatInterval' },
        attributeType: 'Actual',
        attributeValue: '60',
      }],
    });
  });

  it('upsert la variable en DB après SetVariables Accepted', async () => {
    mockDb.getEnabledInitialChargepointVariables.mockReturnValue([
      { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', attribute: 'Actual', value: '60' },
    ]);
    client.call.mockResolvedValue({ setVariableResult: [{ attributeStatus: 'Accepted' }] });
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockDb.upsertChargepointVariable).toHaveBeenCalledWith(
      1, 'OCPPCommCtrlr', 'HeartbeatInterval', 'Actual', '60'
    );
  });

  it('appelle markChargepointInitialized après la séquence réussie', async () => {
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockDb.markChargepointInitialized).toHaveBeenCalledWith(1);
  });

  it('saute la séquence si la borne est déjà initialisée', async () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: true, site_id: 1 });
    const client2 = makeClient('CP002');
    mockConnectedClients.set('CP002', client2);
    register201Handlers(client2, makeLoggedHandle(client2));
    client2._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client2.call).not.toHaveBeenCalledWith('ClearCache', expect.anything());
    expect(mockDb.markChargepointInitialized).not.toHaveBeenCalled();
  });

  it("n'appelle pas markChargepointInitialized en cas d'erreur de déconnexion", async () => {
    client.call.mockRejectedValue(new Error('not connected'));
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockDb.markChargepointInitialized).not.toHaveBeenCalled();
  });

  it("n'upsert pas la variable en DB si SetVariables retourne un statut non-Accepted", async () => {
    mockDb.getEnabledInitialChargepointVariables.mockReturnValue([
      { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', attribute: 'Actual', value: '60' },
    ]);
    client.call.mockResolvedValue({ setVariableResult: [{ attributeStatus: 'Rejected' }] });
    client._handlers['BootNotification']({ chargingStation: { vendorName: 'X' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockDb.upsertChargepointVariable).not.toHaveBeenCalled();
  });
});

// ── DataTransfer ──
describe('ocpp-server-201 — DataTransfer', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('enregistre le handler', () => {
    expect(client._handlers['DataTransfer']).toBeDefined();
  });

  it('retourne status Accepted', () => {
    const result = client._handlers['DataTransfer']({
      vendorId: 'ACME', messageId: 'Ping', data: 'hello',
    });
    expect(result).toEqual({ status: 'Accepted' });
  });

  it('retourne Accepted même sans payload', () => {
    const result = client._handlers['DataTransfer']({});
    expect(result).toEqual({ status: 'Accepted' });
  });
});

// ── FirmwareStatusNotification ──
describe('ocpp-server-201 — FirmwareStatusNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1, site_id: 10, cpname: 'CP-1', site_name: 'Site A',
    });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('enregistre le handler', () => {
    expect(client._handlers['FirmwareStatusNotification']).toBeDefined();
  });

  it('retourne un objet vide', () => {
    const result = client._handlers['FirmwareStatusNotification']({ status: 'Downloading' });
    expect(result).toEqual({});
  });

  it('broadcast firmware_status pour tout statut', () => {
    client._handlers['FirmwareStatusNotification']({ status: 'Downloading' });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'firmware_status', { identity: 'CP001', status: 'Downloading' }, 10
    );
  });

  it('émet une notification pour le statut Installed', async () => {
    client._handlers['FirmwareStatusNotification']({ status: 'Installed' });
    await Promise.resolve();
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'firmware_status', expect.objectContaining({ status: 'Installed' })
    );
  });

  it('émet une notification pour InstallationFailed', async () => {
    client._handlers['FirmwareStatusNotification']({ status: 'InstallationFailed' });
    await Promise.resolve();
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'firmware_status', expect.objectContaining({ status: 'InstallationFailed' })
    );
  });

  it('émet une notification pour DownloadFailed', async () => {
    client._handlers['FirmwareStatusNotification']({ status: 'DownloadFailed' });
    await Promise.resolve();
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'firmware_status', expect.objectContaining({ status: 'DownloadFailed' })
    );
  });

  it("n'émet pas de notification pour Downloading", async () => {
    client._handlers['FirmwareStatusNotification']({ status: 'Downloading' });
    await Promise.resolve();
    expect(mockNotifications.emit).not.toHaveBeenCalled();
  });
});

// ── LogStatusNotification ──
describe('ocpp-server-201 — LogStatusNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 5 });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('enregistre le handler', () => {
    expect(client._handlers['LogStatusNotification']).toBeDefined();
  });

  it('retourne un objet vide', () => {
    const result = client._handlers['LogStatusNotification']({ status: 'Uploading', requestId: 1 });
    expect(result).toEqual({});
  });

  it('broadcast diagnostics_upload sur Uploaded', () => {
    client._handlers['LogStatusNotification']({ status: 'Uploaded', requestId: 1 });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'diagnostics_upload', { identity: 'CP001', status: 'Uploaded' }, 5
    );
  });

  it('broadcast diagnostics_upload sur UploadFailed', () => {
    client._handlers['LogStatusNotification']({ status: 'UploadFailed', requestId: 1 });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'diagnostics_upload', { identity: 'CP001', status: 'UploadFailed' }, 5
    );
  });

  it("ne broadcast pas pour le statut Uploading", () => {
    client._handlers['LogStatusNotification']({ status: 'Uploading', requestId: 1 });
    expect(mockBroadcast).not.toHaveBeenCalledWith(
      'diagnostics_upload', expect.anything(), expect.anything()
    );
  });
});

// ── SecurityEventNotification ──
describe('ocpp-server-201 — SecurityEventNotification', () => {
  let client;

  beforeEach(() => {
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 3 });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('enregistre le handler', () => {
    expect(client._handlers['SecurityEventNotification']).toBeDefined();
  });

  it('retourne un objet vide', () => {
    const result = client._handlers['SecurityEventNotification']({
      type: 'SettingSystemTime', timestamp: new Date().toISOString(),
    });
    expect(result).toEqual({});
  });

  it('insère un error_event en DB', () => {
    client._handlers['SecurityEventNotification']({
      type: 'SettingSystemTime', techInfo: 'NTP sync failed',
    });
    expect(mockDb.insertErrorEvent).toHaveBeenCalledWith(
      1, 'security_event',
      expect.objectContaining({ ocpp_version: '2.0.1', tech_code: 'SettingSystemTime', tech_info: 'NTP sync failed' })
    );
  });

  it('stocke null pour techInfo quand absent', () => {
    client._handlers['SecurityEventNotification']({ type: 'SettingSystemTime' });
    expect(mockDb.insertErrorEvent).toHaveBeenCalledWith(
      1, 'security_event', expect.objectContaining({ tech_info: null })
    );
  });

  it('broadcast error_event', () => {
    client._handlers['SecurityEventNotification']({ type: 'SettingSystemTime' });
    expect(mockBroadcast).toHaveBeenCalledWith('error_event', { chargepoint_id: 1 }, 3);
  });

  it('ne fait rien si la borne est inconnue', () => {
    mockDb.getChargepointByIdentity.mockReturnValue(null);
    expect(() => client._handlers['SecurityEventNotification']({ type: 'X' })).not.toThrow();
    expect(mockDb.insertErrorEvent).not.toHaveBeenCalled();
  });
});

// ── StateRefresh TriggerMessage ──
describe('ocpp-server-201 — StateRefresh TriggerMessage', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('envoie TriggerMessage(BootNotification) + TriggerMessage(StatusNotification) après 8s si initialized=1', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, site_id: 1 })  // cpRecord à l'enregistrement
      .mockReturnValue({ id: 1, connected: 1, site_id: 1 });        // appels suivants
    mockConnectedClients.set('CP001', client);

    register201Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(18001); // 8s outer + 10s inner

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });

  it("ne déclenche pas TriggerMessage si initialized=0 (nouvelle borne)", async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 0, site_id: 1 });

    register201Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('ne déclenche pas TriggerMessage si cpRecord est null (borne inconnue)', async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue(null);

    register201Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it('enregistre un listener close pour annuler le timer', () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 1, site_id: 1 });

    register201Handlers(client, makeLoggedHandle(client));

    expect(client.once).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('annule le TriggerMessage si la borne se déconnecte avant 8s', async () => {
    const client = makeClient('CP001');
    let closeCallback;
    client.once = jest.fn((event, cb) => { if (event === 'close') closeCallback = cb; });
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, initialized: 1, site_id: 1 });

    register201Handlers(client, makeLoggedHandle(client));
    closeCallback();
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', expect.anything());
  });

  it("n'envoie pas TriggerMessage(StatusNotification) si TriggerMessage(BootNotification) échoue", async () => {
    const client = makeClient('CP001');
    client.call = jest.fn().mockRejectedValue(new Error('not connected'));
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, site_id: 1 })
      .mockReturnValue({ id: 1, connected: 1, site_id: 1 });
    mockConnectedClients.set('CP001', client);

    register201Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(8001);

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });

  it("n'envoie pas TriggerMessage(StatusNotification) si la borne est déconnectée après le délai de 10s", async () => {
    const client = makeClient('CP001');
    mockDb.getChargepointByIdentity
      .mockReturnValueOnce({ id: 1, initialized: 1, site_id: 1 })  // cpRecord
      .mockReturnValueOnce({ id: 1, connected: 1, site_id: 1 })    // timer check
      .mockReturnValueOnce({ id: 1, site_id: 1 })                   // callClient201 pour TriggerMessage Boot
      .mockReturnValue({ id: 1, connected: 0, site_id: 1 });        // vérification après 10s: déconnecté
    mockConnectedClients.set('CP001', client);

    register201Handlers(client, makeLoggedHandle(client));
    await jest.advanceTimersByTimeAsync(18001);

    expect(client.call).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(client.call).not.toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'StatusNotification' });
  });
});

describe('ocpp-server-201 — NotifyEvent', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = makeClient('CP001');
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 3 });
    register201Handlers(client, makeLoggedHandle(client));
  });

  it('enregistre le handler', () => {
    expect(client._handlers['NotifyEvent']).toBeDefined();
  });

  it('retourne un objet vide', () => {
    const result = client._handlers['NotifyEvent']({ generatedAt: new Date().toISOString(), seqNo: 0, eventData: [] });
    expect(result).toEqual({});
  });

  it('insère un error_event pour un trigger Alerting', () => {
    client._handlers['NotifyEvent']({
      generatedAt: '2026-06-05T17:27:23.735Z', seqNo: 0,
      eventData: [{
        eventId: 1, timestamp: '2026-06-05T17:27:23.735Z',
        trigger: 'Alerting', eventNotificationType: 'HardWiredNotification',
        component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
        variable: { name: 'Problem' }, actualValue: 'true',
      }],
    });
    expect(mockDb.insertErrorEvent).toHaveBeenCalledWith(1, 'notify_event',
      expect.objectContaining({
        ocpp_version: '2.0.1', evse_id: 1, connector_id: 1,
        component: 'Connector', variable: 'Problem',
        tech_code: 'Alerting', tech_info: 'HardWiredNotification',
        info: 'true',
      })
    );
  });

  it('utilise techCode en priorité sur trigger pour tech_code', () => {
    client._handlers['NotifyEvent']({
      eventData: [{ trigger: 'Alerting', techCode: 'SpecificCode', eventNotificationType: 'HardWiredNotification',
        component: { name: 'Connector' }, variable: { name: 'Problem' } }],
    });
    expect(mockDb.insertErrorEvent).toHaveBeenCalledWith(1, 'notify_event',
      expect.objectContaining({ tech_code: 'SpecificCode' })
    );
  });

  it('ignore les événements Delta et Periodic', () => {
    client._handlers['NotifyEvent']({
      eventData: [
        { trigger: 'Delta', component: { name: 'Meter' }, variable: { name: 'Energy' } },
        { trigger: 'Periodic', component: { name: 'Meter' }, variable: { name: 'Power' } },
      ],
    });
    expect(mockDb.insertErrorEvent).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('insère uniquement les Alerting dans un tableau mixte', () => {
    client._handlers['NotifyEvent']({
      eventData: [
        { trigger: 'Delta', component: { name: 'Meter' }, variable: { name: 'Energy' } },
        { trigger: 'Alerting', component: { name: 'Connector' }, variable: { name: 'Problem' }, actualValue: 'true' },
      ],
    });
    expect(mockDb.insertErrorEvent).toHaveBeenCalledTimes(1);
  });

  it('broadcast error_event', () => {
    client._handlers['NotifyEvent']({
      eventData: [{ trigger: 'Alerting', component: { name: 'Connector' }, variable: { name: 'Problem' } }],
    });
    expect(mockBroadcast).toHaveBeenCalledWith('error_event', { chargepoint_id: 1 }, 3);
  });

  it('ne fait rien si la borne est inconnue', () => {
    mockDb.getChargepointByIdentity.mockReturnValue(null);
    expect(() => client._handlers['NotifyEvent']({
      eventData: [{ trigger: 'Alerting', component: { name: 'X' }, variable: { name: 'Y' } }],
    })).not.toThrow();
    expect(mockDb.insertErrorEvent).not.toHaveBeenCalled();
  });
});
