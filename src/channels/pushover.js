const { getConfig } = require('../config');
const { trad } = require('../i18n');
const logger = require('../logger').scope('NOTIFPUSHOVER');

let initialized = false;

function initPushover() {
  const config = getConfig();
  if (!config.notifs?.pushover?.enabled) {
    logger.info('Pushover channel disabled in config.json');
    return;
  }
  initialized = true;
  logger.debug('Pushover channel initialized');
}

/**
 * Métadonnées spécifiques au canal Pushover (priority) par événement.
 */
function getPushoverMeta(event, _data) {
  const meta = {
    server_started: { priority: 0 },
    server_stopping: { priority: 1 },
    pending_chargepoint: { priority: 1 },
    autoadd_chargepoint: { priority: 1 },
    diagnostics_upload: { priority: 1 },
    chargepoint_online: { priority: 0 },
    chargepoint_offline: { priority: 1 },
    connector_available: { priority: 0 },
    connector_unavailable: { priority: 1 },
    connector_error: { priority: 1 },
    site_transaction_started: { priority: 0 },
    site_transaction_stopped: { priority: 0 },
    transaction_started: { priority: 0 },
    transaction_stopped: { priority: 0 },
    charge_suspended_evse: { priority: 0 },
  };
  return meta[event] || { priority: 0 };
}

/**
 * Canal Pushover pour le système de notifications.
 */
const pushoverChannel = {
  name: 'pushover',

  async send(user, event, data, i18nDatas) {
    if (!initialized) initPushover();
    if (!initialized) return { success: false, skipped: true, reason: 'CHANNEL_DISABLED' };

    if (!user.ntif_pushtokn) {
      logger.warn(`User ${user.shortname || user.useremail} does not have a Pushover app token`);
      return { success: false, skipped: true, reason: 'MISSING_PUSHOVER_TOKEN' };
    }
    if (!user.ntif_pushuser) {
      logger.warn(`User ${user.shortname || user.useremail} does not have a Pushover user key`);
      return { success: false, skipped: true, reason: 'MISSING_PUSHOVER_USER' };
    }

    const { titre, corps } = i18nDatas;
    const meta = getPushoverMeta(event, data);
    const footer = trad('notifications.common.notifFooter', { lng: user.langue || 'fr' });
    const text = `${corps}\n\n--\n${footer}`;
    const payload = {
      token: user.ntif_pushtokn,
      user: user.ntif_pushuser,
      title: titre,
      message: text,
      priority: meta.priority,
    };

    try {
      const response = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        const responseBody = await response.text();
        const errorMsg = `Pushover API error ${response.status}: ${responseBody}`;
        logger.error(errorMsg);
        return { success: false, error: errorMsg };
      }
      logger.debug(
        `"${event}" notification sent to ${user.shortname || user.useremail} via Pushover`
      );
      return { success: true };
    } catch (err) {
      logger.error(`Error sending Pushover to ${user.shortname || user.useremail}: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

module.exports = pushoverChannel;
