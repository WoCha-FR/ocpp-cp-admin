'use strict';

const {
  mapPurpose,
  toIsoDateTime,
  normalizeProfileInput,
  buildSetChargingProfileParams,
} = require('../../src/chargingProfiles');

const NOW = new Date('2026-11-22T15:42:10.500Z');
const base = (over = {}) => ({
  connector_id: 0,
  stack_level: 3,
  profile_purpose: 'TxDefaultProfile',
  profile_kind: 'Absolute',
  charging_rate_unit: 'A',
  schedule_periods: [{ startPeriod: 0, limit: 16 }, { startPeriod: 3600, limit: 8, numberPhases: 3 }],
  ...over,
});

describe('chargingProfiles — mapPurpose', () => {
  it('2.0.1 : ChargePointMaxProfile → ChargingStationMaxProfile', () => {
    expect(mapPurpose('2.0.1', 'ChargePointMaxProfile')).toBe('ChargingStationMaxProfile');
    expect(mapPurpose('2.0.1', 'TxDefaultProfile')).toBe('TxDefaultProfile');
  });
  it('1.6 : ChargingStationMaxProfile → ChargePointMaxProfile', () => {
    expect(mapPurpose('1.6', 'ChargingStationMaxProfile')).toBe('ChargePointMaxProfile');
    expect(mapPurpose('1.6', 'ChargePointMaxProfile')).toBe('ChargePointMaxProfile');
    expect(mapPurpose('1.6', 'TxDefaultProfile')).toBe('TxDefaultProfile');
  });
  it('valeur vide inchangée', () => {
    expect(mapPurpose('1.6', undefined)).toBeUndefined();
  });
});

describe('chargingProfiles — toIsoDateTime', () => {
  it('date seule → date-time UTC', () => {
    expect(toIsoDateTime('2026-12-31')).toBe('2026-12-31T00:00:00Z');
  });
  it('supprime les millisecondes et normalise le fuseau', () => {
    expect(toIsoDateTime('2026-11-22T10:00:00.123Z')).toBe('2026-11-22T10:00:00Z');
    expect(toIsoDateTime('2026-11-22T12:00:00+02:00')).toBe('2026-11-22T10:00:00Z');
  });
  it('vide / illisible : inchangé', () => {
    expect(toIsoDateTime(null)).toBeNull();
    expect(toIsoDateTime('')).toBe('');
    expect(toIsoDateTime('pas une date')).toBe('pas une date');
  });
});

describe('chargingProfiles — normalizeProfileInput', () => {
  it('profil Max sur un connecteur ≠ 0 : refusé', () => {
    for (const purpose of ['ChargePointMaxProfile', 'ChargingStationMaxProfile']) {
      expect(
        normalizeProfileInput(base({ profile_purpose: purpose, connector_id: 2 }), NOW)
      ).toEqual({ error: 'VALIDATION_MAX_PROFILE_CONNECTOR' });
    }
  });
  it('profil Max sur le connecteur 0 : accepté ; TxDefaultProfile sur un connecteur : accepté', () => {
    expect(normalizeProfileInput(base({ profile_purpose: 'ChargePointMaxProfile' }), NOW).value).toBeDefined();
    expect(normalizeProfileInput(base({ connector_id: 2 }), NOW).value.connector_id).toBe(2);
  });
  it('Recurring sans recurrency_kind : refusé', () => {
    expect(normalizeProfileInput(base({ profile_kind: 'Recurring' }), NOW)).toEqual({
      error: 'VALIDATION_RECURRENCY_KIND',
    });
  });
  it('recurrency_kind ignoré pour un profil non Recurring', () => {
    expect(normalizeProfileInput(base({ recurrency_kind: 'Daily' }), NOW).value.recurrency_kind).toBeNull();
  });

  describe('startSchedule', () => {
    it('Absolute sans valeur : début de validité', () => {
      const { value } = normalizeProfileInput(base({ valid_from: '2026-12-01T08:00:00Z' }), NOW);
      expect(value.schedule.startSchedule).toBe('2026-12-01T08:00:00Z');
    });
    it('Absolute sans valeur ni validité : maintenant', () => {
      const { value } = normalizeProfileInput(base(), NOW);
      expect(value.schedule.startSchedule).toBe('2026-11-22T15:42:10Z');
    });
    it('Recurring sans valeur : minuit UTC du jour', () => {
      const { value } = normalizeProfileInput(
        base({ profile_kind: 'Recurring', recurrency_kind: 'Daily' }),
        NOW
      );
      expect(value.schedule.startSchedule).toBe('2026-11-22T00:00:00Z');
    });
    it('valeur explicite conservée (normalisée)', () => {
      const { value } = normalizeProfileInput(base({ start_schedule: '2026-11-16' }), NOW);
      expect(value.schedule.startSchedule).toBe('2026-11-16T00:00:00Z');
    });
    it('Relative : jamais de startSchedule', () => {
      const { value } = normalizeProfileInput(
        base({ profile_kind: 'Relative', start_schedule: '2026-11-16' }),
        NOW
      );
      expect(value.schedule.startSchedule).toBeUndefined();
    });
  });

  it('construit le calendrier (unité, périodes, numberPhases facultatif) et normalise les dates', () => {
    const { value } = normalizeProfileInput(
      base({ valid_from: '2026-12-01', valid_to: '2027-01-01T00:00:00.000Z' }),
      NOW
    );
    expect(value.valid_from).toBe('2026-12-01T00:00:00Z');
    expect(value.valid_to).toBe('2027-01-01T00:00:00Z');
    expect(value.schedule.chargingRateUnit).toBe('A');
    expect(value.schedule.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 16 },
      { startPeriod: 3600, limit: 8, numberPhases: 3 },
    ]);
  });
});

describe('chargingProfiles — buildSetChargingProfileParams', () => {
  const row = (over = {}) => ({
    profile_id: 7,
    connector_id: 1,
    stack_level: 2,
    profile_purpose: 'ChargePointMaxProfile',
    profile_kind: 'Absolute',
    recurrency_kind: null,
    valid_from: '2026-12-01T00:00:00Z',
    valid_to: null,
    schedule: {
      chargingRateUnit: 'W',
      startSchedule: '2026-12-01T00:00:00Z',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 7400 }],
    },
    ...over,
  });

  it('1.6 : connectorId + csChargingProfiles, purpose 1.6', () => {
    const params = buildSetChargingProfileParams('1.6', row({ profile_purpose: 'ChargingStationMaxProfile' }));
    expect(params).toEqual({
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 7,
        stackLevel: 2,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: row().schedule,
        validFrom: '2026-12-01T00:00:00Z',
      },
    });
  });

  it('2.0.1 : evseId + chargingProfile (id, schedule[]), purpose renommé', () => {
    const params = buildSetChargingProfileParams('2.0.1', row());
    expect(params.evseId).toBe(1);
    expect(params.chargingProfile).toEqual({
      id: 7,
      stackLevel: 2,
      chargingProfilePurpose: 'ChargingStationMaxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: [{ id: 1, ...row().schedule }],
      validFrom: '2026-12-01T00:00:00Z',
    });
  });

  it('2.0.1 : evse_id prioritaire sur connector_id', () => {
    expect(buildSetChargingProfileParams('2.0.1', row({ evse_id: 2 })).evseId).toBe(2);
  });

  it('recurrencyKind seulement pour un profil Recurring', () => {
    const rec = buildSetChargingProfileParams('1.6', row({ profile_kind: 'Recurring', recurrency_kind: 'Daily' }));
    expect(rec.csChargingProfiles.recurrencyKind).toBe('Daily');
    const abs = buildSetChargingProfileParams('1.6', row({ recurrency_kind: 'Daily' }));
    expect(abs.csChargingProfiles.recurrencyKind).toBeUndefined();
  });

  it('Relative : startSchedule retiré même s\'il est stocké', () => {
    const p = buildSetChargingProfileParams('1.6', row({ profile_kind: 'Relative' }));
    expect(p.csChargingProfiles.chargingSchedule.startSchedule).toBeUndefined();
  });

  it('ne modifie pas le calendrier source', () => {
    const r = row({ profile_kind: 'Relative' });
    buildSetChargingProfileParams('2.0.1', r);
    expect(r.schedule.startSchedule).toBe('2026-12-01T00:00:00Z');
  });

  it('ancien profil sans startSchedule : renvoyé tel quel (pas d\'ancrage inventé)', () => {
    const r = row();
    delete r.schedule.startSchedule;
    expect(buildSetChargingProfileParams('1.6', r).csChargingProfiles.chargingSchedule.startSchedule).toBeUndefined();
  });
});
