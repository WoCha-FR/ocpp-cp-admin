const db = require('./database');
const { format } = require('./notificationTemplates');
const { trad } = require('./i18n');
const emailChannel = require('./channels/email');
const webpushChannel = require('./channels/webpush');
const pushoverChannel = require('./channels/pushover');
const logger = require('./logger').scope('NOTIF');

/**
 * Définition des événements de notification par rôle.
 * Chaque événement a un label, une description et les rôles qui peuvent le recevoir.
 *
 * Rôles :
 *   - admin : administrateur global
 *   - manager : gestionnaire d'un ou plusieurs sites (via user_sites.role = 'manager')
 *   - user : utilisateur autorisé à recharger (via user_sites.authorized = 1)
 */
const EVENT_DEFINITIONS = {
  server_started: {
    roles: ['admin'],
    defaultChannels: ['webpush'],
  },
  server_stopping: {
    roles: ['admin'],
    defaultChannels: ['webpush'],
  },
  pending_chargepoint: {
    roles: ['admin'],
    defaultChannels: ['webpush'],
  },
  autoadd_chargepoint: {
    roles: ['admin'],
    defaultChannels: ['webpush'],
  },
  diagnostics_upload: {
    roles: ['admin'],
    defaultChannels: ['webpush'],
  },
  duplicate_identity: {
    roles: ['admin'],
    defaultChannels: ['webpush'],
  },
  identity_flapping: {
    roles: ['admin'],
    defaultChannels: ['webpush'],
  },
  chargepoint_online: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  chargepoint_offline: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  connector_available: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  connector_unavailable: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  connector_error: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  repeated_auth_rejected: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  site_transaction_started: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  site_transaction_stopped: {
    roles: ['admin', 'manager'],
    defaultChannels: [],
  },
  transaction_started: {
    roles: ['user'],
    defaultChannels: ['webpush'],
  },
  transaction_stopped: {
    roles: ['user'],
    defaultChannels: ['webpush'],
  },
  charge_suspended_evse: {
    roles: ['user'],
    defaultChannels: ['webpush'],
  },
};

// Canaux de notification enregistrés
const channels = new Map();

/**
 * Initialise le service de notifications.
 */
function init() {
  registerChannel(emailChannel);
  registerChannel(webpushChannel);
  registerChannel(pushoverChannel);
  logger.info(
    `Service initialized with ${channels.size} channels : ${[...channels.keys()].join(', ')}`
  );
}

/**
 * Enregistre un nouveau canal de notification.
 */
function registerChannel(channel) {
  channels.set(channel.name, channel);
}

/**
 * Retourne le rôle effectif d'un utilisateur pour le filtrage des notifications.
 * Un utilisateur peut avoir plusieurs rôles (admin, manager sur site X, user autorisé sur site Y).
 * On retourne le rôle le "plus haut" pour déterminer les événements visibles.
 * Mais un admin peut aussi recevoir des événements de manager/user s'il le configure.
 */
function getUserEffectiveRoles(user) {
  const roles = new Set();
  if (user.role === 'admin') {
    roles.add('admin');
    roles.add('manager');
    roles.add('user');
  } else {
    const sites = user.sites || [];
    if (sites.some((s) => s.role === 'manager')) roles.add('manager');
    roles.add('user');
  }
  return [...roles];
}

/**
 * Retourne tous les événements disponibles pour un utilisateur (tous ses rôles combinés).
 */
function getEventsForUser(user) {
  const roles = getUserEffectiveRoles(user);
  const lng = user.langue || 'fr';
  const result = {};
  for (const [event, def] of Object.entries(EVENT_DEFINITIONS)) {
    if (roles.some((r) => def.roles.includes(r))) {
      result[event] = {
        label: trad(`notifications.${event}.eLabel`, { lng }),
        description: trad(`notifications.${event}.eDesc`, { lng }),
        defaultChannels: def.defaultChannels,
      };
    }
  }
  return result;
}

/**
 * Retourne la liste des canaux disponibles.
 */
function getAvailableChannels() {
  return [...channels.keys()];
}

function normalizeChannelResult(result) {
  if (result && result.success === true) {
    return { success: true, error: null };
  }

  if (result && result.skipped === true) {
    return { success: false, error: result.reason || 'NOTIFICATION_SKIPPED' };
  }

  if (result && result.error) {
    return { success: false, error: result.error };
  }

  return { success: false, error: 'INVALID_CHANNEL_RESULT' };
}

/**
 * Émet une notification pour un événement donné.
 * La logique filtre automatiquement les utilisateurs selon :
 *   - Le rôle qui doit voir cet événement
 *   - Le site concerné (pour les managers/users)
 *   - Les préférences de notification de chaque utilisateur
 *
 * @param {string} event - Le type d'événement (clé de EVENT_DEFINITIONS)
 * @param {object} data - Les données associées à l'événement
 * @param {object} options - Options : { siteId, userId, transactionId }
 */
async function emit(event, data, options = {}) {
  const eventDef = EVENT_DEFINITIONS[event];
  if (!eventDef) {
    logger.warn(`Unknown event: ${event}`);
    return;
  }

  const { siteId, userId } = options;

  // Récupérer les utilisateurs cibles selon le rôle requis
  const targetUsers = getTargetUsers(eventDef.roles, siteId, userId);

  for (const user of targetUsers) {
    // Récupérer les préférences de cet utilisateur pour cet événement
    const prefs = db.getNotificationPreferences(user.id);

    // Filtrer les canaux activés pour cet événement
    const enabledChannels = getEnabledChannels(user.id, event, prefs, eventDef);

    for (const channelName of enabledChannels) {
      const channel = channels.get(channelName);
      if (!channel) continue;

      try {
        const formatted = format(event, data, user.langue || 'fr');
        const result = await channel.send(user, event, data, formatted);
        const normalized = normalizeChannelResult(result);
        // Loguer la notification
        db.addNotificationLog(
          user.id,
          event,
          channelName,
          data.identity || event,
          '',
          normalized.success,
          normalized.error
        );
      } catch (err) {
        logger.error(`Channel error ${channelName} for user ${user.id}: ${err.message}`);
        db.addNotificationLog(
          user.id,
          event,
          channelName,
          data.identity || event,
          '',
          false,
          err.message
        );
      }
    }
  }
}

/**
 * Détermine les canaux activés pour un utilisateur et un événement donné.
 * Si l'utilisateur n'a pas de préférences, on utilise les valeurs par défaut.
 */
function getEnabledChannels(userId, event, prefs, eventDef) {
  // Chercher les préférences spécifiques à cet événement
  const eventPrefs = prefs.filter((p) => p.event_type === event);

  if (eventPrefs.length === 0) {
    // Pas de préférences → utiliser les canaux par défaut
    return eventDef.defaultChannels.filter((c) => channels.has(c));
  }

  // Retourner uniquement les canaux activés
  return eventPrefs.filter((p) => p.enabled && channels.has(p.channel)).map((p) => p.channel);
}

/**
 * Récupère les utilisateurs cibles pour un événement selon les rôles requis et le site.
 */
function getTargetUsers(roles, siteId, userId) {
  const users = new Map();

  for (const role of roles) {
    let candidates;

    switch (role) {
      case 'admin':
        candidates = db.getUsersByRole('admin');
        break;

      case 'manager':
        if (siteId) {
          candidates = db.getUsersBySiteRole(siteId, 'manager');
        } else {
          // Pas de site spécifique → tous les managers
          candidates = db.getAllManagers();
        }
        break;

      case 'user':
        if (userId) {
          // Événement lié à un utilisateur spécifique (sa propre recharge)
          const u = db.getUserById(userId);
          candidates = u ? [u] : [];
        } else if (siteId) {
          // Tous les utilisateurs autorisés sur ce site
          candidates = db.getAuthorizedUsersBySite(siteId);
        } else {
          candidates = [];
        }
        break;

      default:
        candidates = [];
    }

    for (const u of candidates) {
      if (!users.has(u.id)) users.set(u.id, u);
    }
  }

  return [...users.values()];
}

/**
 * Envoie du mail de reset du mot de passe à un utilisateur
 * @param {object} user - L'utilisateur cible
 * @param {string} resetLink - Le lien de réinitialisation
 */
async function sendPasswordResetEmail(user, resetLink) {
  const lng = user.langue || 'fr';
  const titre = trad('notifications.passwordReset.emailSubject', { lng });
  const corps = trad('notifications.passwordReset.emailBody', { lng, resetLink });
  try {
    const result = await emailChannel.send(user, 'password_reset', {}, { titre, corps });
    const normalized = normalizeChannelResult(result);
    if (!normalized.success) {
      logger.error(`Password reset email failed for ${user.useremail}: ${normalized.error}`);
      return false;
    }
    logger.info(`Password reset email sent to ${user.useremail}`);
    return true;
  } catch (err) {
    logger.error(`Password reset email failed for ${user.useremail}: ${err.message}`);
    return false;
  }
}

/**
 * Envoie du mail de configuration du mot de passe à un utilisateur
 * @param {object} user - L'utilisateur cible
 * @param {string} setupLink - Le lien de configuration du mot de passe
 */
async function sendPasswordSetupEmail(user, setupLink) {
  const lng = user.langue || 'fr';
  const titre = trad('notifications.passwordSetup.emailSubject', { lng });
  const corps = trad('notifications.passwordSetup.emailBody', { lng, setupLink });
  try {
    const result = await emailChannel.send(user, 'password_setup', {}, { titre, corps });
    const normalized = normalizeChannelResult(result);
    if (!normalized.success) {
      logger.error(`Password setup email failed for ${user.useremail}: ${normalized.error}`);
      return false;
    }
    logger.info(`Password setup email sent to ${user.useremail}`);
    return true;
  } catch (err) {
    logger.error(`Password setup email failed for ${user.useremail}: ${err.message}`);
    return false;
  }
}

/**
 * Envoie du mail d'information d'ajout à un site à un utilisateur
 * @param {object} user - L'utilisateur cible
 * @param {object} site - Le site auquel l'utilisateur a été ajouté
 */
async function sendAddedToSiteEmail(user, site) {
  const lng = user.langue || 'fr';
  const titre = trad('notifications.addedToSite.emailSubject', { lng });
  const corps = trad('notifications.addedToSite.emailBody', { lng, site_name: site.sname });
  try {
    const result = await emailChannel.send(user, 'added_to_site', {}, { titre, corps });
    const normalized = normalizeChannelResult(result);
    if (!normalized.success) {
      logger.error(
        `Added to site email failed for ${user.useremail} and site ${site.sname}: ${normalized.error}`
      );
      return false;
    }
    logger.info(`Added to site email sent to ${user.useremail} for site ${site.sname}`);
    return true;
  } catch (err) {
    logger.error(
      `Added to site email failed for ${user.useremail} and site ${site.sname}: ${err.message}`
    );
    return false;
  }
}

/**
 * Envoie du mail d'information de retrait d'un site à un utilisateur
 * @param {object} user - L'utilisateur cible
 * @param {object} site - Le site duquel l'utilisateur a été retiré
 */
async function sendRemovedFromSiteEmail(user, site) {
  const lng = user.langue || 'fr';
  const titre = trad('notifications.removedFromSite.emailSubject', { lng });
  const corps = trad('notifications.removedFromSite.emailBody', { lng, site_name: site.sname });
  try {
    const result = await emailChannel.send(user, 'removed_from_site', {}, { titre, corps });
    const normalized = normalizeChannelResult(result);
    if (!normalized.success) {
      logger.error(
        `Removed from site email failed for ${user.useremail} and site ${site.sname}: ${normalized.error}`
      );
      return false;
    }
    logger.info(`Removed from site email sent to ${user.useremail} for site ${site.sname}`);
    return true;
  } catch (err) {
    logger.error(
      `Removed from site email failed for ${user.useremail} and site ${site.sname}: ${err.message}`
    );
    return false;
  }
}

/**
 * Envoie du mail d'information de suspension d'un site à un utilisateur
 * @param {object} user - L'utilisateur cible
 * @param {object} site - Le site duquel l'utilisateur a été suspendu
 */
async function sendSuspendedInSiteEmail(user, site) {
  const lng = user.langue || 'fr';
  const titre = trad('notifications.suspendedInSite.emailSubject', { lng });
  const corps = trad('notifications.suspendedInSite.emailBody', { lng, site_name: site.sname });
  try {
    const result = await emailChannel.send(user, 'suspended_in_site', {}, { titre, corps });
    const normalized = normalizeChannelResult(result);
    if (!normalized.success) {
      logger.error(
        `Suspended in site email failed for ${user.useremail} and site ${site.sname}: ${normalized.error}`
      );
      return false;
    }
    logger.info(`Suspended in site email sent to ${user.useremail} for site ${site.sname}`);
    return true;
  } catch (err) {
    logger.error(
      `Suspended in site email failed for ${user.useremail} and site ${site.sname}: ${err.message}`
    );
    return false;
  }
}

/**
 * Envoie du mail d'information de réactivation d'un site à un utilisateur
 * @param {object} user - L'utilisateur cible
 * @param {object} site - Le site duquel l'utilisateur a été réactivé
 */
async function sendReactivatedInSiteEmail(user, site) {
  const lng = user.langue || 'fr';
  const titre = trad('notifications.reactivatedInSite.emailSubject', { lng });
  const corps = trad('notifications.reactivatedInSite.emailBody', { lng, site_name: site.sname });
  try {
    const result = await emailChannel.send(user, 'reactivated_in_site', {}, { titre, corps });
    const normalized = normalizeChannelResult(result);
    if (!normalized.success) {
      logger.error(
        `Reactivated in site email failed for ${user.useremail} and site ${site.sname}: ${normalized.error}`
      );
      return false;
    }
    logger.info(`Reactivated in site email sent to ${user.useremail} for site ${site.sname}`);
    return true;
  } catch (err) {
    logger.error(
      `Reactivated in site email failed for ${user.useremail} and site ${site.sname}: ${err.message}`
    );
    return false;
  }
}

module.exports = {
  init,
  emit,
  registerChannel,
  getEventsForUser,
  getAvailableChannels,
  getUserEffectiveRoles,
  sendPasswordResetEmail,
  sendPasswordSetupEmail,
  sendAddedToSiteEmail,
  sendRemovedFromSiteEmail,
  sendSuspendedInSiteEmail,
  sendReactivatedInSiteEmail,
  EVENT_DEFINITIONS,
};
