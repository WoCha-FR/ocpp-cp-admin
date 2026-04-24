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
  upsertChargepoint: jest.fn(),
  getTransactions: jest.fn(() => []),
  stopTransaction: jest.fn(),
  getInitialChargepointConfigByKey: jest.fn(),
  addOcppMessage: jest.fn(),
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

  it('calls the registered fn with serialized payload', () => {
    const fn = jest.fn();
    ocppCommon.setBroadcast(fn);
    ocppCommon.broadcast('event', { x: 1 });
    expect(fn).toHaveBeenCalledWith(JSON.stringify({ type: 'event', data: { x: 1 } }));
  });
});

// ── getConnectedClients ──
describe('ocpp-common — getConnectedClients', () => {
  it('returns a Map', () => {
    expect(ocppCommon.getConnectedClients()).toBeInstanceOf(Map);
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
    ocppCommon.startHeartbeatWatchdog();
    expect(() => ocppCommon.stopHeartbeatWatchdog()).not.toThrow();
  });

  it('stopHeartbeatWatchdog is idempotent', () => {
    expect(() => ocppCommon.stopHeartbeatWatchdog()).not.toThrow();
    expect(() => ocppCommon.stopHeartbeatWatchdog()).not.toThrow();
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
