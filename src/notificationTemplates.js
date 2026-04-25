const { trad } = require('./i18n');

/**
 * Templates de notification partagés par tous les canaux (email, webpush, pushover).
 *
 * Chaque template retourne { title, body } :
 *   - title : utilisé comme sujet d'email ou titre de notification push
 *   - body  : corps du message (texte brut)
 *
 * Les canaux peuvent enrichir ces données (icon, tag pour webpush, footer pour email, etc.)
 * mais le contenu textuel est défini ici une seule fois.
 */

/**
 * Retourne { titre, corps } pour un événement donné.
 * @param {string} event - Le type d'événement
 * @param {object} data  - Les données associées
 * @param {string} [lang='fr'] - Code langue (ex: 'fr', 'en')
 * @returns {{ titre: string, corps: string }}
 */
function format(event, data, lang = 'fr') {
  const tradN = (key, extra) => trad(key, { lng: lang, ...extra });
  const cp_name = data.cp_name || data.identity;
  const cn_name = data.cn_name ? ` ${data.cn_name}` : '';
  const opts = { lng: lang };

  const templates = {
    // ── Admin ──
    server_started: () => ({
      titre: tradN('notifications.server_started.title'),
      corps: tradN('notifications.server_started.body'),
    }),
    server_stopping: () => ({
      titre: tradN('notifications.server_stopping.title'),
      corps: tradN('notifications.server_stopping.body', { signal: data.signal || 'N/A' }),
    }),
    pending_chargepoint: () => ({
      titre: tradN('notifications.pending_chargepoint.title'),
      corps: tradN('notifications.pending_chargepoint.body', { identity: data.identity }),
    }),
    autoadd_chargepoint: () => ({
      titre: tradN('notifications.autoadd_chargepoint.title'),
      corps: tradN('notifications.autoadd_chargepoint.body', { identity: data.identity }),
    }),
    chargepoint_refused: () => ({
      titre: tradN('notifications.chargepoint_refused.title', { identity: data.identity }),
      corps: [
        tradN('notifications.chargepoint_refused.body', { identity: data.identity }),
        tradN('notifications.chargepoint_refused.info', {
          reason: tradN(`notifications.chargepoint_refused.reasons.${data.reason}`),
        }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    diagnostics_upload: () => ({
      titre: tradN('notifications.diagnostics_upload.title', { cp_name }),
      corps: tradN('notifications.diagnostics_upload.body', { status: data.status }),
    }),
    init_config_result: () => ({
      titre: tradN('notifications.init_config_result.title', { identity: data.identity }),
      corps: [
        line('notifications.init_config_result.reboot', data.rebootKeys?.length, {
          ...opts,
          keys: data.rebootKeys?.join(', '),
        }),
        line('notifications.init_config_result.rejected', data.rejectedKeys?.length, {
          ...opts,
          keys: data.rejectedKeys?.join(', '),
        }),
        line('notifications.init_config_result.notSupported', data.notSupportedKeys?.length, {
          ...opts,
          keys: data.notSupportedKeys?.join(', '),
        }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    duplicate_identity: () => ({
      titre: tradN('notifications.duplicate_identity.title', { identity: data.identity }),
      corps: [
        tradN('notifications.duplicate_identity.body', { identity: data.identity }),
        tradN('notifications.duplicate_identity.info', {
          actualip: data.old_address,
          newip: data.new_address,
        }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    identity_flapping: () => ({
      titre: tradN('notifications.identity_flapping.title', { identity: data.identity }),
      corps: [
        tradN('notifications.identity_flapping.body', {
          identity: data.identity,
          count: data.count,
          seconds: data.seconds,
        }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    // ── Admin & Manager ──
    chargepoint_online: () => ({
      titre: tradN('notifications.chargepoint_online.title', { cp_name }),
      corps: [
        tradN('notifications.chargepoint_online.body', { cp_name }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    chargepoint_offline: () => ({
      titre: tradN('notifications.chargepoint_offline.title', { cp_name }),
      corps: [
        tradN('notifications.chargepoint_offline.body', { cp_name }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    connector_available: () => ({
      titre: tradN('notifications.connector_available.title', { cp_name }),
      corps: [
        tradN('notifications.connector_available.body', {
          cp_name,
          connector_id: data.connector_id,
          cn_name,
        }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    connector_unavailable: () => ({
      titre: tradN('notifications.connector_unavailable.title', { cp_name }),
      corps: [
        tradN('notifications.connector_unavailable.body', {
          cp_name,
          connector_id: data.connector_id,
          cn_name,
        }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    connector_error: () => ({
      titre: tradN('notifications.connector_error.title', { cp_name }),
      corps: [
        tradN('notifications.connector_error.body', {
          cp_name,
          connector_id: data.connector_id,
          cn_name,
        }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
        tradN('notifications.connector_error.status', { status: data.status }),
        tradN('notifications.connector_error.error_code', { error_code: data.error_code }),
        line('notifications.connector_error.info', data.info, { ...opts, info: data.info }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    site_transaction_started: () => ({
      titre: tradN('notifications.site_transaction_started.title', { cp_name }),
      corps: [
        tradN('notifications.site_transaction_started.body', { cp_name }),
        tradN('notifications.common.connector', { connector_id: data.connector_id, cn_name }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    site_transaction_stopped: () => ({
      titre: tradN('notifications.site_transaction_stopped.title', { cp_name }),
      corps: [
        tradN('notifications.site_transaction_stopped.body', { cp_name }),
        tradN('notifications.common.connector', { connector_id: data.connector_id, cn_name }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
        line('notifications.common.energy', data.energy_kwh, {
          ...opts,
          energy_kwh: data.energy_kwh,
        }),
        line('notifications.common.duration', data.duration, { ...opts, duration: data.duration }),
        line('notifications.common.stop_reason', data.stop_reason, {
          ...opts,
          stop_reason: data.stop_reason,
        }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    repeated_auth_rejected: () => ({
      titre: tradN('notifications.repeated_auth_rejected.title', { id_tag: data.id_tag }),
      corps: [
        tradN('notifications.repeated_auth_rejected.body', {
          id_tag: data.id_tag,
          count: data.count,
          window_minutes: data.window_minutes,
        }),
        line('notifications.repeated_auth_rejected.last_chargepoint', data.last_chargepoint, {
          ...opts,
          cp_last: data.last_chargepoint,
        }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    // ── Utilisateur ──
    transaction_started: () => ({
      titre: tradN('notifications.transaction_started.title', { cp_name }),
      corps: [
        tradN('notifications.transaction_started.body', { cp_name }),
        tradN('notifications.common.connector', { connector_id: data.connector_id, cn_name }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    transaction_stopped: () => ({
      titre: tradN('notifications.transaction_stopped.title', { cp_name }),
      corps: [
        tradN('notifications.transaction_stopped.body', { cp_name }),
        tradN('notifications.common.connector', { connector_id: data.connector_id, cn_name }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
        line('notifications.common.energy', data.energy_kwh, {
          ...opts,
          energy_kwh: data.energy_kwh,
        }),
        line('notifications.common.duration', data.duration, { ...opts, duration: data.duration }),
        line('notifications.common.stop_reason', data.stop_reason, {
          ...opts,
          stop_reason: data.stop_reason,
        }),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
    charge_suspended_evse: () => ({
      titre: tradN('notifications.charge_suspended_evse.title', { cp_name }),
      corps: [
        tradN('notifications.charge_suspended_evse.body', { cp_name }),
        tradN('notifications.common.connector', { connector_id: data.connector_id, cn_name }),
        line('notifications.common.site', data.site_name, { ...opts, site_name: data.site_name }),
        line('notifications.common.energy', data.energy_kwh, {
          ...opts,
          energy_kwh: data.energy_kwh,
        }),
        tradN('notifications.charge_suspended_evse.unplug'),
      ]
        .filter(Boolean)
        .join('\n'),
    }),
  };

  const factory = templates[event];
  if (factory) return factory();

  return {
    titre: `CPAdmin – ${event}`,
    corps: [
      tradN('notifications.common.defaultBody', { event }),
      `${JSON.stringify(data, null, 2)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function line(key, condition, vars) {
  return condition ? trad(key, vars) : null;
}

module.exports = { format };
