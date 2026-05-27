'use strict';

const configMock = {
  ocpp: {
    strictMode: true,
    callTimeoutSeconds: 60,
    autoAddUnknownChargepoints: false,
    pendingUnknownChargepoints: false,
  },
  notifs: {
    refusedCooldownMinutes: 60,
    authRejectThreshold: 3,
    authRejectWindowMinutes: 5,
    flapWindowMinutes: 2,
    flapThreshold: 4,
  },
};

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => configMock),
}));

jest.mock('../../src/logger', () => ({
  scope: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockDb = {
  getChargepointByIdentity: jest.fn(),
  getChargepointById: jest.fn(),
  upsertChargepoint: jest.fn(),
  getTransactions: jest.fn(() => []),
  stopTransaction: jest.fn(),
  getInitialChargepointConfigByKey: jest.fn(),
  getChargepointConfigByKey: jest.fn(),
  addOcppMessage: jest.fn(),
  getExpiredActiveReservations: jest.fn(() => []),
  updateReservationStatus: jest.fn(),
  resetConnectorsByChargepoint: jest.fn(),
  insertErrorEvent: jest.fn(),
};

jest.mock('../../src/database', () => mockDb);

const mockNotifications = { emit: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/notifications', () => mockNotifications);

jest.mock('ocpp-rpc', () => {
  const { EventEmitter } = require('events');
  class MockRPCServer extends EventEmitter {
    constructor() {
      super();
      this._authFn = null;
    }
    auth(fn) {
      this._authFn = fn;
    }
  }
  return {
    RPCServer: MockRPCServer,
    createRPCError: (code) => {
      const e = new Error(code);
      e.rpcCode = code;
      return e;
    },
  };
});

jest.mock('bcryptjs', () => ({ compareSync: jest.fn(() => true) }));

const ocppCommon = require('../../src/ocpp-common');

beforeEach(() => {
  jest.clearAllMocks();
  ocppCommon.getConnectedClients().clear();
});

// ── broadcast ──
describe('ocpp-common — broadcast', () => {
  it('does nothing before setBroadcast is called', () => {
    expect(() => ocppCommon.broadcast('test', {})).not.toThrow();
  });

  it('calls the registered fn with serialized payload and null siteId', () => {
    const fn = jest.fn();
    ocppCommon.setBroadcast(fn);
    ocppCommon.broadcast('event', { x: 1 });
    expect(fn).toHaveBeenCalledWith(JSON.stringify({ type: 'event', data: { x: 1 } }), null);
  });

  it('passes siteId as second argument to the registered fn', () => {
    const fn = jest.fn();
    ocppCommon.setBroadcast(fn);
    ocppCommon.broadcast('event', { x: 1 }, 42);
    expect(fn).toHaveBeenCalledWith(JSON.stringify({ type: 'event', data: { x: 1 } }), 42);
  });
});

// ── getConnectedClients ──
describe('ocpp-common — getConnectedClients', () => {
  it('returns a Map', () => {
    expect(ocppCommon.getConnectedClients()).toBeInstanceOf(Map);
  });
});

// ── createOCPPServerBase auth validation ──
describe('ocpp-common — createOCPPServerBase auth', () => {
  it('rejects invalid identity format before DB checks', () => {
    const server = ocppCommon.createOCPPServerBase();
    const accept = jest.fn();
    const reject = jest.fn();
    server._authFn(accept, reject, {
      identity: 'cp<script>',
      remoteAddress: '127.0.0.1',
    });
    expect(reject).toHaveBeenCalledWith(400, 'Invalid identity format');
    expect(accept).not.toHaveBeenCalled();
    expect(mockDb.getChargepointByIdentity).not.toHaveBeenCalled();
  });
});

// ── getClientIp — résolution IP derrière proxy ──
describe('ocpp-common — getClientIp via trustProxy', () => {
  const CP = { authorized: true, password: null };

  afterEach(() => {
    delete configMock.webui;
  });

  it('retourne remoteAddress quand trustProxy est désactivé, même avec x-forwarded-for', () => {
    configMock.webui = { trustProxy: false };
    mockDb.getChargepointByIdentity.mockReturnValue(CP);
    const server = ocppCommon.createOCPPServerBase();
    const accept = jest.fn();
    const reject = jest.fn();
    server._authFn(accept, reject, {
      identity: 'CP001',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4, 172.18.0.1' },
    });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ remoteAddress: '127.0.0.1' }));
  });

  it('retourne la première IP de x-forwarded-for quand trustProxy est activé', () => {
    configMock.webui = { trustProxy: true };
    mockDb.getChargepointByIdentity.mockReturnValue(CP);
    const server = ocppCommon.createOCPPServerBase();
    const accept = jest.fn();
    const reject = jest.fn();
    server._authFn(accept, reject, {
      identity: 'CP001',
      remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4, 172.18.0.1' },
    });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ remoteAddress: '1.2.3.4' }));
  });

  it('retourne x-real-ip quand trustProxy est activé et x-forwarded-for absent', () => {
    configMock.webui = { trustProxy: true };
    mockDb.getChargepointByIdentity.mockReturnValue(CP);
    const server = ocppCommon.createOCPPServerBase();
    const accept = jest.fn();
    const reject = jest.fn();
    server._authFn(accept, reject, {
      identity: 'CP001',
      remoteAddress: '172.18.0.1',
      headers: { 'x-real-ip': '5.6.7.8' },
    });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ remoteAddress: '5.6.7.8' }));
  });
});

// ── registerHandlersFn / registerCallClientImpl ──
describe('ocpp-common — register helpers', () => {
  it('registers 1.6 and 2.0.1 handler fns without error', () => {
    expect(() => ocppCommon.registerHandlersFn('1.6', jest.fn())).not.toThrow();
    expect(() => ocppCommon.registerHandlersFn('2.0.1', jest.fn())).not.toThrow();
  });

  it('registers 1.6 and 2.0.1 callClient impls without error', () => {
    expect(() => ocppCommon.registerCallClientImpl('1.6', jest.fn())).not.toThrow();
    expect(() => ocppCommon.registerCallClientImpl('2.0.1', jest.fn())).not.toThrow();
  });
});

// ── callClient ──
describe('ocpp-common — callClient', () => {
  it('routes to 1.6 impl', async () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '1.6' });
    const impl = jest.fn().mockResolvedValue({ status: 'Accepted' });
    ocppCommon.registerCallClientImpl('1.6', impl);
    const result = await ocppCommon.callClient('CP001', 'Reset', { type: 'Soft' });
    expect(impl).toHaveBeenCalledWith('CP001', 'Reset', { type: 'Soft' });
    expect(result).toEqual({ status: 'Accepted' });
  });

  it('routes to 2.0.1 impl', async () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '2.0.1' });
    const impl = jest.fn().mockResolvedValue({ status: 'Accepted' });
    ocppCommon.registerCallClientImpl('2.0.1', impl);
    await ocppCommon.callClient('CP002', 'Reset', {});
    expect(impl).toHaveBeenCalledWith('CP002', 'Reset', {});
  });

  it('throws when 1.6 impl is null', async () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '1.6' });
    ocppCommon.registerCallClientImpl('1.6', null);
    await expect(ocppCommon.callClient('CP003', 'Reset', {})).rejects.toThrow(
      'OCPP 1.6 callClient not registered'
    );
  });

  it('throws when 2.0.1 impl is null', async () => {
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '2.0.1' });
    ocppCommon.registerCallClientImpl('2.0.1', null);
    await expect(ocppCommon.callClient('CP004', 'Reset', {})).rejects.toThrow(
      'OCPP 2.0.1 callClient not registered'
    );
  });
});

// ── disconnectChargepoint ──
describe('ocpp-common — disconnectChargepoint', () => {
  it('does nothing for unknown identity', () => {
    expect(() => ocppCommon.disconnectChargepoint('GHOST')).not.toThrow();
  });

  it('closes client and stops active transactions', () => {
    const mockClient = { close: jest.fn() };
    ocppCommon.getConnectedClients().set('CP_DISC', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 1, site_id: 1 });
    mockDb.getTransactions.mockReturnValue([{ transaction_id: 42, meter_start: 100 }]);
    ocppCommon.disconnectChargepoint('CP_DISC');
    expect(mockClient.close).toHaveBeenCalled();
    expect(mockDb.stopTransaction).toHaveBeenCalledWith(42, 100, expect.any(String), 'DeAuthorized');
  });

  it('handles client.close() throwing without propagating', () => {
    const mockClient = { close: jest.fn(() => { throw new Error('already closed'); }) };
    ocppCommon.getConnectedClients().set('CP_ERR', mockClient);
    mockDb.getChargepointByIdentity.mockReturnValue({ id: 2 });
    mockDb.getTransactions.mockReturnValue([]);
    expect(() => ocppCommon.disconnectChargepoint('CP_ERR')).not.toThrow();
  });
});

// ── trackRepeatedAuthReject ──
describe('ocpp-common — trackRepeatedAuthReject', () => {
  it('does not emit on first rejection', () => {
    ocppCommon.trackRepeatedAuthReject('TAG_A', 'CP001', null);
    expect(mockNotifications.emit).not.toHaveBeenCalled();
  });

  it('does not emit below threshold', () => {
    ocppCommon.trackRepeatedAuthReject('TAG_B', 'CP001', null);
    ocppCommon.trackRepeatedAuthReject('TAG_B', 'CP001', null);
    expect(mockNotifications.emit).not.toHaveBeenCalled();
  });

  it('emits repeated_auth_rejected on threshold (3)', () => {
    const cp = { cpname: 'TestCP', site_id: 10, site_name: 'Site A' };
    ocppCommon.trackRepeatedAuthReject('TAG_C', 'CP001', cp);
    ocppCommon.trackRepeatedAuthReject('TAG_C', 'CP001', cp);
    ocppCommon.trackRepeatedAuthReject('TAG_C', 'CP001', cp);
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'repeated_auth_rejected',
      expect.objectContaining({ id_tag: 'TAG_C', count: 3 }),
      expect.any(Object)
    );
  });
});

// ── startHeartbeatWatchdog / stopHeartbeatWatchdog ──
describe('ocpp-common — heartbeat watchdog', () => {
  it('starts and stops without error', () => {
    mockDb.getInitialChargepointConfigByKey.mockReturnValue({ value: '60' });
    mockDb.getChargepointConfigByKey.mockReturnValue(null);
    ocppCommon.startHeartbeatWatchdog();
    expect(() => ocppCommon.stopHeartbeatWatchdog()).not.toThrow();
  });

  it('stopHeartbeatWatchdog is idempotent', () => {
    expect(() => ocppCommon.stopHeartbeatWatchdog()).not.toThrow();
    expect(() => ocppCommon.stopHeartbeatWatchdog()).not.toThrow();
  });
});

// ── startReservationCleanupWatchdog / stopReservationCleanupWatchdog ──
describe('ocpp-common — reservation cleanup watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDb.getExpiredActiveReservations.mockReturnValue([]);
  });

  afterEach(() => {
    ocppCommon.stopReservationCleanupWatchdog();
    jest.useRealTimers();
  });

  it('starts and stops without error', () => {
    ocppCommon.startReservationCleanupWatchdog();
    expect(() => ocppCommon.stopReservationCleanupWatchdog()).not.toThrow();
  });

  it('stopReservationCleanupWatchdog is idempotent', () => {
    expect(() => ocppCommon.stopReservationCleanupWatchdog()).not.toThrow();
    expect(() => ocppCommon.stopReservationCleanupWatchdog()).not.toThrow();
  });

  it('sends CancelReservation and marks Expired when chargepoint is connected', async () => {
    const reservation = { id: 7, reservation_id: 42, chargepoint_id: 99, identity: 'CP-CLEANUP' };
    mockDb.getExpiredActiveReservations.mockReturnValue([reservation]);
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '1.6' });
    const impl = jest.fn().mockResolvedValue({ status: 'Accepted' });
    ocppCommon.registerCallClientImpl('1.6', impl);
    ocppCommon.getConnectedClients().set('CP-CLEANUP', {});

    ocppCommon.startReservationCleanupWatchdog();
    await jest.advanceTimersByTimeAsync(60000);

    expect(impl).toHaveBeenCalledWith('CP-CLEANUP', 'CancelReservation', { reservationId: 42 });
    expect(mockDb.updateReservationStatus).toHaveBeenCalledWith(7, 'Expired');
  });

  it('does not mark Expired when CancelReservation is rejected', async () => {
    const reservation = { id: 8, reservation_id: 43, chargepoint_id: 99, identity: 'CP-CLEANUP' };
    mockDb.getExpiredActiveReservations.mockReturnValue([reservation]);
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '1.6' });
    const impl = jest.fn().mockResolvedValue({ status: 'Rejected' });
    ocppCommon.registerCallClientImpl('1.6', impl);
    ocppCommon.getConnectedClients().set('CP-CLEANUP', {});

    ocppCommon.startReservationCleanupWatchdog();
    await jest.advanceTimersByTimeAsync(60000);

    expect(mockDb.updateReservationStatus).not.toHaveBeenCalled();
  });

  it('skips offline chargepoints without calling callClient', async () => {
    const reservation = { id: 9, reservation_id: 44, chargepoint_id: 99, identity: 'CP-OFFLINE' };
    mockDb.getExpiredActiveReservations.mockReturnValue([reservation]);
    const impl = jest.fn();
    ocppCommon.registerCallClientImpl('1.6', impl);

    ocppCommon.startReservationCleanupWatchdog();
    await jest.advanceTimersByTimeAsync(60000);

    expect(impl).not.toHaveBeenCalled();
    expect(mockDb.updateReservationStatus).not.toHaveBeenCalled();
  });

  it('swallows callClient errors without crashing the interval', async () => {
    const reservation = { id: 10, reservation_id: 45, chargepoint_id: 99, identity: 'CP-ERR' };
    mockDb.getExpiredActiveReservations.mockReturnValue([reservation]);
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '1.6' });
    const impl = jest.fn().mockRejectedValue(new Error('network timeout'));
    ocppCommon.registerCallClientImpl('1.6', impl);
    ocppCommon.getConnectedClients().set('CP-ERR', {});

    ocppCommon.startReservationCleanupWatchdog();
    await expect(jest.advanceTimersByTimeAsync(60000)).resolves.not.toThrow();
    expect(mockDb.updateReservationStatus).not.toHaveBeenCalled();
  });

  it('broadcasts reservation_updated on successful cancel', async () => {
    const fn = jest.fn();
    ocppCommon.setBroadcast(fn);
    const reservation = { id: 11, reservation_id: 46, chargepoint_id: 55, identity: 'CP-BCAST' };
    mockDb.getExpiredActiveReservations.mockReturnValue([reservation]);
    mockDb.getChargepointByIdentity.mockReturnValue({ ocpp_version: '1.6' });
    ocppCommon.registerCallClientImpl('1.6', jest.fn().mockResolvedValue({ status: 'Accepted' }));
    ocppCommon.getConnectedClients().set('CP-BCAST', {});

    ocppCommon.startReservationCleanupWatchdog();
    await jest.advanceTimersByTimeAsync(60000);

    expect(fn).toHaveBeenCalledWith(
      JSON.stringify({ type: 'reservation_updated', data: { chargepoint_id: 55 } }),
      null
    );
  });
});

// ── pendingChargepoints ──
describe('ocpp-common — pendingChargepoints', () => {
  it('is exported as a Map', () => {
    expect(ocppCommon.pendingChargepoints).toBeInstanceOf(Map);
  });
});

// ── pendingRemoteStarts ──
describe('ocpp-common — pendingRemoteStarts', () => {
  it('is exported as a Map', () => {
    expect(ocppCommon.pendingRemoteStarts).toBeInstanceOf(Map);
  });
});

// ── période de grâce offline (reconnectGracePeriodSeconds) ──
describe('ocpp-common — période de grâce offline', () => {
  const { EventEmitter } = require('events');

  function makeClient(identity) {
    const client = new EventEmitter();
    client.identity = identity;
    client.session = { remoteAddress: '1.2.3.4' };
    client.protocol = 'ocpp1.6';
    client.close = jest.fn();
    client.handle = jest.fn();
    return client;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    configMock.notifs.reconnectGracePeriodSeconds = 60;
    ocppCommon.registerHandlersFn('1.6', jest.fn());
    mockDb.getChargepointByIdentity.mockReturnValue({
      id: 1,
      cpname: 'Test CP',
      site_id: 10,
      site_name: 'Site Test',
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('émet chargepoint_online immédiatement à la connexion', () => {
    const server = ocppCommon.createOCPPServerBase();
    const client = makeClient('CP_GRACE_ONLINE');

    server.emit('client', client);

    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'chargepoint_online',
      expect.objectContaining({ identity: 'CP_GRACE_ONLINE' }),
      expect.any(Object)
    );
  });

  it("ne déclenche pas la notification offline avant l'expiration de la période de grâce", async () => {
    const server = ocppCommon.createOCPPServerBase();
    const client = makeClient('CP_GRACE_WAIT');
    server.emit('client', client);
    jest.clearAllMocks();

    client.emit('close');

    await jest.advanceTimersByTimeAsync(59000);
    expect(mockNotifications.emit).not.toHaveBeenCalledWith(
      'chargepoint_offline',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('envoie chargepoint_offline après la période de grâce si la borne reste déconnectée', async () => {
    const server = ocppCommon.createOCPPServerBase();
    const client = makeClient('CP_GRACE_EXPIRE');
    server.emit('client', client);
    jest.clearAllMocks();

    client.emit('close');

    await jest.advanceTimersByTimeAsync(61000);
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'chargepoint_offline',
      expect.objectContaining({ identity: 'CP_GRACE_EXPIRE' }),
      expect.any(Object)
    );
  });

  it('supprime les notifications offline et online si reconnexion dans la période de grâce', async () => {
    const server = ocppCommon.createOCPPServerBase();
    const client1 = makeClient('CP_GRACE_FAST');
    const client2 = makeClient('CP_GRACE_FAST');
    server.emit('client', client1);
    jest.clearAllMocks();

    client1.emit('close');

    await jest.advanceTimersByTimeAsync(30000);
    server.emit('client', client2);

    await jest.advanceTimersByTimeAsync(40000);

    expect(mockNotifications.emit).not.toHaveBeenCalledWith(
      'chargepoint_offline',
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockNotifications.emit).not.toHaveBeenCalledWith(
      'chargepoint_online',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('émet chargepoint_online si la borne se reconnecte après la période de grâce', async () => {
    const server = ocppCommon.createOCPPServerBase();
    const client1 = makeClient('CP_GRACE_LATE');
    const client2 = makeClient('CP_GRACE_LATE');
    server.emit('client', client1);
    jest.clearAllMocks();

    client1.emit('close');

    await jest.advanceTimersByTimeAsync(61000);
    jest.clearAllMocks();

    server.emit('client', client2);
    expect(mockNotifications.emit).toHaveBeenCalledWith(
      'chargepoint_online',
      expect.objectContaining({ identity: 'CP_GRACE_LATE' }),
      expect.any(Object)
    );
  });

  it("n'envoie pas de notification offline si la déconnexion est due à heartbeat_timeout", async () => {
    const server = ocppCommon.createOCPPServerBase();
    const client = makeClient('CP_GRACE_HBT');
    server.emit('client', client);
    jest.clearAllMocks();

    client._disconnectReason = 'heartbeat_timeout';
    client.emit('close');

    await jest.advanceTimersByTimeAsync(120000);
    expect(mockNotifications.emit).not.toHaveBeenCalledWith(
      'chargepoint_offline',
      expect.any(Object),
      expect.any(Object)
    );
  });
});
