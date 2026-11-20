const { trad } = require('./i18n');
const { formatTariffDetail } = require('./tariff');

/**
 * Construit le CSV d'export des transactions (vue gestionnaire ou utilisateur).
 * @param {Array} transactions lignes issues de db.getTransactions / db.getUserTransactions
 * @param {{withUser: boolean, lng: string}} opts withUser ajoute la colonne « Utilisateur »
 * @returns {string} contenu CSV (BOM UTF-8, séparateur « ; », fins de ligne CRLF)
 */
function buildTransactionsCsv(transactions, { withUser = false, lng = 'fr' } = {}) {
  const h = (key) => trad(`csvExportTitle.${key}`, { lng });
  const headers = [
    h('transaction_id'),
    h('chargepoint'),
    h('site'),
    h('connector'),
    h('tag'),
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

  for (const t of transactions) {
    const energyKwh =
      t.meter_stop != null && t.meter_start != null ? (t.meter_stop - t.meter_start) / 1000 : null;
    let duration = '';
    if (t.start_time && t.stop_time) {
      const diffMs = new Date(t.stop_time) - new Date(t.start_time);
      duration = (diffMs / 60000).toFixed(1);
    }
    const hasCost = t.cost != null;
    const row = [
      t.transaction_id,
      t.chargepoint_identity || '',
      t.site_name || '',
      t.connector_id,
      t.id_tag || '',
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
    ].map((v) => `"${String(v).replace(/"/g, '""').replace(/;/g, ',')}"`);
    csvRows.push(row.join(';'));
  }

  return '\uFEFF' + csvRows.join('\r\n');
}

module.exports = { buildTransactionsCsv };
