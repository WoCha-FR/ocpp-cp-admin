const { trad } = require('./i18n');
const { formatTariffDetail } = require('./tariff');

// Cellule CSV : guillemets doublés, « ; » neutralisé, et formules neutralisées (injection CSV,
// CWE-1236). Excel / LibreOffice interprètent comme une formule une cellule commençant par
// = + - @ (ou tabulation / retour chariot), même entre guillemets : badge renvoyé par une borne,
// nom d'utilisateur, action OCPP… → préfixe « ' ». Les nombres (ex. -1.50) restent des nombres.
const FORMULA_START = /^[=+\-@\t\r]/;
const isNumber = (s) => s.trim() !== '' && Number.isFinite(Number(s));
function csvCell(v) {
  let s = String(v ?? '');
  if (FORMULA_START.test(s) && !isNumber(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""').replace(/;/g, ',')}"`;
}
const cell = csvCell;

/**
 * Construit le CSV d'export des transactions (vue gestionnaire ou utilisateur).
 * @param {Array} transactions lignes issues de db.getTransactions / db.getUserTransactions
 * @param {{withUser: boolean, withTotal: boolean, lng: string}} opts withUser ajoute la colonne
 *   « Utilisateur », withTotal ajoute en fin de fichier une ligne de total (kWh + coût par devise)
 * @returns {string} contenu CSV (BOM UTF-8, séparateur « ; », fins de ligne CRLF)
 */
function buildTransactionsCsv(
  transactions,
  { withUser = false, withTotal = false, lng = 'fr' } = {}
) {
  const h = (key) => trad(`csvExportTitle.${key}`, { lng });
  const headers = [
    h('transaction_id'),
    h('chargepoint'),
    h('site'),
    h('connector'),
    h('tag'),
    h('category'),
    ...(withUser ? [h('user')] : []),
    h('source'),
    h('start'),
    h('end'),
    h('meter_start'),
    h('meter_stop'),
    h('energy'),
    h('duration'),
    h('status'),
    h('stop_reason'),
    h('cost'),
    h('currency'),
    h('average_price'),
    h('tariff_detail'),
  ];
  const defaultLabel = h('default_rate');
  const csvRows = [headers.join(';')];
  let totalKwh = 0;
  const totalCost = new Map();

  for (const t of transactions) {
    const energyKwh =
      t.meter_stop != null && t.meter_start != null ? (t.meter_stop - t.meter_start) / 1000 : null;
    let duration = '';
    if (t.start_time && t.stop_time) {
      const diffMs = new Date(t.stop_time) - new Date(t.start_time);
      duration = (diffMs / 60000).toFixed(1);
    }
    const hasCost = t.cost != null;
    if (energyKwh !== null) totalKwh += energyKwh;
    if (hasCost) {
      const cur = t.cost_currency || '';
      totalCost.set(cur, (totalCost.get(cur) || 0) + t.cost);
    }
    const row = [
      t.transaction_id,
      t.chargepoint_identity || '',
      t.site_name || '',
      t.connector_id,
      t.id_tag || '',
      t.tag_category ? trad(`csvExportTitle.category_${t.tag_category}`, { lng }) : '',
      ...(withUser ? [t.tag_username || ''] : []),
      t.start_source || '',
      t.start_time || '',
      t.stop_time || '',
      t.meter_start != null ? t.meter_start : '',
      t.meter_stop != null ? t.meter_stop : '',
      energyKwh !== null ? energyKwh.toFixed(2) : '',
      duration,
      t.status || '',
      t.stop_reason || '',
      hasCost ? Number(t.cost).toFixed(2) : '',
      hasCost ? t.cost_currency || '' : '',
      hasCost && energyKwh > 0 ? (t.cost / energyKwh).toFixed(4) : '',
      hasCost ? formatTariffDetail(t.cost_details, defaultLabel) : '',
    ].map(cell);
    csvRows.push(row.join(';'));
  }

  if (withTotal) {
    const idx = (key) => headers.indexOf(h(key));
    const currencies = totalCost.size > 0 ? [...totalCost.entries()] : [[null, null]];
    currencies.forEach(([currency, cost], i) => {
      const row = headers.map(() => '');
      row[0] = h('total');
      if (i === 0) row[idx('energy')] = totalKwh.toFixed(2);
      if (cost !== null) {
        row[idx('cost')] = cost.toFixed(2);
        row[idx('currency')] = currency;
      }
      csvRows.push(row.map(cell).join(';'));
    });
  }

  return '\uFEFF' + csvRows.join('\r\n');
}

/**
 * Construit le CSV « remboursement » : une ligne par site, salarié et devise, suivie d'une
 * ligne de total par site (et par devise).
 * @param {Array} rows lignes issues de db.getReimbursementReport (triées par site puis salarié)
 * @param {{lng: string, adjustments: Array}} opts adjustments : lignes de
 *   db.getReimbursementAdjustments, ajoutées dans une section « Régularisations » (corrections
 *   saisies pendant la période sur des sessions antérieures, déjà exportées)
 * @returns {string} contenu CSV (BOM UTF-8, séparateur « ; », fins de ligne CRLF)
 */
function buildReimbursementCsv(rows, { lng = 'fr', adjustments = [] } = {}) {
  const h = (key) => trad(`csvExportTitle.${key}`, { lng });
  const headers = [
    h('site'),
    h('user'),
    h('category'),
    h('sessions'),
    h('energy'),
    h('cost'),
    h('currency'),
  ];
  const csvRows = [headers.join(';')];
  const fmtCost = (v) => (v != null ? Number(v).toFixed(2) : '');

  // Regroupe par site en conservant l'ordre
  const bySite = new Map();
  for (const r of rows) {
    if (!bySite.has(r.site_id)) bySite.set(r.site_id, []);
    bySite.get(r.site_id).push(r);
  }

  for (const siteRows of bySite.values()) {
    const siteName = siteRows[0].site_name || '';
    let sessions = 0;
    let energy = 0;
    const costs = new Map();
    for (const r of siteRows) {
      csvRows.push(
        [
          siteName,
          r.user_name || '',
          r.category ? h(`category_${r.category}`) : '',
          r.sessions,
          Number(r.energy_kwh).toFixed(2),
          fmtCost(r.cost),
          r.cost != null ? r.currency || '' : '',
        ]
          .map(cell)
          .join(';')
      );
      sessions += r.sessions;
      energy += r.energy_kwh;
      if (r.cost != null) {
        const cur = r.currency || '';
        costs.set(cur, (costs.get(cur) || 0) + r.cost);
      }
    }
    const totals = costs.size > 0 ? [...costs.entries()] : [[null, null]];
    totals.forEach(([currency, cost], i) => {
      csvRows.push(
        [
          `${h('total')} ${siteName}`.trim(),
          '',
          '',
          i === 0 ? sessions : '',
          i === 0 ? energy.toFixed(2) : '',
          fmtCost(cost),
          cost !== null ? currency : '',
        ]
          .map(cell)
          .join(';')
      );
    });
  }

  if (adjustments.length > 0) {
    csvRows.push('', cell(h('adjustments_title')));
    csvRows.push(
      [
        h('site'),
        h('user'),
        h('category'),
        h('session_start'),
        h('transaction_id'),
        h('adjustment_kind'),
        h('adjustment_reason'),
        h('adjustment_date'),
        h('energy'),
        h('cost'),
        h('currency'),
      ].join(';')
    );
    const totals = new Map();
    for (const a of adjustments) {
      csvRows.push(
        [
          a.site_name || '',
          a.user_name || '',
          a.category ? h(`category_${a.category}`) : '',
          a.start_time || '',
          a.transaction_id ?? '',
          h(`adjustment_${a.kind}`),
          a.reason || '',
          a.created_at || '',
          Number(a.energy_kwh || 0).toFixed(2),
          fmtCost(a.cost),
          a.cost != null ? a.currency || '' : '',
        ]
          .map(cell)
          .join(';')
      );
      if (a.cost != null) {
        const cur = a.currency || '';
        totals.set(cur, (totals.get(cur) || 0) + a.cost);
      }
    }
    for (const [currency, cost] of totals) {
      csvRows.push(
        [h('adjustments_total'), '', '', '', '', '', '', '', '', cost.toFixed(2), currency]
          .map(cell)
          .join(';')
      );
    }
  }

  return '﻿' + csvRows.join('\r\n');
}

module.exports = { buildTransactionsCsv, buildReimbursementCsv, csvCell };
