'use strict';

const tariffLib = require('../../src/tariff');

const { computeSessionCost, validateTariff, parseTime, parseDays, resolvePrice, normalizePeriods } =
  tariffLib;

const ALL = '1,2,3,4,5,6,7';

const HP_HC = {
  currency: 'EUR',
  timezone: 'Europe/Paris',
  default_price_per_kwh: 0.3,
  periods: [
    { label: 'HP', days: ALL, start_time: '06:00', end_time: '22:00', price_per_kwh: 0.25 },
    { label: 'HC', days: ALL, start_time: '22:00', end_time: '06:00', price_per_kwh: 0.15 },
  ],
};

// 2026-01-12 est un lundi ; Paris = UTC+1 en hiver
describe('tariff — parseTime / parseDays', () => {
  it('parse les heures valides et rejette les autres', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('06:30')).toBe(390);
    expect(parseTime('23:59')).toBe(1439);
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('24:00', true)).toBe(1440);
    expect(parseTime('25:00', true)).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('6:00')).toBeNull();
    expect(parseTime(null)).toBeNull();
  });

  it('parse les jours (tableau ou CSV)', () => {
    expect(parseDays('1,2,3')).toEqual([1, 2, 3]);
    expect(parseDays([7, 1, 1])).toEqual([1, 7]);
    expect(parseDays('')).toBeNull();
    expect(parseDays('0,1')).toBeNull();
    expect(parseDays('8')).toBeNull();
    expect(parseDays('a')).toBeNull();
    expect(parseDays([])).toBeNull();
  });
});

describe('tariff — resolvePrice', () => {
  const periods = normalizePeriods([
    { label: 'HC', days: '1,2,3,4,5', start_time: '22:00', end_time: '06:00', price_per_kwh: 0.15 },
  ]);

  it('rattache la tranche à cheval sur minuit au jour de début', () => {
    // vendredi (5) 23:00 → HC ; samedi (6) 03:00 → HC (début vendredi) ; samedi 23:00 → défaut
    expect(resolvePrice(periods, 5, 23 * 60, 0.3).price).toBe(0.15);
    expect(resolvePrice(periods, 6, 3 * 60, 0.3).price).toBe(0.15);
    expect(resolvePrice(periods, 6, 23 * 60, 0.3).price).toBe(0.3);
    // lundi 03:00 : la veille (dimanche) n'est pas dans la tranche → défaut
    expect(resolvePrice(periods, 1, 3 * 60, 0.3).price).toBe(0.3);
  });
});

describe('tariff — computeSessionCost', () => {
  it('retourne null sans tarif ou sans prix par défaut', () => {
    const base = {
      startTime: '2026-01-12T10:00:00Z',
      stopTime: '2026-01-12T11:00:00Z',
      totalKwh: 5,
    };
    expect(computeSessionCost({ ...base, tariff: null })).toBeNull();
    expect(
      computeSessionCost({
        ...base,
        tariff: { currency: 'EUR', timezone: 'UTC', default_price_per_kwh: null, periods: [] },
      })
    ).toBeNull();
  });

  it('retourne null si énergie ou dates invalides', () => {
    const tariff = { currency: 'EUR', timezone: 'UTC', default_price_per_kwh: 0.2, periods: [] };
    expect(
      computeSessionCost({
        startTime: 'x',
        stopTime: '2026-01-12T11:00:00Z',
        totalKwh: 5,
        tariff,
      })
    ).toBeNull();
    expect(
      computeSessionCost({
        startTime: '2026-01-12T10:00:00Z',
        stopTime: '2026-01-12T11:00:00Z',
        totalKwh: NaN,
        tariff,
      })
    ).toBeNull();
  });

  it('applique le prix par défaut sans tranche (repli prorata)', () => {
    const r = computeSessionCost({
      startTime: '2026-01-12T10:00:00Z',
      stopTime: '2026-01-12T12:00:00Z',
      totalKwh: 10,
      tariff: { currency: 'EUR', timezone: 'UTC', default_price_per_kwh: 0.2, periods: [] },
    });
    expect(r.cost).toBe(2);
    expect(r.currency).toBe('EUR');
    expect(r.details.method).toBe('prorata');
    expect(r.details.segments).toHaveLength(1);
    expect(r.details.segments[0]).toMatchObject({ kwh: 10, price: 0.2, amount: 2, label: null });
  });

  it('découpe une session à cheval sur deux tranches HP/HC (prorata durée)', () => {
    // 21:00 → 23:00 locales, 10 kWh : 5 kWh HP + 5 kWh HC
    const r = computeSessionCost({
      startTime: '2026-01-12T20:00:00Z',
      stopTime: '2026-01-12T22:00:00Z',
      totalKwh: 10,
      tariff: HP_HC,
    });
    expect(r.cost).toBe(2);
    expect(r.details.segments).toHaveLength(2);
    expect(r.details.segments[0]).toMatchObject({ label: 'HP', kwh: 5, price: 0.25 });
    expect(r.details.segments[1]).toMatchObject({ label: 'HC', kwh: 5, price: 0.15 });
  });

  it('utilise les MeterValues quand ils existent (courbe non linéaire)', () => {
    const startUnix = Date.parse('2026-01-12T20:00:00Z') / 1000;
    const r = computeSessionCost({
      startTime: '2026-01-12T20:00:00Z',
      stopTime: '2026-01-12T22:00:00Z',
      totalKwh: 10,
      // 9 kWh déjà délivrés à 21:30 locales
      points: [{ x: startUnix + 1800, energy: 9000 }],
      tariff: HP_HC,
    });
    expect(r.details.method).toBe('meter');
    const hp = r.details.segments.find((s) => s.label === 'HP');
    const hc = r.details.segments.find((s) => s.label === 'HC');
    expect(hp.kwh).toBeCloseTo(9 + 1 / 3, 5);
    expect(hc.kwh).toBeCloseTo(2 / 3, 5);
    expect(r.cost).toBe(2.43);
    expect(r.cost).not.toBe(2); // le prorata donnerait un autre total
  });

  it('applique le prix par défaut aux heures non couvertes', () => {
    const tariff = {
      ...HP_HC,
      periods: [
        { label: 'HC', days: ALL, start_time: '22:00', end_time: '06:00', price_per_kwh: 0.15 },
      ],
    };
    // 10:00 → 12:00 locales : hors HC → 0.30
    const r = computeSessionCost({
      startTime: '2026-01-12T09:00:00Z',
      stopTime: '2026-01-12T11:00:00Z',
      totalKwh: 4,
      tariff,
    });
    expect(r.cost).toBe(1.2);
    expect(r.details.segments[0].label).toBeNull();
  });

  it('fusionne les segments consécutifs de même prix à travers minuit', () => {
    // 23:00 → 05:00 locales, tout en HC : un seul segment
    const r = computeSessionCost({
      startTime: '2026-01-12T22:00:00Z',
      stopTime: '2026-01-13T04:00:00Z',
      totalKwh: 12,
      tariff: HP_HC,
    });
    expect(r.details.segments).toHaveLength(1);
    expect(r.details.segments[0]).toMatchObject({ label: 'HC', kwh: 12 });
    expect(r.cost).toBe(1.8);
  });

  describe('tarifs par jour de semaine', () => {
    const tariff = {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      default_price_per_kwh: 0.25,
      periods: [
        {
          label: 'HC',
          days: '1,2,3,4,5',
          start_time: '22:00',
          end_time: '06:00',
          price_per_kwh: 0.15,
        },
        { label: 'WE', days: '6,7', start_time: '06:00', end_time: '24:00', price_per_kwh: 0.1 },
      ],
    };

    it('bascule de règle du vendredi soir au samedi matin', () => {
      // vendredi 2026-01-16 23:00 → samedi 07:00 locales, 8 kWh (1 kWh/h)
      const r = computeSessionCost({
        startTime: '2026-01-16T22:00:00Z',
        stopTime: '2026-01-17T06:00:00Z',
        totalKwh: 8,
        tariff,
      });
      // vendredi 23:00 → samedi 06:00 : HC (7 kWh) ; samedi 06:00 → 07:00 : WE (1 kWh)
      expect(r.details.segments).toHaveLength(2);
      expect(r.details.segments[0]).toMatchObject({ label: 'HC', kwh: 7 });
      expect(r.details.segments[1]).toMatchObject({ label: 'WE', kwh: 1 });
      expect(r.cost).toBe(1.15);
    });

    it('un jour sans tranche applicable retombe sur le prix par défaut', () => {
      // dimanche 2026-01-18 02:00 → 03:00 locales : la veille (samedi) n'a pas de HC
      const r = computeSessionCost({
        startTime: '2026-01-18T01:00:00Z',
        stopTime: '2026-01-18T02:00:00Z',
        totalKwh: 1,
        tariff,
      });
      expect(r.cost).toBe(0.25);
    });

    it('applique HC en semaine et le tarif WE le samedi soir', () => {
      const session = (day) => ({
        startTime: `2026-01-${day}T22:00:00Z`, // 23:00 locales
        stopTime: `2026-01-${day}T22:30:00Z`,
        totalKwh: 2,
        tariff,
      });
      expect(computeSessionCost(session(12)).cost).toBe(0.3); // lundi : HC 0.15
      expect(computeSessionCost(session(17)).cost).toBe(0.2); // samedi 23:00 : WE 0.10
    });
  });

  it('prend en compte le fuseau horaire du site', () => {
    const base = {
      startTime: '2026-01-12T05:00:00Z',
      stopTime: '2026-01-12T06:00:00Z',
      totalKwh: 10,
    };
    // Paris : 06:00 → 07:00 locales = HP (0.25)
    const paris = computeSessionCost({ ...base, tariff: HP_HC });
    expect(paris.cost).toBe(2.5);
    // UTC : 05:00 → 06:00 = HC (0.15)
    const utc = computeSessionCost({ ...base, tariff: { ...HP_HC, timezone: 'UTC' } });
    expect(utc.cost).toBe(1.5);
  });

  it("gère le changement d'heure (passage à l'heure d'été)", () => {
    // 2026-03-29 : à 01:00Z, Paris passe de 02:00 CET à 03:00 CEST
    const tariff = {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      default_price_per_kwh: 0.3,
      periods: [
        { label: 'N', days: ALL, start_time: '00:00', end_time: '03:00', price_per_kwh: 0.1 },
      ],
    };
    const r = computeSessionCost({
      startTime: '2026-03-29T00:30:00Z', // 01:30 CET
      stopTime: '2026-03-29T02:30:00Z', // 04:30 CEST
      totalKwh: 4,
      tariff,
    });
    // 00:30Z → 01:00Z dans la tranche (1 kWh à 0.10), le reste au défaut (3 kWh à 0.30)
    expect(r.cost).toBe(1);
  });

  it("gère le changement d'heure (retour à l'heure d'hiver)", () => {
    // 2026-10-25 : à 01:00Z, Paris passe de 03:00 CEST à 02:00 CET
    const tariff = {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      default_price_per_kwh: 0.3,
      periods: [
        { label: 'N', days: ALL, start_time: '00:00', end_time: '03:00', price_per_kwh: 0.1 },
      ],
    };
    const r = computeSessionCost({
      startTime: '2026-10-25T00:00:00Z', // 02:00 CEST
      stopTime: '2026-10-25T03:00:00Z', // 04:00 CET
      totalKwh: 6,
      tariff,
    });
    // 00:00Z → 02:00Z toujours avant 03:00 locales (4 kWh à 0.10), puis 2 kWh à 0.30
    expect(r.cost).toBe(1);
  });

  it('borne les points non monotones ou hors session', () => {
    const startUnix = Date.parse('2026-01-12T10:00:00Z') / 1000;
    const r = computeSessionCost({
      startTime: '2026-01-12T10:00:00Z',
      stopTime: '2026-01-12T12:00:00Z',
      totalKwh: 10,
      points: [
        { x: startUnix + 3600, energy: 8000 },
        { x: startUnix + 5400, energy: 2000 }, // en recul → ramené à 8 kWh
        { x: startUnix - 100, energy: 500 }, // avant le début → ignoré
        { x: startUnix + 99999, energy: 9999 }, // après la fin → ignoré
        { x: 'abc', energy: 1 }, // invalide → ignoré
      ],
      tariff: { currency: 'EUR', timezone: 'UTC', default_price_per_kwh: 1, periods: [] },
    });
    expect(r.cost).toBe(10);
    expect(r.details.segments.every((s) => s.kwh >= 0)).toBe(true);
  });

  it('session sans énergie : coût 0 et aucun segment', () => {
    const r = computeSessionCost({
      startTime: '2026-01-12T10:00:00Z',
      stopTime: '2026-01-12T11:00:00Z',
      totalKwh: 0,
      tariff: HP_HC,
    });
    expect(r.cost).toBe(0);
    expect(r.details.segments).toEqual([]);
  });

  it("session instantanée : toute l'énergie au prix de l'instant", () => {
    const r = computeSessionCost({
      startTime: '2026-01-12T10:00:00Z',
      stopTime: '2026-01-12T10:00:00Z',
      totalKwh: 2,
      tariff: HP_HC,
    });
    expect(r.cost).toBe(0.5);
  });
});

describe('tariff — validateTariff', () => {
  const valid = () => ({ ...HP_HC, periods: HP_HC.periods.map((p) => ({ ...p })) });
  const codes = (t) => validateTariff(t).errors.map((e) => e.code);

  it('accepte une grille valide (y compris tranche à cheval sur minuit)', () => {
    expect(validateTariff(valid())).toEqual({ valid: true, errors: [] });
  });

  it('accepte une grille sans tranche avec seulement un prix par défaut', () => {
    expect(
      validateTariff({ currency: 'EUR', timezone: 'UTC', default_price_per_kwh: 0.2, periods: [] })
        .valid
    ).toBe(true);
  });

  it('rejette devise et fuseau invalides', () => {
    expect(codes({ ...valid(), currency: 'euro' })).toContain('ERR_TARIFF_CURRENCY');
    expect(codes({ ...valid(), timezone: 'Mars/Phobos' })).toContain('ERR_TARIFF_TIMEZONE');
  });

  it('rejette les prix négatifs ou invalides', () => {
    expect(codes({ ...valid(), default_price_per_kwh: -1 })).toContain('ERR_TARIFF_PRICE');
    const t = valid();
    t.periods[0].price_per_kwh = 'abc';
    expect(codes(t)).toContain('ERR_TARIFF_PRICE');
  });

  it("exige un prix par défaut dès qu'il y a des tranches", () => {
    expect(codes({ ...valid(), default_price_per_kwh: null })).toContain(
      'ERR_TARIFF_DEFAULT_REQUIRED'
    );
  });

  it('rejette formats horaires invalides et tranche vide', () => {
    const t = valid();
    t.periods[0].start_time = '25:00';
    expect(codes(t)).toContain('ERR_TARIFF_TIME_FORMAT');
    const t2 = valid();
    t2.periods[0].end_time = '06:00';
    expect(codes(t2)).toContain('ERR_TARIFF_TIME_EMPTY');
    const t3 = valid();
    t3.periods[0].start_time = '24:00';
    expect(codes(t3)).toContain('ERR_TARIFF_TIME_FORMAT');
  });

  it('rejette des jours invalides', () => {
    const t = valid();
    t.periods[0].days = '';
    expect(codes(t)).toContain('ERR_TARIFF_DAYS');
    const t2 = valid();
    t2.periods[0].days = '1,9';
    expect(codes(t2)).toContain('ERR_TARIFF_DAYS');
  });

  it('détecte les chevauchements le même jour', () => {
    const t = valid();
    t.periods[1] = {
      label: 'X',
      days: ALL,
      start_time: '20:00',
      end_time: '23:00',
      price_per_kwh: 0.2,
    };
    expect(codes(t)).toContain('ERR_TARIFF_OVERLAP');
  });

  it('détecte le chevauchement dû au report après minuit sur le jour suivant', () => {
    const t = {
      currency: 'EUR',
      timezone: 'UTC',
      default_price_per_kwh: 0.3,
      periods: [
        { days: '5', start_time: '22:00', end_time: '06:00', price_per_kwh: 0.15 },
        { days: '6', start_time: '00:00', end_time: '24:00', price_per_kwh: 0.1 },
      ],
    };
    expect(codes(t)).toContain('ERR_TARIFF_OVERLAP');
    // en commençant à 06:00 le samedi, plus de chevauchement
    t.periods[1].start_time = '06:00';
    expect(validateTariff(t).valid).toBe(true);
  });

  it('détecte le chevauchement avec rebouclage dimanche → lundi', () => {
    const t = {
      currency: 'EUR',
      timezone: 'UTC',
      default_price_per_kwh: 0.3,
      periods: [
        { days: '7', start_time: '22:00', end_time: '06:00', price_per_kwh: 0.15 },
        { days: '1', start_time: '04:00', end_time: '08:00', price_per_kwh: 0.1 },
      ],
    };
    expect(codes(t)).toContain('ERR_TARIFF_OVERLAP');
  });

  it('autorise des tranches identiques sur des jours disjoints', () => {
    const t = {
      currency: 'EUR',
      timezone: 'UTC',
      default_price_per_kwh: 0.3,
      periods: [
        { days: '1,2,3,4,5', start_time: '08:00', end_time: '18:00', price_per_kwh: 0.25 },
        { days: '6,7', start_time: '08:00', end_time: '18:00', price_per_kwh: 0.1 },
      ],
    };
    expect(validateTariff(t).valid).toBe(true);
  });
});
