const webpush = require('web-push');
const { getConfig } = require('../config');
const db = require('../database');
const { trad } = require('../i18n');
const logger = require('../logger').scope('NOTIFPUSH');

let initialized = false;

function initWebPush() {
  if (initialized) return;

  const config = getConfig();
  const vapid = config.notifs.webpush;

  if (!vapid || !vapid.enabled) {
    logger.info('Web Push channel disabled in config.json');
    return;
  }

  if (!vapid.vapidPublicKey || !vapid.vapidPrivateKey) {
    logger.error('VAPID keys missing in config.json. Generate them with: npx web-push generate-vapid-keys');
    return;
  }

  webpush.setVapidDetails(
    vapid.vapidSubject || 'mailto:admin@cpadmin.local',
    vapid.vapidPublicKey,
    vapid.vapidPrivateKey
  );

  initialized = true;
  logger.debug('Web Push configured with VAPID keys');
}

/**
 * Métadonnées spécifiques au canal webpush (icon, tag) par événement.
 */
function getPushMeta(event, data) {
  const meta = {
    server_started:       { icon: '🚀', tag: `server-started` },
    server_stopping:      { icon: '🛑', tag: `server-stopping` },
    pending_chargepoint:  { icon: '⌛', tag: `pending-${data.identity}` },
    autoadd_chargepoint:  { icon: '🆕', tag: `added-${data.identity}` },
    diagnostics_upload:   { icon: '🔬', tag: `diagnostics-${data.identity}` },
    chargepoint_online:   { icon: '🟢', tag: `online-${data.identity}` },
    chargepoint_offline:  { icon: '🔴', tag: `offline-${data.identity}` },
    connector_available:  { icon: '✅', tag: `connector-available-${data.identity}-${data.connector_id}` },
    connector_unavailable:{ icon: '❌', tag: `connector-unavailable-${data.identity}-${data.connector_id}` },
    connector_error:      { icon: '⚠️', tag: `error-${data.identity}-${data.connector_id}` },
    site_transaction_started: { icon: '➡️', tag: `site-tx-start-${data.identity}-${data.connector_id}` },
    site_transaction_stopped: { icon: '⏹️', tag: `site-tx-stop-${data.identity}-${data.connector_id}` },
    transaction_started:  { icon: '▶️', tag: `tx-start-${data.transaction_id}` },
    transaction_stopped:  { icon: '🏁', tag: `tx-stop-${data.transaction_id}` },
    charge_suspended_evse:{ icon: '⏸️', tag: `suspended-${data.identity}-${data.connector_id}` },
  };
  return meta[event] || { icon: '📨', tag: `generic-${Date.now()}` };
}

/**
 * Canal Web Push pour le système de notifications.
 */
const webpushChannel = {
  name: 'webpush',

  async send(user, event, data, i18nDatas) {
    if (!initialized) initWebPush();
    if (!initialized) return { success: false, skipped: true, reason: 'CHANNEL_NOT_INITIALIZED' };

    const subscriptions = db.getPushSubscriptions(user.id);
    if (subscriptions.length === 0) return { success: false, skipped: true, reason: 'NO_SUBSCRIPTIONS' };

    const { titre, corps } = i18nDatas;
    const meta = getPushMeta(event, data);
    const footer = trad('notifications.common.notifFooter', { lng: user.langue || 'fr' });
    const text = `${corps}\n\n--\n${footer}`;

    const payload = JSON.stringify({
      title: titre,
      body: text,
      icon: meta.icon,
      tag: meta.tag,
      data: { event, url: '/' },
    });

    const results = [];
    for (const sub of subscriptions) {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys_p256dh,
          auth: sub.keys_auth,
        },
      };

      try {
        await webpush.sendNotification(pushSub, payload);
        results.push({ success: true });
      } catch (err) {
        logger.error(`Error for user ${user.id} (endpoint: ${sub.endpoint.slice(-20)}): ${err.message}`);
        // Si l'abonnement est expiré/invalide (410 Gone ou 404), le supprimer
        if (err.statusCode === 410 || err.statusCode === 404) {
          db.deletePushSubscription(sub.endpoint);
          logger.info(`Expired subscription deleted for user ${user.id}`);
        }
        results.push({ success: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const firstError = results.find(r => !r.success && r.error)?.error || null;
    if (successCount > 0) {
      logger.debug(`Notification "${event}" sent to ${user.useremail} (${successCount}/${subscriptions.length} devices)`);
    }
    return {
      success: successCount > 0,
      error: successCount > 0 ? null : firstError || 'WEBPUSH_ALL_SENDS_FAILED',
    };
  },
};

module.exports = webpushChannel;
