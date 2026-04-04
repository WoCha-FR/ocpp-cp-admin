const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const crypto = require('crypto');
const { checkSchema, validationResult, matchedData } = require('express-validator');

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const passport = require('passport');
const db = require('./database');
const {
  getConnectedClients,
  callClient,
  disconnectChargepoint,
  pendingRemoteStarts,
  pendingChargepoints,
} = require('./ocpp-server');
const schema = require('./validationSchema');
const notifications = require('./notifications');
const {
  getConfig,
  getConfigFilePath,
  ENV_OVERRIDES,
  CONFIG_FIELDS,
  deepGet,
  deepSet,
} = require('./config');
const { trad, SUPPORTED_LANGUAGES, i18next } = require('./i18n');
const logger = require('./logger').scope('AUTH');

const router = express.Router();
const config = getConfig();
const googleAuthEnabled = config.auth?.google?.enabled === true;

// ── Rate limiters ──
// Global : 100 requêtes / minute par IP pour toute l'API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: ipKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ERR_TOO_MANY_REQUESTS' },
});
router.use(apiLimiter);

// Login : 10 tentatives / 15 min par IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: ipKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ERR_TOO_MANY_REQUESTS' },
});

// Fonction utilitaire
function errorResponse(res, status, messageOrCode) {
  if (messageOrCode?.startsWith('ERR_') || messageOrCode?.startsWith('VALIDATION_')) {
    return res.status(status).json({ error: messageOrCode });
  }
  // Gestion des erreurs imprévues
  return res.status(status).json({ error: 'ERR_INTERNAL', details: messageOrCode });
}

function validateSchema(...schemas) {
  return [
    checkSchema(Object.assign({}, ...schemas)),
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
      }
      next();
    },
  ];
}

// Retourne la limite paginée (null = pas de limite si non fournie)
function parsePagination(req, maxLimit = 200) {
  if (!req.query.limit) return null;
  return Math.min(Number(req.query.limit), maxLimit);
}

function generateResetToken(userId, expiresInMinutes = 30) {
  db.deleteExpiredPasswordResets();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
  db.createPasswordReset(userId, tokenHash, expiresAt);
  return token;
}

function generatePwd(len = 12) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+|}{[]:;?><,./-=';
  let password = '';
  for (let i = 0; i < len; i++) {
    const randomIndex = crypto.randomInt(chars.length);
    password += chars[randomIndex];
  }
  return password;
}

// ── Middleware d'authentification (Passport) ──
function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
    }
    next();
  };
}

// Vérifie que l'utilisateur est admin OU manager sur au moins un site
function requireManager(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
  }
  if (req.user.role === 'admin') return next();
  const hasManagedSite = (req.user.sites || []).some((s) => s.role === 'manager');
  if (!hasManagedSite) {
    return res.status(403).json({ error: 'ERR_ACCESS_DENIED' });
  }
  next();
}

// Retourne les IDs des sites accessibles par l'utilisateur
function getUserSiteIds(req) {
  const user = req.user;
  if (user.role === 'admin') return null; // null = accès total
  return (user.sites || []).map((s) => s.site_id);
}

// Retourne les IDs des sites gérés (rôle manager) par l'utilisateur
function getUserManagedSiteIds(req) {
  const user = req.user;
  if (user.role === 'admin') return null; // null = accès total
  return (user.sites || []).filter((s) => s.role === 'manager').map((s) => s.site_id);
}

// Filtre les données selon les sites de l'utilisateur
function filterBySite(req, data) {
  const siteIds = getUserSiteIds(req);
  if (siteIds === null) return data; // admin
  if (siteIds.length === 0) return [];
  return data.filter((item) => siteIds.includes(item.site_id));
}

// ══════════════════════════════════════
//  AUTH (Passport.js)
// ══════════════════════════════════════
router.post('/auth/login', loginLimiter, ...validateSchema(schema.Login), (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({ error: info?.message || 'ERR_INVALID_AUTH' });
    }
    req.logIn(user, (err) => {
      if (err) return next(err);
      res.json({
        id: user.id,
        useremail: user.useremail,
        shortname: user.shortname,
        role: user.role,
        langue: user.langue,
        sites: user.sites,
      });
    });
  })(req, res, next);
});

router.post('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy((err) => {
      if (err) return next(err);
      res.json({ ok: true });
    });
  });
});

router.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'ERR_NOT_AUTHENTICATED' });
  }
  res.json(req.user);
});

router.get('/auth/default-credentials-check', requireAuth, (req, res) => {
  const user = db.getUserByEmail(req.user.useremail);
  const bcrypt = require('bcryptjs');
  const defaultEmail = user.useremail === 'admin@admin.com';
  const defaultPassword = bcrypt.compareSync('admin123', user.password);
  res.json({ defaultEmail, defaultPassword });
});

if (googleAuthEnabled) {
  router.get(
    '/auth/google/login',
    passport.authenticate('google', { scope: ['email', 'profile'] })
  );

  router.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate('google', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        const msg = encodeURIComponent(info?.message || 'ERR_GOOGLE_ERROR');
        return res.redirect(`/?error=${msg}`);
      }
      req.logIn(user, (err) => {
        if (err) return next(err);
        res.redirect('/');
      });
    })(req, res, next);
  });
}

// ══════════════════════════════════════
//  PASSWORD RESET
// ══════════════════════════════════════
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  // Use the library helper for IP fallback to keep IPv6 handling safe.
  keyGenerator: (req) => req.body?.useremail || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ERR_TOO_MANY_REQUESTS' },
});

router.post(
  '/auth/forgot-password',
  forgotPasswordLimiter,
  checkSchema(schema.ForgotPassword),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }
    const { useremail } = matchedData(req);
    const user = db.getUserByEmail(useremail);

    // Réponse identique que l'utilisateur existe ou non (anti-énumération)
    if (!user) {
      return res.json({ ok: true });
    }
    // Génération du token de réinitialisation et enregistrement dans la base
    const token = generateResetToken(user.id);
    // Notification par email avec le lien de réinitialisation
    const publicUrl = config.webui.publicUrl || `http://localhost:${config.webui.httpPort}`;
    const resetLink = `${publicUrl}/?resetToken=${token}`;
    notifications.sendPasswordResetEmail(user, resetLink).catch((err) => {
      logger.error(`Failed to send password reset email: ${err.message}`);
    });
    res.json({ ok: true });
  }
);

router.post('/auth/reset-password', checkSchema(schema.ResetPassword), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array().map((e) => e.msg) });
  }
  const { token, newPassword } = matchedData(req);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const reset = db.getUserPasswordResetByToken(tokenHash);

  if (!reset || reset.used === 1 || new Date(reset.expires_at) < new Date()) {
    return res.status(400).json({ error: 'ERR_INVALID_RESET_TOKEN' });
  }

  db.updateUser(reset.user_id, { password: newPassword });
  db.markUserPasswordResetAsUsed(reset.id);

  res.json({ ok: true });
});

router.post(
  '/auth/resend-setup-password',
  requireManager,
  checkSchema(schema.ResendSetupPassword),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    const result = db.getUserById(data.userId);
    if (!result) return res.status(404).json({ error: 'ERR_UNKNOWN_USER' });
    // Vérifier que le manager gère un site de l'utilisateur
    if (req.user.role !== 'admin') {
      const userSiteIds = db.getUserSiteIds(result.id);
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !userSiteIds.some((id) => managedIds.includes(id))) {
        return res.status(403).json({ error: 'ERR_USER_NOT_MANAGED' });
      }
    }
    // Generation et enregistrement du token pour création mot de passe
    const token = generateResetToken(result.id, 1440); // token valable 24h pour la configuration du mot de passe initial
    // Envoyer un email à l'utilisateur pour définir son mot de passe
    const publicUrl = config.webui.publicUrl || `http://localhost:${config.webui.httpPort}`;
    const resetLink = `${publicUrl}/?resetToken=${token}`;
    notifications.sendPasswordSetupEmail(result, resetLink).catch((err) => {
      logger.error(`Failed to send password setup email: ${err.message}`);
    });
    res.json({ ok: true });
  }
);

// ══════════════════════════════════════
//  SETTINGS (config publique côté client)
// ══════════════════════════════════════
router.get('/appsettings', (req, res) => {
  const config = getConfig();
  const languageLabels = {};
  for (const lng of SUPPORTED_LANGUAGES) {
    const label = i18next.t('language_label', { lng });
    languageLabels[lng] = label && label !== 'language_label' ? label : `🌐 ${lng.toUpperCase()}`;
  }
  res.json({
    cpoName: config.cpoName || '',
    publicUrl: config.webui?.publicUrl || `http://localhost:${config.webui?.httpPort || 3000}`,
    ocppWsUrl: config.ocpp?.ocppWsUrl || `ws://ws.cpadmin.local:${config.ocpp?.wsPort || 9000}`,
    ocppWssEnabled: config.ocpp?.wss?.enabled === true,
    ocppWssUrl:
      config.ocpp?.wss?.ocppWsUrl || `wss://ws.cpadmin.local:${config.ocpp?.wss?.wssPort || 9001}`,
    google: googleAuthEnabled,
    supportedLanguages: SUPPORTED_LANGUAGES,
    languageLabels,
  });
});

router.get('/ocppsettings', requireManager, (req, res) => {
  const config = getConfig();
  res.json({
    diagnosticsLocation: config.ocpp?.diagnosticsLocation || '',
  });
});

// ══════════════════════════════════════
//  SITES
// ══════════════════════════════════════
router.get('/sites', requireAuth, (req, res) => {
  const sites = db.getAllSites();
  const siteIds = getUserSiteIds(req);
  if (siteIds === null) return res.json(sites); // admin
  return res.json(sites.filter((s) => siteIds.includes(s.id)));
});

router.get('/sites/:id', requireAuth, ...validateSchema(schema.IdParam), (req, res) => {
  const site = db.getSiteById(Number(req.params.id));
  if (!site) return res.status(404).json({ error: 'ERR_SITE_NOT_FOUND' });
  res.json(site);
});

router.post('/sites', requireRole('admin'), checkSchema(schema.Site), (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ error: result.array().map((e) => e.msg) });
  }
  const data = matchedData(req);
  try {
    const site = db.createSite(data.name, data.address);
    res.status(201).json(site);
  } catch (e) {
    errorResponse(res, 400, e.message);
  }
});

router.put(
  '/sites/:id',
  requireRole('admin'),
  ...validateSchema(schema.IdParam, schema.Site),
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    try {
      const site = db.updateSite(Number(req.params.id), data.name, data.address);
      res.json(site);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.delete('/sites/:id', requireRole('admin'), ...validateSchema(schema.IdParam), (req, res) => {
  db.deleteSite(Number(req.params.id));
  res.json({ ok: true });
});

// ── Utilisateurs d'un site (pour les managers) ──
router.get(
  '/sites/:siteId/users',
  requireManager,
  ...validateSchema(schema.SiteIdParam),
  (req, res) => {
    const siteId = Number(req.params.siteId);
    // Vérifier que le manager gère ce site
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(siteId)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    res.json(db.getSiteUsers(siteId));
  }
);

router.get(
  '/sites/:siteId/users/stats',
  requireManager,
  ...validateSchema(schema.SiteIdParam),
  (req, res) => {
    const siteId = Number(req.params.siteId);
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(siteId)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    res.json(db.getSiteUsersWithStats(siteId));
  }
);

router.post(
  '/sites/:siteId/users',
  requireManager,
  ...validateSchema(schema.SiteIdParam, schema.UserSite),
  (req, res) => {
    const siteId = Number(req.params.siteId);
    // Vérifier que le manager gère ce site
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(siteId)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    // Valider les données
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    const { useremail } = data;
    const password = generatePwd(); // Générer un mot de passe aléatoire pour les nouveaux utilisateurs
    if (!useremail) return res.status(400).json({ error: 'ERR_EMAIL_REQUIRED' });
    try {
      const result = db.addUserToSite(useremail, siteId, password);
      if (result.isNew) {
        // Generation et enregistrement du token pour création mot de passe
        const token = generateResetToken(result.user.id, 1440); // token valable 24h pour la configuration du mot de passe initial
        // Envoyer un email à l'utilisateur pour définir son mot de passe
        const publicUrl = config.webui.publicUrl || `http://localhost:${config.webui.httpPort}`;
        const resetLink = `${publicUrl}/?resetToken=${token}`;
        notifications.sendPasswordSetupEmail(result.user, resetLink).catch((err) => {
          logger.error(`Failed to send password setup email: ${err.message}`);
        });
      } else {
        // Notifier l'utilisateur existant qu'il a été ajouté à un nouveau site
        notifications.sendAddedToSiteEmail(result.user, db.getSiteById(siteId)).catch((err) => {
          logger.error(`Failed to send added to site email: ${err.message}`);
        });
      }
      res.status(201).json({ ...result.user, isNew: result.isNew });
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.patch(
  '/sites/:siteId/users/:userId',
  requireManager,
  ...validateSchema(schema.SiteUserParams, schema.SiteUserPatch),
  (req, res) => {
    const siteId = Number(req.params.siteId);
    const userId = Number(req.params.userId);
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(siteId)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    const data = matchedData(req);

    // Gestion du changement de rôle
    if (data.role !== undefined) {
      // Interdire de changer son propre rôle
      if (userId === req.user.id) {
        return res.status(400).json({ error: 'ERR_CANNOT_CHANGE_OWN_ROLE' });
      }
      // Interdire de promouvoir un admin global en manager de site
      const targetUser = db.getUserById(userId);
      if (targetUser && targetUser.role === 'admin') {
        return res.status(400).json({ error: 'ERR_CANNOT_CHANGE_ADMIN_SITE_ROLE' });
      }
      // Interdire de rétrograder le dernier manager du site
      if (data.role === 'user') {
        const managerCount = db.countSiteManagers(siteId);
        if (managerCount <= 1) {
          return res.status(400).json({ error: 'ERR_LAST_SITE_MANAGER' });
        }
      }
      db.setUserSiteRole(userId, siteId, data.role);
    }

    // Gestion du changement d'autorisation
    if (data.authorized !== undefined) {
      const authorized =
        data.authorized === true || data.authorized === 1 || data.authorized === '1' ? 1 : 0;
      db.setUserSiteAuthorized(userId, siteId, authorized);
      // Notifier l'utilisateur du changement de statut
      const user = db.getUserById(userId);
      const site = db.getSiteById(siteId);
      if (authorized) {
        notifications.sendReactivatedInSiteEmail(user, site).catch((err) => {
          logger.error(`Failed to send reactivated in site email: ${err.message}`);
        });
      } else {
        notifications.sendSuspendedInSiteEmail(user, site).catch((err) => {
          logger.error(`Failed to send suspended in site email: ${err.message}`);
        });
      }
    }

    res.json({ ok: true });
  }
);

router.delete(
  '/sites/:siteId/users/:userId',
  requireManager,
  ...validateSchema(schema.SiteUserParams),
  (req, res) => {
    const siteId = Number(req.params.siteId);
    const userId = Number(req.params.userId);
    // Vérifier que le manager gère ce site
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(siteId)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    db.removeUserFromSite(userId, siteId);
    // Notifier l'utilisateur qu'il a été retiré du site
    const user = db.getUserById(userId);
    const site = db.getSiteById(siteId);
    notifications.sendRemovedFromSiteEmail(user, site).catch((err) => {
      logger.error(`Failed to send removed from site email: ${err.message}`);
    });
    res.json({ ok: true });
  }
);

// ══════════════════════════════════════
//  USERS
// ══════════════════════════════════════
router.get('/users', requireRole('admin'), (req, res) => {
  res.json(db.getAllUsers());
});

router.post(
  '/users',
  requireRole('admin'),
  ...validateSchema(schema.User, schema.UserRole),
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    try {
      const user = db.createUser(data.useremail, data.password, req.body.role, data.shortname);
      res.status(201).json(user);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.put(
  '/users/:id',
  requireRole('admin'),
  ...validateSchema(schema.IdParam, schema.UserUpdate, schema.UserRole),
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    data.role = req.body.role; // role n'est pas dans le schéma de validation, on le prend directement depuis req.body
    try {
      const targetId = Number(req.params.id);
      const target = db.getUserById(targetId);
      if (target && target.role === 'admin' && data.role === 'user') {
        const adminCount = db.getAllUsers().filter((u) => u.role === 'admin').length;
        if (adminCount <= 1) {
          return res.status(403).json({ error: 'ERR_CANNOT_DEMOTE_LAST_ADMIN' });
        }
      }
      const user = db.updateUser(targetId, data);
      res.json(user);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.delete('/users/:id', requireRole('admin'), ...validateSchema(schema.IdParam), (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(403).json({ error: 'ERR_CANNOT_DELETE_SELF' });
  }
  const target = db.getUserById(targetId);
  if (target && target.role === 'admin') {
    const adminCount = db.getAllUsers().filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) {
      return res.status(403).json({ error: 'ERR_CANNOT_DELETE_LAST_ADMIN' });
    }
  }
  db.deleteUser(targetId);
  res.json({ ok: true });
});

// ── Sites assignés ──
router.put(
  '/users/:id/sites',
  requireRole('admin'),
  ...validateSchema(schema.IdParam, schema.UserSitesAssignment),
  (req, res) => {
    const userId = Number(req.params.id);
    const user = db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'ERR_UNKNOWN_USER' });
    const sites = req.body.sites;
    if (!Array.isArray(sites)) return res.status(400).json({ error: 'ERR_INVALID_SITES' });
    try {
      db.setUserSites(userId, sites);
      res.json(db.getUserById(userId));
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

// ══════════════════════════════════════
//  CHARGEPOINTS
// ══════════════════════════════════════
router.get('/chargepoints', requireManager, (req, res) => {
  let cps = db.getAllChargepoints();
  cps = filterBySite(req, cps);
  // Ajouter les connecteurs pour chaque CP
  cps = cps.map((cp) => ({
    ...cp,
    connectors: db.getConnectorsByChargepoint(cp.id),
    online: getConnectedClients().has(cp.identity),
  }));
  res.json(cps);
});

// ── Bornes en attente de validation ──
router.get('/chargepoints/pending', requireRole('admin'), (req, res) => {
  const list = Array.from(pendingChargepoints.values());
  res.json(list);
});

router.post(
  '/chargepoints/pending/:identity/accept',
  requireRole('admin'),
  ...validateSchema(schema.PendingChargepointIdentity, schema.ChargePointSite),
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    const identity = req.params.identity;
    const pending = pendingChargepoints.get(identity);
    if (!pending) return res.status(404).json({ error: 'ERR_NO_PENDING_CHARGEPOINT' });

    try {
      const cp = db.createChargepoint(identity, identity, pending.password, 0, data.site_id);
      pendingChargepoints.delete(identity);
      res.json(cp);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.delete(
  '/chargepoints/pending/:identity',
  requireRole('admin'),
  ...validateSchema(schema.PendingChargepointIdentity),
  (req, res) => {
    const identity = req.params.identity;
    if (!pendingChargepoints.has(identity))
      return res.status(404).json({ error: 'ERR_NO_PENDING_CHARGEPOINT' });
    pendingChargepoints.delete(identity);
    res.json({ ok: true });
  }
);

router.get('/chargepoints/:id', requireManager, ...validateSchema(schema.IdParam), (req, res) => {
  const cp = db.getChargepointById(Number(req.params.id));
  if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
  // Vérifier que le manager gère ce site
  if (req.user.role !== 'admin') {
    const managedIds = getUserManagedSiteIds(req);
    if (managedIds !== null && !managedIds.includes(cp.site_id)) {
      return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
    }
  }
  cp.connectors = db.getConnectorsByChargepoint(cp.id);
  cp.online = getConnectedClients().has(cp.identity);
  res.json(cp);
});

router.put(
  '/chargepoints/:id',
  requireRole('admin'),
  ...validateSchema(schema.IdParam, schema.ChargePoint),
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    try {
      // Récupérer l'état avant mise à jour pour détecter un changement d'autorisation
      const before = db.getChargepointById(Number(req.params.id));
      const cp = db.updateChargepoint(Number(req.params.id), data);
      // Si authorized passe de 1 à 0, déconnecter la borne immédiatement
      if (before && before.authorized && cp && !cp.authorized) {
        disconnectChargepoint(cp.identity);
      }
      res.json(cp);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.put(
  '/chargepoints/:id/assign',
  requireRole('admin'),
  ...validateSchema(schema.IdParam, schema.ChargePointSite),
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    try {
      const cp = db.assignChargepointToSite(Number(req.params.id), data.site_id);
      res.json(cp);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.post('/chargepoints', requireRole('admin'), checkSchema(schema.ChargePoint), (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ error: result.array().map((e) => e.msg) });
  }
  const data = matchedData(req);
  try {
    const cp = db.createChargepoint(
      data.identity,
      data.name,
      data.password,
      data.mode,
      data.site_id
    );
    res.status(201).json(cp);
  } catch (e) {
    errorResponse(res, 400, e.message);
  }
});

router.delete(
  '/chargepoints/:id',
  requireRole('admin'),
  ...validateSchema(schema.IdParam),
  (req, res) => {
    db.deleteChargepoint(Number(req.params.id));
    res.json({ ok: true });
  }
);

// ── Commandes OCPP vers la borne ──
router.post(
  '/chargepoints/:id/command',
  requireManager,
  ...validateSchema(schema.IdParam, schema.OcppCommand),
  async (req, res) => {
    const cp = db.getChargepointById(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    // Vérifier que le manager gère ce site
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(cp.site_id)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    const method = req.body.method;
    const params = req.body.params || {};

    try {
      const result = await callClient(client, cp.identity, method, params);
      res.json({ result });
    } catch (e) {
      db.addOcppMessage(cp.id, 'chargepoint', 'CALLERROR', method, { error: e.message });
      errorResponse(res, 500, e.message);
    }
  }
);

// ══════════════════════════════════════
//  CONNECTEURS (vue globale)
// ══════════════════════════════════════
router.get('/connectors', requireManager, (req, res) => {
  const siteIds = getUserManagedSiteIds(req);
  const connectors = db.getAllConnectorsGrouped(siteIds);
  // Enrichir avec l'état online
  const enriched = connectors.map((c) => ({
    ...c,
    online: getConnectedClients().has(c.chargepoint_identity),
  }));
  res.json(enriched);
});

// Modifier les champs d'un connecteur (nom, puissance, type)
router.put(
  '/connectors/:id',
  requireManager,
  ...validateSchema(schema.IdParam, schema.ConnectorDetails),
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);

    // Vérifier que le manager gère ce site
    const cp = db.getConnectorById(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CONNECTOR_NOT_FOUND' });
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(cp.site_id)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }

    try {
      const { connector_name, connector_power, connector_type } = data;
      const connector = db.updateConnectorFields(Number(req.params.id), {
        connector_name: connector_name !== undefined ? connector_name : undefined,
        connector_power:
          connector_power !== undefined
            ? connector_power === '' || connector_power === null
              ? null
              : parseInt(connector_power, 10)
            : undefined,
        connector_type: connector_type !== undefined ? connector_type : undefined,
      });
      res.json(connector);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

// Démarrer une recharge depuis la page connecteurs (admin/manager)
router.post(
  '/connectors/start-charge',
  requireManager,
  ...validateSchema(schema.StartCharge),
  async (req, res) => {
    const { chargepoint_id, connector_id } = req.body;

    const cp = db.getChargepointById(Number(chargepoint_id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    // Vérifier que le manager gère ce site
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(cp.site_id)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    let idTag;
    // Créer/récup un idTag pour admin
    if (req.user.role === 'admin') {
      idTag = `ADMIN`;
      const existingTag = db.getIdTagByTag(idTag, null);
      if (!existingTag) {
        db.createIdTag(idTag, null, null, `Tag admin auto`, null);
      }
    } else {
      // Créer/récup un idTag pour manager sur ce site
      idTag = `MGR-${cp.site_id}`;
      const existingTag = db.getIdTagByTag(idTag, cp.site_id);
      if (!existingTag) {
        db.createIdTag(idTag, null, cp.site_id, `Tag manager site ${cp.site_id} auto`, null);
      }
    }

    const pendingKey = `${cp.identity}_${connector_id}`;
    pendingRemoteStarts.set(pendingKey, { source: 'web', userId: null });
    setTimeout(() => pendingRemoteStarts.delete(pendingKey), 60000);

    try {
      const result = await callClient(client, cp.identity, 'RemoteStartTransaction', {
        idTag,
        connectorId: Number(connector_id),
      });
      if (result.status !== 'Accepted') {
        pendingRemoteStarts.delete(pendingKey);
      }
      res.json({ result, idTag });
    } catch (err) {
      pendingRemoteStarts.delete(pendingKey);
      errorResponse(res, 500, err.message);
    }
  }
);

// Arrêter une recharge depuis la page connecteurs (admin/manager)
router.post(
  '/connectors/stop-charge',
  requireManager,
  ...validateSchema(schema.StopCharge),
  async (req, res) => {
    const { chargepoint_id, transaction_id } = req.body;

    const cp = db.getChargepointById(Number(chargepoint_id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    // Vérifier que le manager gère ce site
    if (req.user.role !== 'admin') {
      const managedIds = getUserManagedSiteIds(req);
      if (managedIds !== null && !managedIds.includes(cp.site_id)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    try {
      const result = await callClient(client, cp.identity, 'RemoteStopTransaction', {
        transactionId: Number(transaction_id),
      });
      res.json({ result });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── Configuration de la borne ──
router.get(
  '/chargepoints/:id/config',
  requireRole('admin'),
  ...validateSchema(schema.IdParam),
  (req, res) => {
    const cp = db.getChargepointById(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });
    res.json(db.getChargepointConfig(cp.id));
  }
);

router.post(
  '/chargepoints/:id/config/refresh',
  requireRole('admin'),
  ...validateSchema(schema.IdParam),
  async (req, res) => {
    const cp = db.getChargepointById(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    try {
      const result = await callClient(client, cp.identity, 'GetConfiguration', {});
      res.json({ result, config: db.getChargepointConfig(cp.id) });
    } catch (e) {
      errorResponse(res, 500, e.message);
    }
  }
);

router.put(
  '/chargepoints/:id/config/:key',
  requireRole('admin'),
  ...validateSchema(schema.IdParam, schema.ChargepointConfigUpdate),
  async (req, res) => {
    const cp = db.getChargepointById(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    const key = req.params.key;
    const value = req.body.value;

    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'ERR_VALUE_REQUIRED' });
    }

    const GLOBAL_ONLY_KEYS = ['HeartbeatInterval'];
    if (GLOBAL_ONLY_KEYS.includes(key)) {
      return res.status(400).json({ error: 'ERR_KEY_NOT_OVERRIDABLE' });
    }

    try {
      const result = await callClient(client, cp.identity, 'ChangeConfiguration', {
        key,
        value: String(value),
      });

      if (result.status === 'Accepted' || result.status === 'RebootRequired') {
        // is_override = false si la valeur correspond au défaut global activé, true sinon
        const globalCfg = db.getInitialChargepointConfigByKey(key);
        const isOverride = !(globalCfg?.enabled && globalCfg.value === String(value));
        db.upsertChargepointConfig(cp.id, key, String(value), false, isOverride);
      }

      res.json({ result, status: result.status });
    } catch (e) {
      errorResponse(res, 500, e.message);
    }
  }
);

// ══════════════════════════════════════
//  INIT CONFIG (chargepoint defaults)
// ══════════════════════════════════════
router.get('/init-config', requireRole('admin'), (req, res) => {
  res.json(db.getInitialChargepointConfig());
});

router.post(
  '/init-config',
  requireRole('admin'),
  ...validateSchema(schema.InitConfig),
  (req, res) => {
    const { key, value } = matchedData(req);
    try {
      const result = db.createInitialChargepointConfig(key, value, false);
      res.json({ id: result.lastInsertRowid });
    } catch (e) {
      if (e.message?.includes('UNIQUE')) {
        return errorResponse(res, 409, 'INIT_CONFIG_KEY_EXISTS');
      }
      errorResponse(res, 500, e.message);
    }
  }
);

router.put(
  '/init-config/:id',
  requireRole('admin'),
  ...validateSchema(schema.IdParam, schema.InitConfigUpdate),
  (req, res) => {
    const { id } = req.params;
    const data = matchedData(req, { locations: ['body'] });
    db.updateInitialChargepointConfig(Number(id), data);
    res.json({ ok: true });
  }
);

router.delete(
  '/init-config/:id',
  requireRole('admin'),
  ...validateSchema(schema.IdParam),
  (req, res) => {
    db.deleteInitialChargepointConfig(Number(req.params.id));
    res.json({ ok: true });
  }
);

router.post(
  '/init-config/chargepoint/:id/apply',
  requireRole('admin'),
  ...validateSchema(schema.IdParam),
  async (req, res) => {
    const cp = db.getChargepointById(Number(req.params.id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    const globals = db.getEnabledInitialChargepointConfig();
    for (const cfg of globals) {
      const current = db.getChargepointConfigByKey(cp.id, cfg.key);
      if (current?.is_override) continue; // override admin, on ne touche pas
      try {
        const result = await callClient(client, cp.identity, 'ChangeConfiguration', {
          key: cfg.key,
          value: cfg.value,
        });
        if (result?.status === 'Accepted' || result?.status === 'RebootRequired') {
          db.upsertChargepointConfig(cp.id, cfg.key, cfg.value, false);
        }
      } catch (e) {
        logger.warn(`[InitSeq] ${cp.identity} ChangeConfiguration ${cfg.key}: ${e.message}`);
      }
    }
  }
);

// ══════════════════════════════════════
//  TRANSACTIONS
// ══════════════════════════════════════
router.get(
  '/transactions',
  requireManager,
  ...validateSchema(schema.TransactionsQuery),
  (req, res) => {
    const filters = {};
    if (req.query.chargepoint_id) filters.chargepoint_id = Number(req.query.chargepoint_id);
    if (req.query.site_id) filters.site_id = Number(req.query.site_id);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.from) filters.from = req.query.from;
    if (req.query.to) filters.to = req.query.to;
    const limit = parsePagination(req);
    if (limit !== null) filters.limit = limit;

    const user = req.user;
    if (user.role !== 'admin') {
      const siteIds = getUserSiteIds(req);
      if (siteIds && siteIds.length > 0) {
        filters.site_ids = siteIds;
      } else if (siteIds && siteIds.length === 0) {
        return res.json([]);
      }
    }

    res.json(db.getTransactions(filters));
  }
);

router.get(
  '/transactions/csv',
  requireManager,
  ...validateSchema(schema.TransactionsQuery),
  (req, res) => {
    const filters = {};
    if (req.query.chargepoint_id) filters.chargepoint_id = Number(req.query.chargepoint_id);
    if (req.query.site_id) filters.site_id = Number(req.query.site_id);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.from) filters.from = req.query.from;
    if (req.query.to) filters.to = req.query.to;

    const user = req.user;
    if (user.role !== 'admin') {
      const siteIds = getUserSiteIds(req);
      if (siteIds && siteIds.length > 0) {
        filters.site_ids = siteIds;
      } else if (siteIds && siteIds.length === 0) {
        return res.status(403).json({ error: 'ERR_NO_AUTHORIZED_SITE' });
      }
    }

    const transactions = db.getTransactions(filters);
    const lng = req.user.langue || 'fr';
    const headers = [
      trad('csvExportTitle.transaction_id', { lng }),
      trad('csvExportTitle.chargepoint', { lng }),
      trad('csvExportTitle.site', { lng }),
      trad('csvExportTitle.connector', { lng }),
      trad('csvExportTitle.tag', { lng }),
      trad('csvExportTitle.user', { lng }),
      trad('csvExportTitle.source', { lng }),
      trad('csvExportTitle.start', { lng }),
      trad('csvExportTitle.end', { lng }),
      trad('csvExportTitle.meter_start', { lng }),
      trad('csvExportTitle.meter_stop', { lng }),
      trad('csvExportTitle.energy', { lng }),
      trad('csvExportTitle.duration', { lng }),
      trad('csvExportTitle.status', { lng }),
      trad('csvExportTitle.stop_reason', { lng }),
    ];
    const csvRows = [headers.join(';')];
    for (const t of transactions) {
      const energy =
        t.meter_stop != null && t.meter_start != null
          ? ((t.meter_stop - t.meter_start) / 1000).toFixed(2)
          : '';
      let duration = '';
      if (t.start_time && t.stop_time) {
        const diffMs = new Date(t.stop_time) - new Date(t.start_time);
        duration = (diffMs / 60000).toFixed(1);
      }
      const row = [
        t.transaction_id,
        t.chargepoint_identity || '',
        t.site_name || '',
        t.connector_id,
        t.id_tag || '',
        t.tag_username || '',
        t.start_source || '',
        t.start_time || '',
        t.stop_time || '',
        t.meter_start != null ? t.meter_start : '',
        t.meter_stop != null ? t.meter_stop : '',
        energy,
        duration,
        t.status || '',
        t.stop_reason || '',
      ].map((v) => `"${String(v).replace(/"/g, '""').replace(/;/g, ',')}"`);
      csvRows.push(row.join(';'));
    }

    const csv = '\uFEFF' + csvRows.join('\r\n');
    const filename = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
);

// ══════════════════════════════════════
//  TRANSACTION VALUES (graphiques)
// ══════════════════════════════════════
router.get(
  '/transactions/:transactionId/values',
  requireAuth,
  ...validateSchema(schema.TransactionIdParam),
  (req, res) => {
    const transactionId = Number(req.params.transactionId);
    const values = db.getTransactionValues(transactionId);
    if (!values) return res.json({ energie: [], courant: [], soc: [] });
    res.json({
      energie: values.energie ? JSON.parse(values.energie) : [],
      courant: values.courant ? JSON.parse(values.courant) : [],
      soc: values.soc ? JSON.parse(values.soc) : [],
    });
  }
);

// ══════════════════════════════════════
//  OCPP MESSAGES
// ══════════════════════════════════════
router.get(
  '/ocpp-messages',
  requireManager,
  ...validateSchema(schema.OcppMessagesQuery),
  (req, res) => {
    const filters = {};
    if (req.query.chargepoint_id) filters.chargepoint_id = Number(req.query.chargepoint_id);
    if (req.query.origin) filters.origin = req.query.origin;
    if (req.query.message_type) filters.message_type = req.query.message_type;
    if (req.query.action) filters.action = req.query.action;

    // Empêcher un manager de voir tous les messages hors de ses sites
    if (req.user.role !== 'admin') {
      const siteIds = getUserSiteIds(req);
      if (siteIds && siteIds.length > 0) {
        filters.site_ids = siteIds;
      } else if (siteIds && siteIds.length === 0) {
        return res.json([]);
      }
    }

    res.json(db.getOcppMessages(filters));
  }
);

router.delete(
  '/ocpp-messages',
  requireRole('admin'),
  ...validateSchema(schema.OcppMessagesQuery),
  (req, res) => {
    db.clearOcppMessages(req.query.chargepoint_id ? Number(req.query.chargepoint_id) : null);
    res.json({ ok: true });
  }
);

// ══════════════════════════════════════
//  ID TAGS
// ══════════════════════════════════════
router.get('/id-tags', requireManager, (req, res) => {
  let tags = db.getAllIdTags();
  // Filtrer par sites gérés si l'utilisateur n'est pas admin
  if (req.user.role !== 'admin') {
    const managedSiteIds = getUserManagedSiteIds(req);
    if (managedSiteIds !== null) {
      tags = tags.filter((t) => !t.site_id || managedSiteIds.includes(t.site_id));
    }
  }
  res.json(tags);
});

router.get('/id-tags/:id', requireManager, ...validateSchema(schema.IdParam), (req, res) => {
  const tag = db.getIdTagById(Number(req.params.id));
  if (!tag) return res.status(404).json({ error: 'ERR_TAG_NOT_FOUND' });
  res.json(tag);
});

router.post('/id-tags', requireManager, checkSchema(schema.IdTag), (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ error: result.array().map((e) => e.msg) });
  }
  const data = matchedData(req);
  // Un manager doit obligatoirement spécifier un site qu'il gère
  if (req.user.role !== 'admin') {
    if (!data.site_id) {
      return res.status(400).json({ error: 'ERR_SITE_REQUIRED' });
    }
    const managedSiteIds = getUserManagedSiteIds(req);
    if (managedSiteIds !== null && !managedSiteIds.includes(data.site_id)) {
      return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
    }
  }
  // Vérifier l'unicité du couple (id_tag, site_id)
  const existing = db.getIdTagByTag(data.id_tag, data.site_id || null);
  if (
    existing &&
    existing.id_tag === data.id_tag &&
    (existing.site_id || null) === (data.site_id || null)
  ) {
    return res.status(400).json({ error: 'ERR_TAG_ALREADY_EXISTS' });
  }
  try {
    const tag = db.createIdTag(
      data.id_tag,
      data.user_id,
      data.site_id,
      data.description,
      data.expiry_date
    );
    res.status(201).json(tag);
  } catch (e) {
    errorResponse(res, 400, e.message);
  }
});

router.put(
  '/id-tags/:id',
  requireManager,
  ...validateSchema(schema.IdParam, schema.IdTag),
  (req, res) => {
    // Vérifier si le tag est auto-généré (WEB-*)
    const existing = db.getIdTagById(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: 'ERR_TAG_NOT_FOUND' });
    if (existing.id_tag.startsWith('WEB-')) {
      return res.status(403).json({ error: 'ERR_AUTOTAG_READONLY' });
    }
    // Un manager ne peut modifier que les tags de ses sites
    if (req.user.role !== 'admin') {
      const managedSiteIds = getUserManagedSiteIds(req);
      if (
        managedSiteIds !== null &&
        (!existing.site_id || !managedSiteIds.includes(existing.site_id))
      ) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: result.array().map((e) => e.msg) });
    }
    const data = matchedData(req);
    // Préserver les valeurs null explicites (matchedData les exclut à cause de optional+nullable)
    if (req.body.site_id === null && data.site_id === undefined) data.site_id = null;
    if (req.body.user_id === null && data.user_id === undefined) data.user_id = null;
    // Un manager ne peut pas changer le site du tag vers un site qu'il ne gère pas
    if (req.user.role !== 'admin') {
      if (!data.site_id) {
        return res.status(400).json({ error: 'ERR_SITE_REQUIRED' });
      }
      const managedSiteIds = getUserManagedSiteIds(req);
      if (managedSiteIds !== null && !managedSiteIds.includes(data.site_id)) {
        return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
      }
    }
    try {
      const tag = db.updateIdTag(Number(req.params.id), data);
      if (!tag) return res.status(404).json({ error: 'ERR_TAG_NOT_FOUND' });
      res.json(tag);
    } catch (e) {
      errorResponse(res, 400, e.message);
    }
  }
);

router.delete('/id-tags/:id', requireManager, ...validateSchema(schema.IdParam), (req, res) => {
  // Vérifier si le tag est auto-généré (WEB-*)
  const existing = db.getIdTagById(Number(req.params.id));
  if (existing && existing.id_tag.startsWith('WEB-')) {
    return res.status(403).json({ error: 'ERR_AUTOTAG_NO_DELETE' });
  }
  // Un manager ne peut supprimer que les tags de ses sites
  if (req.user.role !== 'admin' && existing) {
    const managedSiteIds = getUserManagedSiteIds(req);
    if (
      managedSiteIds !== null &&
      (!existing.site_id || !managedSiteIds.includes(existing.site_id))
    ) {
      return res.status(403).json({ error: 'ERR_SITE_NOT_MANAGED' });
    }
  }
  db.deleteIdTag(Number(req.params.id));
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  ID TAGS EVENTS (rejets d'autorisation)
// ══════════════════════════════════════
router.get(
  '/id-tags-events',
  requireManager,
  ...validateSchema(schema.IdTagEventsQuery),
  (req, res) => {
    const filters = {};
    if (req.query.chargepoint_id) filters.chargepoint_id = Number(req.query.chargepoint_id);
    if (req.query.id_tag) filters.id_tag = req.query.id_tag;
    if (req.query.status) filters.status = req.query.status;
    const limit = parsePagination(req);
    if (limit !== null) filters.limit = limit;
    // Filtrer par sites accessibles
    const siteIds = getUserSiteIds(req);
    if (siteIds !== null) filters.site_ids = siteIds;
    const events = db.getIdTagEvents(filters);
    res.json(events);
  }
);

// ══════════════════════════════════════
//  DASHBOARD STATS
// ══════════════════════════════════════
router.get('/dashboard', requireManager, (req, res) => {
  const allCps = db.getAllChargepoints();
  const filtered = filterBySite(req, allCps);
  const connected = filtered.filter((cp) => getConnectedClients().has(cp.identity));
  const siteIds = getUserSiteIds(req);
  const sitesCount = siteIds === null ? db.getAllSites().length : siteIds.length;

  // Filtrer les transactions actives par sites
  const txFilters = { status: 'Active' };
  if (siteIds !== null && siteIds.length > 0) {
    txFilters.site_ids = siteIds;
  }

  // Stats connecteurs
  const connectors = db.getAllConnectorsGrouped(siteIds);
  const connectedIdentities = getConnectedClients();
  const connectorStats = {
    Available: 0,
    Preparing: 0,
    Charging: 0,
    SuspendedEV: 0,
    SuspendedEVSE: 0,
    Finishing: 0,
    Reserved: 0,
    Unavailable: 0,
    Faulted: 0,
    Offline: 0,
  };
  connectors.forEach((c) => {
    const online = connectedIdentities.has(c.chargepoint_identity);
    if (!online) {
      connectorStats.Offline++;
    } else {
      const st = c.cnstatus || 'Unknown';
      if (Object.prototype.hasOwnProperty.call(connectorStats, st)) connectorStats[st]++;
      else connectorStats[st] = 1;
    }
  });

  res.json({
    totalChargepoints: filtered.length,
    connectedChargepoints: connected.length,
    totalSites: sitesCount,
    activeTransactions:
      siteIds === null || siteIds.length > 0 ? db.getTransactions(txFilters).length : 0,
    totalConnectors: connectors.length,
    connectorStats,
  });
});

router.get('/dashboard/chart-data', requireManager, (req, res) => {
  const siteIds = getUserSiteIds(req);
  const days = Math.min(Number(req.query.days) || 30, 365);
  res.json(db.getDashboardChartData(siteIds, days));
});

router.get('/dashboard/kpi', requireManager, (req, res) => {
  const siteIds = getUserSiteIds(req);
  const days = Math.min(Number(req.query.days) || 30, 365);
  res.json(db.getChargingKpi(siteIds, days));
});

// ══════════════════════════════════════
//  DASHBOARD UTILISATEUR
// ══════════════════════════════════════
router.get('/user/dashboard', requireAuth, (req, res) => {
  try {
    const stats = db.getUserDashboardStats(req.user.id);
    const connectors = db.getAvailableConnectorsForUser(req.user.id);
    const enriched = connectors.map((c) => ({
      ...c,
      online: getConnectedClients().has(c.chargepoint_identity),
      is_own_transaction: c.active_user_id === req.user.id,
    }));
    const totalCount = enriched.filter((c) => c.site_authorized).length;
    const availableCount = enriched.filter(
      (c) =>
        c.online && c.site_authorized && (c.cnstatus === 'Available' || c.cnstatus === 'Preparing')
    ).length;

    res.json({
      ...stats,
      totalConnectors: totalCount,
      availableConnectors: availableCount,
      connectors: enriched,
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ══════════════════════════════════════
//  RECHARGE UTILISATEUR (depuis le site web)
// ══════════════════════════════════════

// Récupérer les connecteurs disponibles pour l'utilisateur connecté
router.get('/user/available-connectors', requireAuth, (req, res) => {
  try {
    const connectors = db.getAvailableConnectorsForUser(req.user.id);
    // Enrichir avec l'état online et la détection de transaction propre
    const enriched = connectors.map((c) => ({
      ...c,
      online: getConnectedClients().has(c.chargepoint_identity),
      is_own_transaction: c.active_user_id === req.user.id,
    }));
    res.json(enriched);
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// Démarrer une recharge depuis le site web
router.post(
  '/user/start-charge',
  requireAuth,
  ...validateSchema(schema.StartCharge),
  async (req, res) => {
    const { chargepoint_id, connector_id } = req.body;

    const cp = db.getChargepointById(Number(chargepoint_id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    // Vérifier que l'utilisateur est autorisé sur le site de la borne
    if (cp.site_id) {
      const user = req.user;
      if (user.role !== 'admin') {
        const userSite = (user.sites || []).find((s) => s.site_id === cp.site_id);
        if (!userSite || !userSite.authorized) {
          return res.status(403).json({ error: 'ERR_USER_NOT_AUTHORIZED_IN_SITE' });
        }
      }
    }

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    // Trouver un id_tag associé à l'utilisateur pour cette borne
    const userTags = db
      .getAllIdTags()
      .filter(
        (t) => t.user_id === req.user.id && t.active && (!t.site_id || t.site_id === cp.site_id)
      );
    let idTag;
    if (userTags.length > 0) {
      idTag = userTags[0].id_tag;
    } else {
      // Créer automatiquement un tag web lié à l'utilisateur
      idTag = `WEB-${req.user.id}`;
      const existingTag = db.getIdTagByTag(idTag, cp.site_id);
      if (!existingTag) {
        db.createIdTag(
          idTag,
          req.user.id,
          null,
          `Tag web auto (${req.user.shortname || req.user.useremail})`,
          null
        );
      }
    }

    // Marquer ce démarrage comme venant du web
    const pendingKey = `${cp.identity}_${connector_id}`;
    pendingRemoteStarts.set(pendingKey, { source: 'web', userId: req.user.id });
    // Timeout de nettoyage au cas où la borne ne répond pas
    setTimeout(() => pendingRemoteStarts.delete(pendingKey), 60000);

    try {
      const result = await callClient(client, cp.identity, 'RemoteStartTransaction', {
        idTag,
        connectorId: Number(connector_id),
      });
      if (result.status !== 'Accepted') {
        pendingRemoteStarts.delete(pendingKey);
      }
      res.json({ result, idTag });
    } catch (err) {
      pendingRemoteStarts.delete(pendingKey);
      errorResponse(res, 500, err.message);
    }
  }
);

// Stats KPI des transactions de l'utilisateur courant
router.get(
  '/user/transactions/stats',
  requireAuth,
  ...validateSchema(schema.UserTransactionsQuery),
  (req, res) => {
    const filters = {};
    if (req.query.from) filters.from = req.query.from;
    if (req.query.to) filters.to = req.query.to;
    res.json(db.getUserTransactionStats(req.user.id, filters));
  }
);

// Historique des transactions de l'utilisateur courant
router.get(
  '/user/transactions',
  requireAuth,
  ...validateSchema(schema.UserTransactionsQuery),
  (req, res) => {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.from) filters.from = req.query.from;
    if (req.query.to) filters.to = req.query.to;
    res.json(db.getUserTransactions(req.user.id, filters));
  }
);

// Export CSV des transactions de l'utilisateur courant
router.get(
  '/user/transactions/csv',
  requireAuth,
  ...validateSchema(schema.UserTransactionsQuery),
  (req, res) => {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.from) filters.from = req.query.from;
    if (req.query.to) filters.to = req.query.to;
    const transactions = db.getUserTransactions(req.user.id, filters);

    const lng = req.user.langue || 'fr';
    const headers = [
      trad('csvExportTitle.transaction_id', { lng }),
      trad('csvExportTitle.chargepoint', { lng }),
      trad('csvExportTitle.site', { lng }),
      trad('csvExportTitle.connector', { lng }),
      trad('csvExportTitle.tag', { lng }),
      trad('csvExportTitle.source', { lng }),
      trad('csvExportTitle.start', { lng }),
      trad('csvExportTitle.end', { lng }),
      trad('csvExportTitle.meter_start', { lng }),
      trad('csvExportTitle.meter_stop', { lng }),
      trad('csvExportTitle.energy', { lng }),
      trad('csvExportTitle.duration', { lng }),
      trad('csvExportTitle.status', { lng }),
      trad('csvExportTitle.stop_reason', { lng }),
    ];
    const csvRows = [headers.join(';')];
    for (const t of transactions) {
      const energy =
        t.meter_stop != null && t.meter_start != null
          ? ((t.meter_stop - t.meter_start) / 1000).toFixed(2)
          : '';
      let duration = '';
      if (t.start_time && t.stop_time) {
        const diffMs = new Date(t.stop_time) - new Date(t.start_time);
        duration = (diffMs / 60000).toFixed(1);
      }
      const row = [
        t.transaction_id,
        t.chargepoint_identity || '',
        t.site_name || '',
        t.connector_id,
        t.id_tag || '',
        t.start_source || '',
        t.start_time || '',
        t.stop_time || '',
        t.meter_start != null ? t.meter_start : '',
        t.meter_stop != null ? t.meter_stop : '',
        energy,
        duration,
        t.status || '',
        t.stop_reason || '',
      ].map((v) => `"${String(v).replace(/"/g, '""').replace(/;/g, ',')}"`);
      csvRows.push(row.join(';'));
    }

    const csv = '\uFEFF' + csvRows.join('\r\n');
    const filename = `mes-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
);

// Arrêter une recharge depuis le site web
router.post(
  '/user/stop-charge',
  requireAuth,
  ...validateSchema(schema.StopCharge),
  async (req, res) => {
    const { chargepoint_id, transaction_id } = req.body;

    const cp = db.getChargepointById(Number(chargepoint_id));
    if (!cp) return res.status(404).json({ error: 'ERR_CHARGEPOINT_NOT_FOUND' });

    // Vérifier que la transaction appartient à l'utilisateur
    const transactions = db.getTransactions({ chargepoint_id: cp.id, status: 'Active' });
    const tx = transactions.find((t) => t.transaction_id === Number(transaction_id));
    if (!tx) return res.status(404).json({ error: 'ERR_TRANSACTION_NOT_FOUND' });

    // Vérifier que le tag de la transaction est lié à l'utilisateur (sauf admin)
    if (req.user.role !== 'admin') {
      const tag = tx.id_tag ? db.getIdTagByTag(tx.id_tag, cp.site_id) : null;
      if (!tag || tag.user_id !== req.user.id) {
        return res.status(403).json({ error: 'ERR_TRANSACTION_NOT_OWNED' });
      }
    }

    const client = getConnectedClients().get(cp.identity);
    if (!client) return res.status(400).json({ error: 'ERR_CHARGEPOINT_OFFLINE' });

    try {
      const result = await callClient(client, cp.identity, 'RemoteStopTransaction', {
        transactionId: Number(transaction_id),
      });
      res.json({ result });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ══════════════════════════════════════
//  PROFIL UTILISATEUR
// ══════════════════════════════════════

// Récupérer le profil de l'utilisateur connecté
router.get('/user/profile', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'ERR_UNKNOWN_USER' });
  res.json({
    id: user.id,
    useremail: user.useremail,
    shortname: user.shortname,
    role: user.role,
    langue: user.langue,
    ntif_pushuser: user.ntif_pushuser,
    ntif_pushtokn: user.ntif_pushtokn,
  });
});

// Mettre à jour le profil (email, nom, mot de passe)
router.put('/user/profile', requireAuth, checkSchema(schema.UserProfile), (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ error: result.array().map((e) => e.msg) });
  }
  const data = matchedData(req);
  const userId = req.user.id;

  // Vérifier le mot de passe actuel si changement de mot de passe
  if (data.newPassword) {
    const user = db.getUserByEmail(req.user.useremail);
    const bcrypt = require('bcryptjs');
    if (!data.currentPassword || !bcrypt.compareSync(data.currentPassword, user.password)) {
      return res.status(403).json({ error: 'ERR_WRONG_ACTUAL_PASSWORD' });
    }
  }

  // Vérifier que le nouvel email n'est pas déjà pris par un autre utilisateur
  if (data.useremail && data.useremail !== req.user.useremail) {
    const existing = db.getUserByEmail(data.useremail);
    if (existing && existing.id !== userId) {
      return res.status(409).json({ error: 'ERR_EMAIL_ALREADY_USED' });
    }
  }

  try {
    const updateData = {};
    if (data.useremail) updateData.useremail = data.useremail;
    if (data.shortname !== undefined) updateData.shortname = data.shortname;
    if (data.newPassword) updateData.password = data.newPassword;
    if (data.ntif_pushuser !== undefined) updateData.ntif_pushuser = data.ntif_pushuser;
    if (data.ntif_pushtokn !== undefined) updateData.ntif_pushtokn = data.ntif_pushtokn;
    if (data.langue !== undefined) updateData.langue = data.langue;

    const updated = db.updateUser(userId, updateData);
    // Mettre à jour la session
    req.user.useremail = updated.useremail;
    req.user.shortname = updated.shortname;
    res.json({
      id: updated.id,
      useremail: updated.useremail,
      shortname: updated.shortname,
      role: updated.role,
      langue: updated.langue,
      ntif_pushuser: updated.ntif_pushuser,
      ntif_pushtokn: updated.ntif_pushtokn,
    });
  } catch (e) {
    errorResponse(res, 400, e.message);
  }
});

// ══════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════

// Récupérer les événements disponibles et les préférences de l'utilisateur connecté
router.get('/notifications/preferences', requireAuth, (req, res) => {
  const events = notifications.getEventsForUser(req.user);
  const prefs = db.getNotificationPreferences(req.user.id);
  const channels = notifications.getAvailableChannels();
  const subscriptions = db.getPushSubscriptions(req.user.id);
  res.json({ events, preferences: prefs, channels, hasPushSubscription: subscriptions.length > 0 });
});

// Mettre à jour les préférences de notification
router.put(
  '/notifications/preferences',
  requireAuth,
  ...validateSchema(schema.NotificationPreferences),
  (req, res) => {
    const { preferences } = req.body;
    if (!Array.isArray(preferences)) {
      return res.status(400).json({ error: 'ERR_USERPREF_TABLE' });
    }
    // Vérifier que l'utilisateur ne configure que des événements auxquels il a accès
    const allowedEvents = notifications.getEventsForUser(req.user);
    const invalid = preferences.filter((p) => !allowedEvents[p.event_type]);
    if (invalid.length > 0) {
      return res.status(403).json({
        error: 'ERR_UNAUTHORIZED_EVENTS',
        params: { events: invalid.map((p) => p.event_type).join(', ') },
      });
    }
    db.setNotificationPreferencesBulk(req.user.id, preferences);
    res.json({ ok: true });
  }
);

// Enregistrer un abonnement Web Push
router.post(
  '/notifications/push/subscribe',
  requireAuth,
  ...validateSchema(schema.PushSubscribe),
  (req, res) => {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'ERR_INVALID_SUBSCRIPTION' });
    }
    db.savePushSubscription(req.user.id, subscription, req.headers['user-agent']);
    res.json({ ok: true });
  }
);

// Supprimer un abonnement Web Push
router.post(
  '/notifications/push/unsubscribe',
  requireAuth,
  ...validateSchema(schema.PushUnsubscribe),
  (req, res) => {
    const { endpoint } = req.body;
    if (endpoint) {
      db.deletePushSubscription(endpoint);
    } else {
      db.deletePushSubscriptionsByUser(req.user.id);
    }
    res.json({ ok: true });
  }
);

// Récupérer la clé publique VAPID (nécessaire côté client pour s'abonner)
router.get('/notifications/push/vapid-key', (req, res) => {
  const config = getConfig();
  if (
    !config.notifs ||
    !config.notifs.webpush ||
    !config.notifs.webpush.enabled ||
    !config.notifs.webpush.vapidPublicKey
  ) {
    return res.status(404).json({ error: 'ERR_WEBPUSH_NOT_CONFIGURED' });
  }
  res.json({ publicKey: config.notifs.webpush.vapidPublicKey });
});

// Historique des notifications (pour l'utilisateur connecté)
router.get(
  '/notifications/log',
  requireAuth,
  ...validateSchema(schema.NotificationsLogQuery),
  (req, res) => {
    const limit = parsePagination(req) ?? 50;
    res.json(db.getNotificationLog(req.user.id, limit));
  }
);

router.delete('/notifications/log', requireAuth, (req, res) => {
  db.clearNotificationLog(req.user.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  CONFIG EDITOR
// ══════════════════════════════════════
router.get('/configeditor', requireRole('admin'), (req, res) => {
  const rawFile = JSON.parse(fs.readFileSync(getConfigFilePath(), 'utf-8'));
  const fields = CONFIG_FIELDS.map((field) => {
    const envEntry = ENV_OVERRIDES.find((e) => e.path.join('.') === field.key);
    const envVar = envEntry?.env ?? null;
    const envValue = envVar ? (process.env[envVar] ?? null) : null;
    return {
      ...field,
      envVar,
      envValue,
      fileValue: deepGet(rawFile, field.key) ?? null,
    };
  });
  res.json({ fields });
});

router.put('/configeditor', requireRole('admin'), (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'ERR_INVALID_BODY' });
  }
  const rawFile = JSON.parse(fs.readFileSync(getConfigFilePath(), 'utf-8'));
  const validKeys = new Set(CONFIG_FIELDS.map((f) => f.key));
  for (const [key, value] of Object.entries(req.body)) {
    if (!validKeys.has(key)) continue;
    const field = CONFIG_FIELDS.find((f) => f.key === key);
    let casted;
    if (field.type === 'boolean') {
      casted = value === true || value === 'true';
    } else if (field.type === 'number') {
      casted = Number(value);
      if (Number.isNaN(casted)) continue;
    } else {
      casted = value == null ? null : String(value);
    }
    deepSet(rawFile, key, casted);
  }
  const missingRequired = CONFIG_FIELDS.filter(
    (f) => f.required && deepGet(rawFile, f.key) == null
  );
  if (missingRequired.length > 0) {
    return res
      .status(400)
      .json({ error: 'ERR_REQUIRED_MISSING', fields: missingRequired.map((f) => f.key) });
  }
  fs.writeFileSync(getConfigFilePath(), JSON.stringify(rawFile, null, 2));
  res.json({ success: true });
  setTimeout(() => {
    spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      env: process.env,
      cwd: process.cwd(),
    }).unref();
    process.exit(0);
  }, 300);
});

module.exports = router;
