const nodemailer = require('nodemailer');
const { getConfig } = require('../config');
const { trad } = require('../i18n');
const logger = require('../logger').scope('NOTIFMAIL');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const config = getConfig();
  const mailConfig = config.notifs.mail;

  if (!mailConfig || !mailConfig.enabled) {
    logger.info('Email channel disabled in config.json');
    return null;
  }

  transporter = nodemailer.createTransport(mailConfig.transport);
  logger.debug('Email transporter configured');

  // Vérification SMTP asynchrone (non bloquante)
  transporter.verify()
    .then(() => logger.debug('SMTP connection verified successfully'))
    .catch(err => logger.warn(`SMTP verification failed: ${err.message}`));

  return transporter;
}

/**
 * Canal email pour le système de notifications.
 * Interface standard : { name, send(user, event, data, i18nDatas) }
 */
const emailChannel = {
  name: 'email',

  async send(user, event, data, i18nDatas) {
    const t = getTransporter();
    if (!t) return { success: false, skipped: true, reason: 'CHANNEL_DISABLED' };

    const config = getConfig();
    const from = config.notifs.mail.from || 'CPADMIN <noreply@cpadmin.local>';

    const { titre, corps } = i18nDatas;
    const footer = trad('notifications.common.notifFooter', { lng: user.langue || 'fr' });
    const text = `${corps}\n\n--\n${footer}`;

    try {
      await t.sendMail({
        from,
        to: user.useremail,
        subject: titre,
        text,
      });
      logger.debug(`"${event}" notification sent to ${user.useremail}`);
      return { success: true };
    } catch (err) {
      logger.error(`Error sending to ${user.useremail}: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

module.exports = emailChannel;
