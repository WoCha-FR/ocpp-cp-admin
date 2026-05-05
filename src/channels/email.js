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
  transporter
    .verify()
    .then(() => logger.debug('SMTP connection verified successfully'))
    .catch((err) => logger.warn(`SMTP verification failed: ${err.message}`));

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

    const { titre, corps, html: htmlBody } = i18nDatas;
    const lng = user.langue || 'fr';
    const footer = trad('notifications.common.notifFooter', { lng });
    const text = `${corps}\n\n--\n${footer}`;

    let html;
    if (htmlBody) {
      const footerHtml = trad('notifications.common.notifFooterHtml', { lng });
      html = `<!DOCTYPE html>
<html lang="${lng}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;font-size:15px;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="border:1px solid #e0e0e0;border-radius:6px;padding:24px;">
    ${htmlBody}
  </div>
  <div style="margin-top:16px;font-size:0.8em;color:#999;text-align:center;">
    ${footerHtml}
  </div>
</body>
</html>`;
    }

    try {
      await t.sendMail({
        from,
        to: user.useremail,
        subject: titre,
        text,
        ...(html ? { html } : {}),
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
