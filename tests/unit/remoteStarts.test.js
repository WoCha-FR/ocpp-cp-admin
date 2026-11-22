'use strict';

const {
  isGeneratedTag,
  pendingKey,
  registerPendingRemoteStart,
  findPendingRemoteStart,
  PENDING_TTL_MS,
} = require('../../src/remoteStarts');

describe('remoteStarts — badges générés', () => {
  it.each(['ADMIN', 'MGR-3', 'WEB-12'])('%s est un badge généré', (tag) => {
    expect(isGeneratedTag(tag)).toBe(true);
  });
  it.each(['04A1B2C3', 'admin', '', null, undefined])('%p n’est pas un badge généré', (tag) => {
    expect(isGeneratedTag(tag)).toBe(false);
  });
});

describe('remoteStarts — démarrages à distance en attente', () => {
  let map;

  beforeEach(() => {
    jest.useFakeTimers();
    map = new Map();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('enregistre sous la clé identité_connecteur et expire après le délai', () => {
    const key = registerPendingRemoteStart(map, 'CP1', 2, { source: 'web', userId: 5, idTag: 'WEB-5' });
    expect(key).toBe(pendingKey('CP1', 2));
    expect(map.get(key)).toEqual({ source: 'web', userId: 5, idTag: 'WEB-5' });
    jest.advanceTimersByTime(PENDING_TTL_MS + 1);
    expect(map.has(key)).toBe(false);
  });

  it("l'expiration n'efface pas une demande plus récente sur le même connecteur", () => {
    registerPendingRemoteStart(map, 'CP1', 1, { source: 'web', idTag: 'WEB-1' });
    jest.advanceTimersByTime(PENDING_TTL_MS - 1000);
    registerPendingRemoteStart(map, 'CP1', 1, { source: 'web', idTag: 'WEB-2' });
    jest.advanceTimersByTime(2000); // le 1er délai expire
    expect(map.get('CP1_1')).toEqual({ source: 'web', idTag: 'WEB-2' });
  });

  it('M9 — ne correspond qu’au badge du démarrage à distance', () => {
    registerPendingRemoteStart(map, 'CP1', 1, { source: 'web', idTag: 'WEB-5' });
    expect(findPendingRemoteStart(map, 'CP1', { connectorId: 1, idTag: 'WEB-5' })).toEqual({
      key: 'CP1_1',
      entry: { source: 'web', idTag: 'WEB-5' },
    });
    expect(findPendingRemoteStart(map, 'CP1', { connectorId: 1, idTag: 'BLOCKED-BADGE' })).toBeNull();
    expect(findPendingRemoteStart(map, 'CP1', { connectorId: 1 })).toBeNull();
  });

  it('ne correspond qu’à la borne qui a reçu la demande', () => {
    registerPendingRemoteStart(map, 'CP1', 1, { source: 'web', idTag: 'ADMIN' });
    expect(findPendingRemoteStart(map, 'CP10', { idTag: 'ADMIN' })).toBeNull();
    expect(findPendingRemoteStart(map, 'CP2', { idTag: 'ADMIN' })).toBeNull();
    expect(findPendingRemoteStart(map, 'CP1', { idTag: 'ADMIN' })).not.toBeNull();
  });

  it('préfère le connecteur demandé, sinon un autre connecteur de la borne avec le même badge', () => {
    registerPendingRemoteStart(map, 'CP1', 1, { source: 'web', idTag: 'ADMIN' });
    registerPendingRemoteStart(map, 'CP1', 2, { source: 'remote', idTag: 'ADMIN' });
    expect(findPendingRemoteStart(map, 'CP1', { connectorId: 2, idTag: 'ADMIN' }).key).toBe('CP1_2');
    expect(findPendingRemoteStart(map, 'CP1', { connectorId: 3, idTag: 'ADMIN' }).key).toBe('CP1_1');
  });

  it('2.0.1 — corrélation par remoteStartId, prioritaire sur le badge', () => {
    registerPendingRemoteStart(map, 'CP1', 1, { source: 'web', idTag: 'WEB-1', remoteStartId: 77 });
    expect(findPendingRemoteStart(map, 'CP1', { remoteStartId: 77 }).key).toBe('CP1_1');
    expect(findPendingRemoteStart(map, 'CP1', { remoteStartId: 78 })).toBeNull();
  });

  it('reconnaît l’ancienne clé « identité » seule', () => {
    map.set('CP1', { source: 'remote', idTag: 'MGR-1' });
    expect(findPendingRemoteStart(map, 'CP1', { idTag: 'MGR-1' }).key).toBe('CP1');
  });
});
