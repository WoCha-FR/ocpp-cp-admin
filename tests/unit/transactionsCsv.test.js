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

const { buildTransactionsCsv, buildReimbursementCsv, csvCell } = require('../../src/transactionsCsv');
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
  tag_category: 'pro',
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
      'Catégorie',
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
    expect(row[5]).toBe('Professionnel');
    expect(row[6]).toBe('Alice');
    expect(row[12]).toBe('20.20');
    expect(row[16]).toBe('3.90');
    expect(row[17]).toBe('EUR');
    expect(row[18]).toBe((3.9 / 20.2).toFixed(4));
    expect(row[19]).toContain('HP 7.20 kWh');
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
    expect(row.slice(16)).toEqual(['', '', '', '']);
    expect(row).toHaveLength(head.length);
  });

  it('pas de prix moyen quand aucune énergie (division par zéro)', () => {
    const [, row] = parse(
      buildTransactionsCsv(
        [{ ...baseRow, meter_stop: 0, cost: 0, cost_currency: 'EUR', cost_details: '{}' }],
        { withUser: true }
      )
    );
    expect(row[16]).toBe('0.00');
    expect(row[18]).toBe('');
  });

  it('laisse la catégorie vide si le badge est inconnu', () => {
    const [, row] = parse(buildTransactionsCsv([{ ...baseRow, tag_category: null }]));
    expect(row[5]).toBe('');
  });

  it('ajoute une ligne de total (kWh + coût par devise) avec withTotal', () => {
    const csv = buildTransactionsCsv(
      [
        { ...baseRow, cost: 3.9, cost_currency: 'EUR' },
        { ...baseRow, meter_stop: 10000, cost: 2.1, cost_currency: 'EUR' },
        { ...baseRow, meter_stop: 5000, cost: 1, cost_currency: 'CHF' },
      ],
      { withTotal: true }
    );
    const rows = parse(csv);
    const head = rows[0];
    const totals = rows.slice(4);
    expect(totals).toHaveLength(2);
    const col = (name) => head.indexOf(name);
    expect(totals[0][0]).toBe('Total');
    expect(totals[0][col('Énergie (kWh)')]).toBe('35.20');
    expect(totals[0][col('Coût')]).toBe('6.00');
    expect(totals[0][col('Devise')]).toBe('EUR');
    expect(totals[1][col('Énergie (kWh)')]).toBe('');
    expect(totals[1][col('Coût')]).toBe('1.00');
    expect(totals[1][col('Devise')]).toBe('CHF');
  });

  it("la ligne de total n'a pas de coût quand aucune session n'est tarifée", () => {
    const rows = parse(buildTransactionsCsv([baseRow], { withTotal: true }));
    const total = rows[2];
    expect(total[0]).toBe('Total');
    expect(total[rows[0].indexOf('Coût')]).toBe('');
    expect(total[rows[0].indexOf('Énergie (kWh)')]).toBe('20.20');
  });

  it('pas de ligne de total par défaut', () => {
    expect(parse(buildTransactionsCsv([baseRow]))).toHaveLength(2);
  });
});

describe('buildReimbursementCsv', () => {
  const rows = [
    {
      site_id: 1,
      site_name: 'Siège',
      user_id: 5,
      user_name: 'Alice',
      category: 'pro',
      sessions: 2,
      energy_kwh: 30.5,
      cost: 6.1,
      currency: 'EUR',
    },
    {
      site_id: 1,
      site_name: 'Siège',
      user_id: 6,
      user_name: 'Bob',
      category: 'pro',
      sessions: 1,
      energy_kwh: 10,
      cost: 2,
      currency: 'EUR',
    },
    {
      site_id: 2,
      site_name: 'Domicile',
      user_id: 5,
      user_name: 'Alice',
      category: 'pro',
      sessions: 3,
      energy_kwh: 12,
      cost: null,
      currency: null,
    },
  ];

  it('agrège par site avec un total par site', () => {
    const out = parse(buildReimbursementCsv(rows, { lng: 'fr' }));
    expect(out[0]).toEqual([
      'Site',
      'Utilisateur',
      'Catégorie',
      'Sessions',
      'Énergie (kWh)',
      'Coût',
      'Devise',
    ]);
    expect(out[1]).toEqual(['Siège', 'Alice', 'Professionnel', '2', '30.50', '6.10', 'EUR']);
    expect(out[3]).toEqual(['Total Siège', '', '', '3', '40.50', '8.10', 'EUR']);
    expect(out[4]).toEqual(['Domicile', 'Alice', 'Professionnel', '3', '12.00', '', '']);
    expect(out[5]).toEqual(['Total Domicile', '', '', '3', '12.00', '', '']);
    expect(out).toHaveLength(6);
  });

  it('suit la langue et gère un rapport vide', () => {
    const out = parse(buildReimbursementCsv([], { lng: 'en' }));
    expect(out).toEqual([
      ['Site', 'User', 'Category', 'Sessions', 'Energy (kWh)', 'Cost', 'Currency'],
    ]);
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

describe('M10 — neutralisation des formules (injection CSV)', () => {
  it.each(['=HYPERLINK("http://x","clic")', '+1+cmd|calc', '-2+3', '@SUM(A1:A2)', '\t=1', '\r=1'])(
    'préfixe %p d’une apostrophe',
    (value) => {
      const c = csvCell(value);
      expect(c.startsWith(`"'`)).toBe(true);
    }
  );

  it.each([['-1.50'], ['-3'], ['+2'], ['12'], ['TAG123'], [''], ['Maison']])(
    'laisse intact %p (nombre ou texte ordinaire)',
    (value) => {
      expect(csvCell(value)).toBe(`"${value}"`);
    }
  );

  it('garde le doublement des guillemets et la neutralisation du « ; »', () => {
    expect(csvCell('=A1;"x"')).toBe(`"'=A1,""x"""`);
  });

  it('null / undefined → cellule vide', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('export transactions : badge (renvoyé par une borne) et utilisateur neutralisés', () => {
    const csv = buildTransactionsCsv(
      [{ ...baseRow, id_tag: '=cmd|calc', tag_username: '@evil' }],
      { withUser: true, lng: 'fr' }
    );
    const [, row] = parse(csv);
    expect(row).toContain("'=cmd|calc");
    expect(row).toContain("'@evil");
  });

  it('export remboursement : nom de site et utilisateur neutralisés', () => {
    const csv = buildReimbursementCsv(
      [
        {
          site_id: 1,
          site_name: '=Site',
          user_name: '+Bob',
          category: 'pro',
          sessions: 1,
          energy_kwh: 2,
          cost: 1,
          currency: 'EUR',
        },
      ],
      { lng: 'fr' }
    );
    const [, row] = parse(csv);
    expect(row[0]).toBe("'=Site");
    expect(row[1]).toBe("'+Bob");
  });
});
