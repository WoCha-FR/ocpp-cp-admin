'use strict';

// trad() réel simplifié : lit directement les fichiers de langue (évite de charger la config)
jest.mock('../../src/i18n', () => {
  const fs = require('fs');
  const path = require('path');
  const load = (lng) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '../../locales', `${lng}.json`), 'utf8'));
  return {
    trad: (key, { lng = 'fr' } = {}) =>
      key.split('.').reduce((o, k) => (o ? o[k] : undefined), load(lng)),
  };
});

const { buildTransactionsCsv } = require('../../src/transactionsCsv');
const { formatTariffDetail, normalizeTariffInput, validateTariff } = require('../../src/tariff');

const details = {
  method: 'prorata',
  timezone: 'Europe/Paris',
  segments: [
    { label: 'HP', kwh: 6.2, price: 0.25, amount: 1.55 },
    { label: 'HC', kwh: 12, price: 0.15, amount: 1.8 },
    { label: 'HP', kwh: 1, price: 0.25, amount: 0.25 },
    { label: null, kwh: 1, price: 0.3, amount: 0.3 },
  ],
};

const baseRow = {
  transaction_id: '26012',
  chargepoint_identity: 'CP-1',
  site_name: 'Maison',
  connector_id: 1,
  id_tag: 'TAG123',
  tag_username: 'Alice',
  start_source: 'rfid',
  start_time: '2026-01-12T20:00:00Z',
  stop_time: '2026-01-12T22:00:00Z',
  meter_start: 0,
  meter_stop: 20200,
  status: 'Completed',
  stop_reason: 'Local',
};

const parse = (csv) =>
  csv
    .replace('﻿', '')
    .split('\r\n')
    .map((l) => l.split(';').map((c) => c.replace(/^"|"$/g, '')));

describe('formatTariffDetail', () => {
  it('fusionne les segments de même libellé/prix et utilise le libellé par défaut', () => {
    expect(formatTariffDetail(details, 'Défaut')).toBe(
      'HP 7.20 kWh × 0.2500 = 1.80 | HC 12.00 kWh × 0.1500 = 1.80 | Défaut 1.00 kWh × 0.3000 = 0.30'
    );
  });

  it('accepte une chaîne JSON et tolère les données invalides', () => {
    expect(formatTariffDetail(JSON.stringify(details))).toContain('HP 7.20 kWh');
    expect(formatTariffDetail('pas du json')).toBe('');
    expect(formatTariffDetail(null)).toBe('');
    expect(formatTariffDetail({})).toBe('');
  });

  it("n'utilise pas « ; » (séparateur CSV)", () => {
    expect(formatTariffDetail(details)).not.toContain(';');
  });
});

describe('buildTransactionsCsv', () => {
  it('ajoute les colonnes de coût, avec la colonne utilisateur côté gestionnaire', () => {
    const csv = buildTransactionsCsv(
      [
        {
          ...baseRow,
          cost: 3.9,
          cost_currency: 'EUR',
          cost_details: JSON.stringify(details),
        },
      ],
      { withUser: true, lng: 'fr' }
    );
    const [head, row] = parse(csv);
    expect(head).toEqual([
      'ID Transaction',
      'Borne',
      'Site',
      'Connecteur',
      'Tag',
      'Utilisateur',
      'Source',
      'Début',
      'Fin',
      'Compteur départ (Wh)',
      'Compteur arrivée (Wh)',
      'Énergie (kWh)',
      'Durée (min)',
      'État',
      'Raison arrêt',
      'Coût',
      'Devise',
      'Prix moyen (/kWh)',
      'Détail tarifaire',
    ]);
    expect(row).toHaveLength(head.length);
    expect(row[5]).toBe('Alice');
    expect(row[11]).toBe('20.20');
    expect(row[15]).toBe('3.90');
    expect(row[16]).toBe('EUR');
    expect(row[17]).toBe((3.9 / 20.2).toFixed(4));
    expect(row[18]).toContain('HP 7.20 kWh');
    expect(csv.startsWith('﻿')).toBe(true);
  });

  it("n'a pas de colonne utilisateur côté self-service et suit la langue", () => {
    const csv = buildTransactionsCsv([{ ...baseRow, cost: 1, cost_currency: 'EUR' }], {
      withUser: false,
      lng: 'en',
    });
    const [head, row] = parse(csv);
    expect(head).not.toContain('User');
    expect(head).toContain('Cost');
    expect(head).toContain('Tariff breakdown');
    expect(row).toHaveLength(head.length);
  });

  it("laisse les colonnes de coût vides si la session n'a pas de coût", () => {
    const [head, row] = parse(buildTransactionsCsv([baseRow], { withUser: true }));
    expect(row.slice(15)).toEqual(['', '', '', '']);
    expect(row).toHaveLength(head.length);
  });

  it('pas de prix moyen quand aucune énergie (division par zéro)', () => {
    const [, row] = parse(
      buildTransactionsCsv(
        [{ ...baseRow, meter_stop: 0, cost: 0, cost_currency: 'EUR', cost_details: '{}' }],
        { withUser: true }
      )
    );
    expect(row[15]).toBe('0.00');
    expect(row[17]).toBe('');
  });
});

describe('normalizeTariffInput', () => {
  it('rejette les corps invalides', () => {
    expect(normalizeTariffInput(null)).toBeNull();
    expect(normalizeTariffInput([])).toBeNull();
    expect(normalizeTariffInput('x')).toBeNull();
    expect(normalizeTariffInput({ periods: 'x' })).toBeNull();
  });

  it('nettoie devise, fuseau, prix et jours', () => {
    const t = normalizeTariffInput({
      currency: ' eur ',
      timezone: ' Europe/Paris ',
      default_price_per_kwh: '0.25',
      periods: [
        {
          label: '  HC ',
          days: [5, 1, 1],
          start_time: '22:00',
          end_time: '06:00',
          price_per_kwh: '0.15',
        },
      ],
    });
    expect(t).toEqual({
      currency: 'EUR',
      timezone: 'Europe/Paris',
      default_price_per_kwh: 0.25,
      periods: [
        { label: 'HC', days: '1,5', start_time: '22:00', end_time: '06:00', price_per_kwh: 0.15 },
      ],
    });
    expect(validateTariff(t).valid).toBe(true);
  });

  it('prix par défaut vide = pas de tarification ; prix de tranche vide = invalide', () => {
    const t = normalizeTariffInput({
      currency: 'EUR',
      timezone: 'UTC',
      default_price_per_kwh: '',
      periods: [{ days: '1', start_time: '08:00', end_time: '09:00', price_per_kwh: '' }],
    });
    expect(t.default_price_per_kwh).toBeNull();
    expect(validateTariff(t).errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['ERR_TARIFF_DEFAULT_REQUIRED', 'ERR_TARIFF_PRICE'])
    );
  });

  it('une tranche non-objet ou sans jours est signalée par la validation, sans exception', () => {
    const t = normalizeTariffInput({
      currency: 'EUR',
      timezone: 'UTC',
      default_price_per_kwh: 0.2,
      periods: [null, { start_time: '08:00', end_time: '09:00', price_per_kwh: 1 }],
    });
    const codes = validateTariff(t).errors.map((e) => e.code);
    expect(codes).toContain('ERR_TARIFF_TIME_FORMAT');
    expect(codes).toContain('ERR_TARIFF_DAYS');
  });
});
