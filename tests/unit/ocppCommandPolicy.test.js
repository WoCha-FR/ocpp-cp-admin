'use strict';

const { checkCommandAllowed, MANAGER_ALLOWED_COMMANDS } = require('../../src/ocppCommandPolicy');

const config = { ocpp: { diagnosticsLocation: 'ftp://logs.example.com/cp' } };

describe('ocppCommandPolicy — administrateur', () => {
  it.each([
    'ChangeConfiguration',
    'SetVariables',
    'UpdateFirmware',
    'SetNetworkProfile',
    'InstallCertificate',
    'DataTransfer',
    'N\'importe quoi',
  ])('admin : %s autorisé (console OCPP)', (method) => {
    expect(checkCommandAllowed('admin', method, {}, config)).toEqual({ ok: true });
  });

  it('admin : emplacement de diagnostic libre', () => {
    expect(
      checkCommandAllowed('admin', 'GetDiagnostics', { location: 'ftp://autre/x' }, config).ok
    ).toBe(true);
  });
});

describe('ocppCommandPolicy — manager de site', () => {
  it.each([...MANAGER_ALLOWED_COMMANDS].filter((m) => !['GetDiagnostics', 'GetLog'].includes(m)))(
    '%s autorisé',
    (method) => {
      expect(checkCommandAllowed('user', method, {}, config)).toEqual({ ok: true });
    }
  );

  it.each([
    'ChangeConfiguration', // AuthorizationKey, URL du CSMS…
    'SetVariables',
    'GetConfiguration',
    'GetVariables',
    'UpdateFirmware',
    'SetNetworkProfile',
    'InstallCertificate',
    'CertificateSigned',
    'DeleteCertificate',
    'DataTransfer',
    'SendLocalList',
    'SetChargingProfile',
    'ClearChargingProfile',
    'RemoteStartTransaction',
    'RequestStartTransaction',
    'ReserveNow',
    'CancelReservation',
    'SetMonitoringBase',
    'CustomerInformation',
    '__proto__',
    'toString',
    '',
  ])('%s refusé', (method) => {
    expect(checkCommandAllowed('user', method, {}, config)).toEqual({
      ok: false,
      error: 'ERR_OCPP_COMMAND_NOT_ALLOWED',
    });
  });

  it('un rôle inconnu / absent est traité comme un manager (jamais comme un admin)', () => {
    for (const role of [undefined, null, 'manager', 'Admin', 'administrator']) {
      expect(checkCommandAllowed(role, 'UpdateFirmware', {}, config).ok).toBe(false);
    }
  });

  describe('envoi de journaux : emplacement imposé', () => {
    it('GetDiagnostics (1.6) vers l\'emplacement configuré : autorisé', () => {
      expect(
        checkCommandAllowed('user', 'GetDiagnostics', { location: 'ftp://logs.example.com/cp' }, config).ok
      ).toBe(true);
    });
    it('GetDiagnostics vers une autre URL (exfiltration) : refusé', () => {
      expect(
        checkCommandAllowed('user', 'GetDiagnostics', { location: 'https://evil.example/x' }, config).ok
      ).toBe(false);
    });
    it('GetLog (2.0.1) vers l\'emplacement configuré : autorisé ; ailleurs : refusé', () => {
      const good = { logType: 'DiagnosticsLog', requestId: 1, log: { remoteLocation: 'ftp://logs.example.com/cp' } };
      const bad = { logType: 'DiagnosticsLog', requestId: 1, log: { remoteLocation: 'https://evil.example/x' } };
      expect(checkCommandAllowed('user', 'GetLog', good, config).ok).toBe(true);
      expect(checkCommandAllowed('user', 'GetLog', bad, config).ok).toBe(false);
    });
    it('GetLog sans log.remoteLocation : refusé quand un emplacement est configuré', () => {
      expect(checkCommandAllowed('user', 'GetLog', { logType: 'DiagnosticsLog' }, config).ok).toBe(false);
    });
    it('aucun emplacement configuré : seul le comportement de l\'UI (chaîne vide) passe', () => {
      const empty = { ocpp: {} };
      expect(checkCommandAllowed('user', 'GetDiagnostics', { location: '' }, empty).ok).toBe(true);
      expect(checkCommandAllowed('user', 'GetDiagnostics', {}, empty).ok).toBe(true);
      expect(checkCommandAllowed('user', 'GetDiagnostics', { location: 'https://evil.example/x' }, empty).ok).toBe(false);
      expect(checkCommandAllowed('user', 'GetDiagnostics', { location: 'x' }, undefined).ok).toBe(false);
    });
  });
});
