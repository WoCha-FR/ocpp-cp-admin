// ── Prometheus metrics (text format, no external dependency) ──
const db = require('./database');

/**
 * Build a Prometheus text-format response.
 * @param {{ getConnectedClients: Function, pendingChargepoints: Map }} ocpp
 * @param {Set} uiClients - the uiClients Set from server.js
 * @returns {string}
 */
function getMetricsText({ getConnectedClients, pendingChargepoints }, uiClients) {
  const sqliteDb = db.getDb();
  const lines = [];

  function gauge(name, help, value) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }

  // ── OCPP ──
  gauge(
    'ocpp_chargepoints_connected',
    'Number of OCPP chargepoints currently connected via WebSocket',
    getConnectedClients().size
  );

  gauge(
    'ocpp_chargepoints_pending',
    'Number of OCPP chargepoints waiting for admin acceptance',
    pendingChargepoints.size
  );

  // ── Transactions ──
  const activeCount = sqliteDb
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE status = 'Active'")
    .get().n;
  const totalCount = sqliteDb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;

  gauge('ocpp_transactions_active', 'Number of currently active OCPP transactions', activeCount);
  gauge('ocpp_transactions_total', 'Total number of OCPP transactions ever recorded', totalCount);

  // ── Connectors by status ──
  const connectorStats = sqliteDb
    .prepare(
      'SELECT cnstatus, COUNT(*) AS n FROM connectors WHERE connector_id > 0 GROUP BY cnstatus'
    )
    .all();

  lines.push('# HELP ocpp_connectors_by_status Number of connectors per OCPP status');
  lines.push('# TYPE ocpp_connectors_by_status gauge');
  for (const row of connectorStats) {
    lines.push(`ocpp_connectors_by_status{status="${row.cnstatus}"} ${row.n}`);
  }

  // ── WebUI ──
  gauge(
    'webui_clients_connected',
    'Number of WebSocket UI clients currently connected',
    uiClients.size
  );

  // ── Process ──
  gauge('process_uptime_seconds', 'Process uptime in seconds', Math.floor(process.uptime()));
  gauge('nodejs_heap_used_bytes', 'Node.js V8 heap used in bytes', process.memoryUsage().heapUsed);

  return lines.join('\n') + '\n';
}

module.exports = { getMetricsText };
