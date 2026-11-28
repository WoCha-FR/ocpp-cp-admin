const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const { getConfig, getConfigDir } = require('./config');
const { runMigrations, initNewDatabase } = require('./migrator');
const tariff = require('./tariff');
const { lastKnownMeterStop } = require('./txRecovery');
const logger = require('./logger').scope('SQLDB');

const config = getConfig();
const DB_PATH = path.resolve(getConfigDir(), config.dbname);

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const isNewDb = !fs.existsSync(DB_PATH);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    if (isNewDb) {
      initNewDatabase(db);
    } else {
      runMigrations(db);
    }
  }
  return db;
}

function closeDb() {
  if (!db) return;
  db.close();
  db = undefined;
}

// ── Sites ──
function getAllSites() {
  return db.prepare('SELECT * FROM sites ORDER BY sname').all();
}

function getSiteById(id) {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
}

// autoWebBadge : badge web automatique autorisé sur ce site (démarrage depuis le web sans badge)
function createSite(name, address, autoWebBadge = 1) {
  const info = db
    .prepare('INSERT INTO sites (sname, address, auto_web_badge) VALUES (?, ?, ?)')
    .run(name, address || null, autoWebBadge ? 1 : 0);
  return getSiteById(info.lastInsertRowid);
}

function updateSite(id, name, address, autoWebBadge) {
  const current = getSiteById(id);
  if (!current) return undefined;
  const autoWeb = autoWebBadge === undefined ? current.auto_web_badge : autoWebBadge ? 1 : 0;
  db.prepare('UPDATE sites SET sname = ?, address = ?, auto_web_badge = ? WHERE id = ?').run(
    name,
    address || null,
    autoWeb,
    id
  );
  return getSiteById(id);
}

// Suppression définitive : réservée à un site sans aucune session (vérifié par l'appelant avec
// countSiteSessions). Ses badges limités au site sont supprimés avec lui : sans cela la clé
// étrangère (ON DELETE SET NULL) les transformerait en badges valables sur tous les sites.
function deleteSite(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM id_tags WHERE site_id = ?').run(id);
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  })();
}

// Sessions rattachées au site (site figé au démarrage). Les démarrages refusés (Rejected,
// jamais facturés) ne comptent pas, comme pour les badges (countIdTagSessions).
function countSiteSessions(siteId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE site_id = ? AND status != 'Rejected'")
    .get(siteId).n;
}

// Archivage : le site et ses bornes encore actives sont retirés ensemble, avec le même
// horodatage, ce qui permet à la restauration de ne ramener que les bornes archivées avec lui.
// Retourne les bornes archivées (déconnexion et révocation des certificats par l'appelant).
function archiveSite(id) {
  return db.transaction(() => {
    // Horodatage strictement postérieur à celui d'une borne du site archivée séparément avant,
    // pour que la restauration du site ne la ramène pas
    const last = db
      .prepare('SELECT MAX(archived_at) AS t FROM chargepoints WHERE site_id = ?')
      .get(id)?.t;
    let archivedAt = new Date().toISOString();
    if (last && archivedAt <= last) {
      archivedAt = new Date(new Date(last).getTime() + 1).toISOString();
    }
    const cps = db
      .prepare('SELECT id, identity FROM chargepoints WHERE site_id = ? AND archived_at IS NULL')
      .all(id);
    db.prepare('UPDATE sites SET archived_at = ? WHERE id = ?').run(archivedAt, id);
    db.prepare(
      'UPDATE chargepoints SET archived_at = ? WHERE site_id = ? AND archived_at IS NULL'
    ).run(archivedAt, id);
    return cps;
  })();
}

// Restauration : retourne les bornes restaurées (archivées en même temps que le site)
function restoreSite(id) {
  return db.transaction(() => {
    const site = getSiteById(id);
    if (!site || !site.archived_at) return [];
    const cps = db
      .prepare('SELECT id, identity FROM chargepoints WHERE site_id = ? AND archived_at = ?')
      .all(id, site.archived_at);
    db.prepare(
      'UPDATE chargepoints SET archived_at = NULL WHERE site_id = ? AND archived_at = ?'
    ).run(id, site.archived_at);
    db.prepare('UPDATE sites SET archived_at = NULL WHERE id = ?').run(id);
    return cps;
  })();
}

// ── Tarification du site ──
function getSiteTariff(siteId) {
  const site = db
    .prepare('SELECT id, currency, timezone, default_price_per_kwh FROM sites WHERE id = ?')
    .get(siteId);
  if (!site) return null;
  const periods = db
    .prepare(
      `SELECT id, label, days, start_time, end_time, price_per_kwh
       FROM site_tariff_periods WHERE site_id = ? ORDER BY start_time, id`
    )
    .all(siteId);
  return {
    site_id: site.id,
    currency: site.currency || 'EUR',
    timezone: site.timezone || 'Europe/Paris',
    default_price_per_kwh: site.default_price_per_kwh ?? null,
    periods,
  };
}

/** Remplace atomiquement la grille de tarifs d'un site (la validation est faite par l'appelant). */
function replaceSiteTariff(siteId, { currency, timezone, default_price_per_kwh, periods = [] }) {
  db.transaction(() => {
    db.prepare(
      'UPDATE sites SET currency = ?, timezone = ?, default_price_per_kwh = ? WHERE id = ?'
    ).run(currency, timezone, default_price_per_kwh ?? null, siteId);
    db.prepare('DELETE FROM site_tariff_periods WHERE site_id = ?').run(siteId);
    const insert = db.prepare(
      `INSERT INTO site_tariff_periods (site_id, label, days, start_time, end_time, price_per_kwh)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const p of periods) {
      const days = tariff.parseDays(p.days) || tariff.ALL_DAYS;
      insert.run(
        siteId,
        p.label ? String(p.label).trim() || null : null,
        days.join(','),
        p.start_time,
        p.end_time,
        p.price_per_kwh
      );
    }
  })();
  return getSiteTariff(siteId);
}

/**
 * Calcule et fige le coût d'une session clôturée (cost, cost_currency, cost_details).
 * Ne lève jamais : un échec de calcul ne doit pas empêcher la clôture de la transaction.
 * @returns {{cost: number, currency: string}|null} null si pas de tarif ou échec
 */
// `txRowId` : identifiant interne (transactions.id), sans ambiguïté entre bornes.
// Une transaction refusée (Rejected) n'est jamais facturée.
function finalizeTransactionCost(txRowId) {
  try {
    const tx = db
      .prepare(
        // Tarif du site figé au démarrage : une borne déplacée depuis reste facturée à ce site
        `SELECT t.id, t.transaction_id, t.chargepoint_id, t.status, t.start_time, t.stop_time,
           t.meter_start, t.meter_stop, COALESCE(t.site_id, cp.site_id) AS site_id
         FROM transactions t JOIN chargepoints cp ON cp.id = t.chargepoint_id
         WHERE t.id = ?`
      )
      .get(txRowId);
    if (!tx || tx.status !== 'Completed') return null;
    if (!tx.site_id || !tx.start_time || !tx.stop_time) return null;
    if (tx.meter_start === null || tx.meter_stop === null) return null;

    const siteTariff = getSiteTariff(tx.site_id);
    if (!siteTariff || siteTariff.default_price_per_kwh === null) return null;

    const values = db
      .prepare(
        'SELECT energie FROM transactions_values WHERE chargepoint_id = ? AND transaction_id = ?'
      )
      .get(tx.chargepoint_id, tx.transaction_id);
    let points = [];
    if (values && values.energie) {
      try {
        points = JSON.parse(values.energie);
      } catch {
        points = [];
      }
    }

    const result = tariff.computeSessionCost({
      startTime: tx.start_time,
      stopTime: tx.stop_time,
      totalKwh: Math.max(0, tx.meter_stop - tx.meter_start) / 1000,
      points,
      tariff: siteTariff,
    });
    if (!result) return null;

    db.prepare(
      `UPDATE transactions SET cost = ?, cost_currency = ?, cost_details = ? WHERE id = ?`
    ).run(result.cost, result.currency, JSON.stringify(result.details), tx.id);
    return { cost: result.cost, currency: result.currency };
  } catch (err) {
    logger.error(`Tariff computation failed for transaction row ${txRowId}: ${err.message}`);
    return null;
  }
}

// ── Users ──
function getAllUsers() {
  const users = db
    .prepare(
      `
    SELECT u.id, u.useremail, u.shortname, u.role, u.created_at, u.last_login, u.disabled_at
    FROM users u ORDER BY u.useremail
  `
    )
    .all();
  // Attacher les sites de chaque utilisateur
  for (const user of users) {
    user.sites = getUserSites(user.id);
  }
  return users;
}

function getUserById(id) {
  const user = db
    .prepare(
      `
    SELECT u.id, u.useremail, u.shortname, u.role, u.langue, u.created_at, u.ntif_pushuser, u.ntif_pushtokn,
      u.disabled_at
    FROM users u WHERE u.id = ?
  `
    )
    .get(id);
  if (user) {
    user.sites = getUserSites(user.id);
  }
  return user;
}

// E-mail insensible à la casse : « Jean@x.fr » et « jean@x.fr » désignent le même compte
function getUserByEmail(useremail) {
  return db.prepare('SELECT * FROM users WHERE useremail = ? COLLATE NOCASE').get(useremail);
}

function isEmailTaken(useremail, excludeUserId = null) {
  const row = getUserByEmail(useremail);
  return !!row && row.id !== excludeUserId;
}

function getUserByGoogleId(googleId) {
  return db.prepare('SELECT * FROM users WHERE auth_gglid = ?').get(googleId);
}

function updateLastLogin(userId) {
  return db
    .prepare('UPDATE users SET last_login = ? WHERE id = ?')
    .run(new Date().toISOString(), userId);
}

function updateUserGoogleProfile(userId, profile) {
  return db.prepare('UPDATE users SET auth_gglid = ? WHERE id = ?').run(profile.id, userId);
}

function createUser(useremail, password, role, shortname) {
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?, ?, ?, ?)')
    .run(useremail, hash, role, shortname || null);
  const userId = info.lastInsertRowid;
  return getUserById(userId);
}

function updateUser(id, data) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  const useremail = data.useremail || user.useremail;
  const shortname = data.shortname !== undefined ? data.shortname : user.shortname;
  const role = data.role || user.role;
  const ntif_pushuser =
    data.ntif_pushuser !== undefined ? data.ntif_pushuser || null : user.ntif_pushuser;
  const ntif_pushtokn =
    data.ntif_pushtokn !== undefined ? data.ntif_pushtokn || null : user.ntif_pushtokn;
  const langue = data.langue !== undefined ? data.langue : user.langue;
  if (data.password) {
    const hash = bcrypt.hashSync(data.password, 10);
    db.prepare(
      'UPDATE users SET useremail = ?, password = ?, role = ?, shortname = ?, ntif_pushuser = ?, ntif_pushtokn = ?, langue = ? WHERE id = ?'
    ).run(useremail, hash, role, shortname || null, ntif_pushuser, ntif_pushtokn, langue, id);
  } else {
    db.prepare(
      'UPDATE users SET useremail = ?, role = ?, shortname = ?, ntif_pushuser = ?, ntif_pushtokn = ?, langue = ? WHERE id = ?'
    ).run(useremail, role, shortname || null, ntif_pushuser, ntif_pushtokn, langue, id);
  }
  return getUserById(id);
}

// Suppression d'un compte = anonymisation immédiate. Les sessions restent (remboursements déjà
// versés, totaux des sites) mais ne portent plus que `deletedLabel` (« Utilisateur supprimé #id ») ;
// les badges sont désactivés, détachés et vidés de leur description, sans être supprimés (leur
// code reste dans l'historique et ne doit pas être réattribué par erreur).
function deleteUser(id, deletedLabel = null) {
  db.transaction(() => {
    db.prepare('UPDATE transactions SET user_name = ? WHERE user_id = ?').run(
      deletedLabel || `#${id}`,
      id
    );
    db.prepare(
      'UPDATE id_tags SET active = 0, user_id = NULL, description = NULL WHERE user_id = ?'
    ).run(id);
    db.prepare('DELETE FROM user_sites WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
}

// Compte désactivé : connexion refusée, badges refusés (authorizeIdTag), rien n'est effacé
function setUserDisabled(id, disabled) {
  db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(
    disabled ? new Date().toISOString() : null,
    id
  );
  return getUserById(id);
}

// ── Users Password Resets ──
function createPasswordReset(userId, tokenHash, expiresAt) {
  const insert = db.transaction(() => {
    // Invalider tous les tokens précédents non utilisés de cet utilisateur
    db.prepare('UPDATE users_password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(
      userId
    );
    // Insérer le nouveau token
    return db
      .prepare('INSERT INTO users_password_resets (user_id, token, expires_at) VALUES (?, ?, ?)')
      .run(userId, tokenHash, expiresAt);
  });
  return insert();
}

function getUserPasswordResetByToken(tokenHash) {
  return db
    .prepare(
      `
    SELECT upr.*, u.useremail, u.langue
    FROM users_password_resets upr
    JOIN users u ON upr.user_id = u.id
    WHERE upr.token = ?
  `
    )
    .get(tokenHash);
}

function markUserPasswordResetAsUsed(id) {
  db.prepare('UPDATE users_password_resets SET used = 1 WHERE id = ?').run(id);
}

function deleteExpiredPasswordResets() {
  db.prepare(
    "DELETE FROM users_password_resets WHERE expires_at < datetime('now') OR used = 1"
  ).run();
}

// ── User Sites (many-to-many) ──
function getUserSites(userId) {
  return db
    .prepare(
      `
    SELECT us.site_id, us.role, us.authorized, s.sname as site_name
    FROM user_sites us
    JOIN sites s ON us.site_id = s.id
    WHERE us.user_id = ?
    ORDER BY s.sname
  `
    )
    .all(userId);
}

function getUserSiteIds(userId) {
  return db
    .prepare('SELECT site_id FROM user_sites WHERE user_id = ?')
    .all(userId)
    .map((r) => r.site_id);
}

function getUserManagedSiteIds(userId) {
  return db
    .prepare("SELECT site_id FROM user_sites WHERE user_id = ? AND role = 'manager'")
    .all(userId)
    .map((r) => r.site_id);
}

function getSiteUsers(siteId) {
  return db
    .prepare(
      `
    SELECT u.id, u.useremail, u.shortname, u.role as global_role, us.role as site_role, us.authorized, us.created_at as linked_at,
      u.disabled_at
    FROM user_sites us
    JOIN users u ON us.user_id = u.id
    WHERE us.site_id = ?
    ORDER BY u.useremail
  `
    )
    .all(siteId);
}

function getSiteUsersWithStats(siteId) {
  const users = db
    .prepare(
      `
    SELECT u.id, u.useremail, u.shortname, u.role as global_role,
      us.role as site_role, us.authorized, us.created_at as linked_at,
      COALESCE(stats.charges_month, 0) as charges_month,
      COALESCE(stats.energy_month_kwh, 0) as energy_month_kwh,
      stats.last_charge,
      COALESCE(tags.tag_count, 0) as tag_count
    FROM user_sites us
    JOIN users u ON us.user_id = u.id
    LEFT JOIN (
      SELECT t.user_id,
        COUNT(*) as charges_month,
        ROUND(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
          THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 2) as energy_month_kwh,
        MAX(t.start_time) as last_charge
      FROM transactions t
      WHERE t.site_id = ?
        AND t.status = 'Completed'
        AND t.start_time >= date('now', 'start of month')
      GROUP BY t.user_id
    ) stats ON stats.user_id = u.id
    LEFT JOIN (
      SELECT it.user_id, COUNT(*) as tag_count
      FROM id_tags it
      WHERE it.active = 1 AND (it.site_id = ? OR it.site_id IS NULL)
      GROUP BY it.user_id
    ) tags ON tags.user_id = u.id
    WHERE us.site_id = ?
    ORDER BY u.useremail
  `
    )
    .all(siteId, siteId, siteId);

  const siteStats = db
    .prepare(
      `
    SELECT
      COUNT(*) as charges_month,
      ROUND(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 2) as energy_month_kwh
    FROM transactions t
    WHERE t.site_id = ?
      AND t.status = 'Completed'
      AND t.start_time >= date('now', 'start of month')
  `
    )
    .get(siteId);

  return {
    users,
    siteStats: {
      charges_month: siteStats?.charges_month || 0,
      energy_month_kwh: siteStats?.energy_month_kwh || 0,
    },
  };
}

function addUserToSite(useremail, siteId, password) {
  let user = getUserByEmail(useremail);
  let isNew = false;
  if (!user) {
    // Créer l'utilisateur avec le rôle 'user'
    if (!password) throw new Error('ERR_PASSWORD_REQUIRED_NEW_USER');
    const hash = bcrypt.hashSync(password, 10);
    // Générer le shortname à partir de la partie avant le @ de l'email
    const shortname = useremail.split('@')[0] || null;
    const info = db
      .prepare('INSERT INTO users (useremail, password, role, shortname) VALUES (?, ?, ?, ?)')
      .run(useremail, hash, 'user', shortname);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    isNew = true;
  }
  // Vérifier si la liaison existe déjà
  const existing = db
    .prepare('SELECT * FROM user_sites WHERE user_id = ? AND site_id = ?')
    .get(user.id, siteId);
  if (existing) throw new Error('ERR_USER_ALREADY_ON_SITE');
  // Ajouter la liaison avec le rôle 'user' et autorisation de recharge
  db.prepare('INSERT INTO user_sites (user_id, site_id, role, authorized) VALUES (?, ?, ?, ?)').run(
    user.id,
    siteId,
    'user',
    1
  );
  return { user: getUserById(user.id), isNew };
}

function removeUserFromSite(userId, siteId) {
  db.prepare('DELETE FROM user_sites WHERE user_id = ? AND site_id = ?').run(userId, siteId);
}

function setUserSiteAuthorized(userId, siteId, authorized) {
  db.prepare('UPDATE user_sites SET authorized = ? WHERE user_id = ? AND site_id = ?').run(
    authorized ? 1 : 0,
    userId,
    siteId
  );
}

function setUserSiteRole(userId, siteId, role) {
  db.prepare('UPDATE user_sites SET role = ? WHERE user_id = ? AND site_id = ?').run(
    role,
    userId,
    siteId
  );
}

// Managers actifs du site (un compte désactivé ne gère plus rien)
function countSiteManagers(siteId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM user_sites us JOIN users u ON u.id = us.user_id
       WHERE us.site_id = ? AND us.role = 'manager' AND u.disabled_at IS NULL`
    )
    .get(siteId);
  return row ? row.cnt : 0;
}

// Sites dont ce compte est le seul manager actif : le retirer, le rétrograder, le désactiver ou
// le supprimer laisserait un site qui avait un manager sans personne pour le gérer
function getSolelyManagedSites(userId) {
  return db
    .prepare(
      `SELECT us.site_id, s.sname AS site_name
       FROM user_sites us
       JOIN users u ON u.id = us.user_id
       JOIN sites s ON s.id = us.site_id
       WHERE us.user_id = ? AND us.role = 'manager' AND u.disabled_at IS NULL
         AND (SELECT COUNT(*) FROM user_sites us2 JOIN users u2 ON u2.id = us2.user_id
              WHERE us2.site_id = us.site_id AND us2.role = 'manager'
                AND u2.disabled_at IS NULL) = 1
       ORDER BY s.sname`
    )
    .all(userId);
}

function setUserSites(userId, sites) {
  const setSites = db.transaction((userId, sites) => {
    db.prepare('DELETE FROM user_sites WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT INTO user_sites (user_id, site_id, role, authorized) VALUES (?, ?, ?, ?)'
    );
    for (const s of sites) {
      if (s.site_id) {
        const role = s.role || 'user';
        const authorized = s.authorized !== undefined ? (s.authorized ? 1 : 0) : 1;
        insert.run(userId, s.site_id, role, authorized);
      }
    }
  });
  setSites(userId, sites);
}

// ── Chargepoints ──
function getAllChargepoints() {
  return db
    .prepare(
      `
    SELECT cp.*, s.sname as site_name
    FROM chargepoints cp LEFT JOIN sites s ON cp.site_id = s.id
    ORDER BY s.sname, cp.cpname, cp.identity
  `
    )
    .all();
}

function getChargepointsBySite(siteId) {
  return db
    .prepare(
      `
    SELECT cp.*, s.sname as site_name
    FROM chargepoints cp LEFT JOIN sites s ON cp.site_id = s.id
    WHERE cp.site_id = ? ORDER BY cp.identity
  `
    )
    .all(siteId);
}

function getChargepointByIdentity(identity) {
  return db
    .prepare(
      `
    SELECT cp.*, s.sname as site_name
    FROM chargepoints cp LEFT JOIN sites s ON cp.site_id = s.id
    WHERE cp.identity = ?
  `
    )
    .get(identity);
}

function getChargepointById(id) {
  return db
    .prepare(
      `
    SELECT cp.*, s.sname as site_name
    FROM chargepoints cp LEFT JOIN sites s ON cp.site_id = s.id
    WHERE cp.id = ?
  `
    )
    .get(id);
}

// Crée la borne si elle n'existe pas : réservé aux tests et aux jeux de données. Le code OCPP
// utilise updateChargepointByIdentity (jamais de recréation d'une borne supprimée ou renommée).
function upsertChargepoint(identity, data) {
  const existing = getChargepointByIdentity(identity);
  if (existing) {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (fields.length > 0) {
      values.push(identity);
      db.prepare(`UPDATE chargepoints SET ${fields.join(', ')} WHERE identity = ?`).run(...values);
    }
    return getChargepointByIdentity(identity);
  } else {
    const info = db.prepare('INSERT INTO chargepoints (identity) VALUES (?)').run(identity);
    if (Object.keys(data).length > 0) {
      const fields = [];
      const values = [];
      for (const [key, val] of Object.entries(data)) {
        if (val !== undefined) {
          fields.push(`${key} = ?`);
          values.push(val);
        }
      }
      if (fields.length > 0) {
        values.push(info.lastInsertRowid);
        db.prepare(`UPDATE chargepoints SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
    }
    return getChargepointById(info.lastInsertRowid);
  }
}

// Mise à jour seule, jamais d'insertion : un événement tardif (déconnexion, BootNotification)
// d'une borne supprimée ou renommée ne doit pas recréer une borne fantôme sous l'ancienne identité
function updateChargepointByIdentity(identity, data) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length > 0) {
    values.push(identity);
    db.prepare(`UPDATE chargepoints SET ${fields.join(', ')} WHERE identity = ?`).run(...values);
  }
  return getChargepointByIdentity(identity);
}

// Sessions enregistrées sur la borne, hors démarrages refusés (supprimés avec elle)
function countChargepointSessions(chargepointId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE chargepoint_id = ? AND status != 'Rejected'"
    )
    .get(chargepointId).n;
}

function countActiveTransactions(chargepointIds) {
  const ids = Array.isArray(chargepointIds) ? chargepointIds : [chargepointIds];
  if (ids.length === 0) return 0;
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE status = 'Active' AND chargepoint_id IN (${ids.map(() => '?').join(',')})`
    )
    .get(...ids).n;
}

// Archivage d'une borne : connexion OCPP refusée, identité réservée (la ligne reste), historique
// conservé ; restaurable tant que son site n'est pas lui-même archivé
function setChargepointArchived(id, archived) {
  db.prepare('UPDATE chargepoints SET archived_at = ? WHERE id = ?').run(
    archived ? new Date().toISOString() : null,
    id
  );
  return getChargepointById(id);
}

function createChargepoint(identity, name, password, mode, site_id) {
  const hash = password ? bcrypt.hashSync(password, 10) : null;
  const info = db
    .prepare(
      'INSERT INTO chargepoints (identity, cpname, password, mode, site_id, cpstatus) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(identity, name, hash, mode || 1, site_id || null, 'Planned');
  return getChargepointById(info.lastInsertRowid);
}

function updateChargepoint(id, data) {
  const cp = db.prepare('SELECT * FROM chargepoints WHERE id = ?').get(id);
  if (!cp) return null;
  const identity = data.identity || cp.identity;
  const name = data.name || cp.cpname;
  const password = data.password
    ? bcrypt.hashSync(data.password, 10)
    : data.password === null
      ? null
      : cp.password;
  const mode = data.mode !== undefined ? data.mode : cp.mode;
  const site_id = data.site_id !== undefined ? data.site_id : cp.site_id;
  const authorized = data.authorized !== undefined ? data.authorized : cp.authorized;
  db.prepare(
    'UPDATE chargepoints SET identity = ?, cpname = ?, password = ?, mode = ?, site_id = ?, authorized = ? WHERE id = ?'
  ).run(identity, name, password, mode, site_id, authorized, id);
  return getChargepointById(id);
}

// evses et error_events référencent chargepoints(id) sans ON DELETE CASCADE : on les
// supprime explicitement (plutôt que de reconstruire les tables SQLite par migration).
function deleteChargepoint(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM evses WHERE chargepoint_id = ?').run(id);
    db.prepare('DELETE FROM error_events WHERE chargepoint_id = ?').run(id);
    db.prepare('DELETE FROM chargepoints WHERE id = ?').run(id);
  })();
}

function assignChargepointToSite(chargepointId, siteId) {
  db.prepare('UPDATE chargepoints SET site_id = ? WHERE id = ?').run(siteId, chargepointId);
  return getChargepointById(chargepointId);
}

function updateChargepointStatus(identity, status, connected, extras) {
  const updates = [];
  const values = [];
  if (status !== undefined) {
    updates.push('cpstatus = ?');
    values.push(status);
  }
  if (connected !== undefined) {
    updates.push('connected = ?');
    values.push(connected ? 1 : 0);
  }
  if (extras) {
    if (extras.error_code !== undefined) {
      updates.push('error_code = ?');
      values.push(extras.error_code || 'NoError');
    }
    if (extras.error_info !== undefined) {
      updates.push('error_info = ?');
      values.push(extras.error_info || null);
    }
    if (extras.vendor_id !== undefined) {
      updates.push('vendor_id = ?');
      values.push(extras.vendor_id || null);
    }
    if (extras.vendor_error_code !== undefined) {
      updates.push('vendor_error_code = ?');
      values.push(extras.vendor_error_code || null);
    }
  }
  updates.push("last_heartbeat = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  values.push(identity);
  db.prepare(`UPDATE chargepoints SET ${updates.join(', ')} WHERE identity = ?`).run(...values);
  return getChargepointByIdentity(identity);
}

// ── Connectors ──
function upsertConnector(
  chargepointId,
  connectorId,
  status,
  errorCode,
  info,
  vendorId,
  vendorEC,
  evse_id = null,
  cnstatus_raw = null
) {
  // Le connecteur 0 représente la borne elle-même, ses données sont stockées dans la table chargepoints
  if (connectorId === 0) return null;
  const rawStatus = cnstatus_raw !== null ? cnstatus_raw : status;
  // Pour OCPP 2.0.1 (evse_id fourni), la clé unique est (chargepoint_id, evse_id, connector_id).
  // Pour OCPP 1.6 (evse_id null), on utilise (chargepoint_id, connector_id).
  const existing =
    evse_id !== null
      ? db
          .prepare(
            'SELECT * FROM connectors WHERE chargepoint_id = ? AND evse_id = ? AND connector_id = ?'
          )
          .get(chargepointId, evse_id, connectorId)
      : db
          .prepare(
            'SELECT * FROM connectors WHERE chargepoint_id = ? AND evse_id IS NULL AND connector_id = ?'
          )
          .get(chargepointId, connectorId);
  if (existing) {
    if (evse_id !== null) {
      db.prepare(
        `UPDATE connectors SET cnstatus = ?, cnstatus_raw = ?, evse_id = ?, error_code = ?, info = ?, vendor_id = ?, vendor_error_code = ?, updated_at = datetime('now')
        WHERE chargepoint_id = ? AND evse_id = ? AND connector_id = ?`
      ).run(
        status,
        rawStatus,
        evse_id,
        errorCode || 'NoError',
        info || null,
        vendorId || null,
        vendorEC || null,
        chargepointId,
        evse_id,
        connectorId
      );
    } else {
      db.prepare(
        `UPDATE connectors SET cnstatus = ?, cnstatus_raw = ?, evse_id = ?, error_code = ?, info = ?, vendor_id = ?, vendor_error_code = ?, updated_at = datetime('now')
        WHERE chargepoint_id = ? AND evse_id IS NULL AND connector_id = ?`
      ).run(
        status,
        rawStatus,
        null,
        errorCode || 'NoError',
        info || null,
        vendorId || null,
        vendorEC || null,
        chargepointId,
        connectorId
      );
    }
  } else {
    db.prepare(
      'INSERT INTO connectors (chargepoint_id, connector_id, cnstatus, cnstatus_raw, evse_id, error_code, info, vendor_id, vendor_error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      chargepointId,
      connectorId,
      status,
      rawStatus,
      evse_id,
      errorCode || 'NoError',
      info || null,
      vendorId || null,
      vendorEC || null
    );
  }
  return evse_id !== null
    ? db
        .prepare(
          'SELECT * FROM connectors WHERE chargepoint_id = ? AND evse_id = ? AND connector_id = ?'
        )
        .get(chargepointId, evse_id, connectorId)
    : db
        .prepare(
          'SELECT * FROM connectors WHERE chargepoint_id = ? AND evse_id IS NULL AND connector_id = ?'
        )
        .get(chargepointId, connectorId);
}

function getConnectorById(connectorId) {
  return db
    .prepare(
      'SELECT c.*, cp.identity as chargepoint_identity, cp.site_id as site_id FROM connectors c JOIN chargepoints cp ON c.chargepoint_id = cp.id WHERE c.id = ?'
    )
    .get(connectorId);
}

function getConnectorByChargepointAndId(chargepointId, connectorId, evse_id = null) {
  if (evse_id !== null)
    return db
      .prepare(
        'SELECT * FROM connectors WHERE chargepoint_id = ? AND evse_id = ? AND connector_id = ?'
      )
      .get(chargepointId, evse_id, connectorId);
  return db
    .prepare('SELECT * FROM connectors WHERE chargepoint_id = ? AND connector_id = ?')
    .get(chargepointId, connectorId);
}

function getConnectorsByChargepoint(chargepointId) {
  return db
    .prepare(
      `SELECT c.*, e.evse_name
       FROM connectors c
       LEFT JOIN evses e ON e.chargepoint_id = c.chargepoint_id AND e.evse_id = c.evse_id
       WHERE c.chargepoint_id = ? AND c.connector_id > 0
       ORDER BY c.evse_id, c.connector_id`
    )
    .all(chargepointId);
}

function getConnectorsByChargepoints(chargepointIds) {
  if (!chargepointIds.length) return new Map();
  const placeholders = chargepointIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.*, e.evse_name
       FROM connectors c
       LEFT JOIN evses e ON e.chargepoint_id = c.chargepoint_id AND e.evse_id = c.evse_id
       WHERE c.chargepoint_id IN (${placeholders}) AND c.connector_id > 0
       ORDER BY c.evse_id, c.connector_id`
    )
    .all(...chargepointIds);
  const byChargepoint = new Map();
  for (const row of rows) {
    if (!byChargepoint.has(row.chargepoint_id)) byChargepoint.set(row.chargepoint_id, []);
    byChargepoint.get(row.chargepoint_id).push(row);
  }
  return byChargepoint;
}

function updateConnectorFields(connectorId, data) {
  const existing = db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
  if (!existing) throw new Error('ERR_CONNECTOR_NOT_FOUND');
  db.prepare(
    `UPDATE connectors SET connector_name = ?, connector_power = ?, connector_type = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    data.connector_name !== undefined ? data.connector_name : existing.connector_name,
    data.connector_power !== undefined ? data.connector_power : existing.connector_power,
    data.connector_type !== undefined ? data.connector_type : existing.connector_type,
    connectorId
  );
  return db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
}

function updateConnectorCnstatus(chargepointId, connectorId, evse_id, cnstatus) {
  db.prepare(
    `UPDATE connectors SET cnstatus = ?, updated_at = datetime('now')
     WHERE chargepoint_id = ? AND evse_id = ? AND connector_id = ?`
  ).run(cnstatus, chargepointId, evse_id, connectorId);
}

function getAllConnectorsGrouped(siteIds) {
  let query = `
    SELECT c.*, cp.identity as chargepoint_identity, cp.id as chargepoint_id,
           cp.cpname as chargepoint_name, cp.connected, cp.cpstatus as cp_status,
           cp.mode, cp.ocpp_version,
           s.sname as site_name, s.id as site_id,
           t.transaction_id as active_transaction_id, t.id_tag as active_id_tag,
           t.power as active_power, t.energy as active_energy,
           c.evse_id, t.charging_state as active_charging_state
    FROM connectors c
    JOIN chargepoints cp ON c.chargepoint_id = cp.id
    LEFT JOIN sites s ON cp.site_id = s.id
    LEFT JOIN transactions t ON t.chargepoint_id = cp.id AND t.connector_id = c.connector_id AND t.status = 'Active'
      AND (t.evse_id IS NULL OR c.evse_id IS NULL OR t.evse_id = c.evse_id)
    WHERE c.connector_id > 0 AND cp.archived_at IS NULL
  `;
  const params = [];
  if (siteIds !== null && Array.isArray(siteIds)) {
    if (siteIds.length === 0) return [];
    query += ` AND cp.site_id IN (${siteIds.map(() => '?').join(',')})`;
    params.push(...siteIds);
  }
  query += ' ORDER BY s.sname, cp.identity, c.connector_id';
  return db.prepare(query).all(...params);
}

// ── Transactions ──

// Badge retenu pour une session : badge du site de la borne, puis badge global, puis badge d'un
// autre site (même ordre que le rattrapage de la migration 013).
function resolveTagAttribution(idTag, siteId) {
  if (!idTag) return { user_id: null, user_name: null, tag_category: null };
  const tag = db
    .prepare(
      `SELECT it.user_id, it.category, COALESCE(u.shortname, u.useremail) AS user_name
       FROM id_tags it LEFT JOIN users u ON u.id = it.user_id
       WHERE it.id_tag = ?
       ORDER BY CASE WHEN it.site_id = ? THEN 0 WHEN it.site_id IS NULL THEN 1 ELSE 2 END, it.id
       LIMIT 1`
    )
    .get(idTag, siteId ?? null);
  if (!tag) return { user_id: null, user_name: null, tag_category: null };
  return {
    user_id: tag.user_id ?? null,
    user_name: tag.user_name ?? null,
    tag_category: tag.category,
  };
}

/**
 * Attribution figée au démarrage d'une session : site de la borne, titulaire et catégorie du
 * badge. Les modifications ultérieures (badge, compte, borne déplacée) ne valent que pour l'avenir.
 * @returns {{site_id: number|null, user_id: number|null, user_name: string|null, tag_category: string|null}}
 */
function resolveTransactionAttribution(chargepointId, idTag) {
  const cp = db.prepare('SELECT site_id FROM chargepoints WHERE id = ?').get(chargepointId);
  const siteId = cp?.site_id ?? null;
  return { site_id: siteId, ...resolveTagAttribution(idTag, siteId) };
}

function createTransaction(
  chargepointId,
  connectorId,
  idTag,
  meterStart,
  startTime,
  startSource,
  {
    transactionId: providedId = null,
    evse_id = null,
    charging_state = null,
    id_token_type = 'ISO14443',
    // 'Rejected' : démarrage refusé par le CSMS. La borne a déjà démarré la transaction (spec) :
    // on la garde pour retrouver ses messages suivants et l'énergie délivrée, sans la facturer.
    status = 'Active',
  } = {}
) {
  const txStatus = status === 'Rejected' ? 'Rejected' : 'Active';
  return db.transaction(() => {
    let transactionId;
    if (providedId !== null) {
      transactionId = String(providedId);
    } else {
      // Générer l'ID de transaction unique (AAJJJ + séquentiel 4 chiffres)
      // Le SELECT MAX + INSERT est atomique grâce à la transaction (pas de race condition)
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const startOfYear = new Date(now.getFullYear(), 0, 0);
      const dayOfYear = Math.floor((now - startOfYear) / 86400000);
      const base = (yy * 1000 + dayOfYear) * 10000;
      const row = db
        .prepare(
          `
        SELECT CAST(COALESCE(MAX(CAST(transaction_id AS INTEGER)), ?) + 1 AS INTEGER) AS next_id
        FROM transactions
        WHERE CAST(transaction_id AS INTEGER) BETWEEN ? AND ?
      `
        )
        .get(base, base, base + 9999);
      transactionId = String(Math.round(row.next_id));
    }

    const source = startSource || 'rfid';
    const attribution = resolveTransactionAttribution(chargepointId, idTag);
    const info = db
      .prepare(
        `INSERT INTO transactions
      (chargepoint_id, connector_id, transaction_id, id_tag, meter_start, start_time, status, start_source, evse_id, charging_state, id_token_type,
       site_id, user_id, user_name, tag_category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chargepointId,
        connectorId,
        transactionId,
        idTag,
        meterStart,
        startTime,
        txStatus,
        source,
        evse_id,
        txStatus === 'Active' ? charging_state : null,
        id_token_type,
        attribution.site_id,
        attribution.user_id,
        attribution.user_name,
        attribution.tag_category
      );
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
  })();
}

// Les transactions sont identifiées par (borne, transaction_id) : en 2.0.1 l'identifiant est
// généré par la borne et n'est unique que pour elle.
function getTransactionByTransactionId(chargepointId, transactionId) {
  return db
    .prepare('SELECT * FROM transactions WHERE chargepoint_id = ? AND transaction_id = ?')
    .get(chargepointId, String(transactionId));
}

/**
 * Clôture d'une transaction active.
 * @param {'station'|'server'} closedBy station = arrêt envoyé par la borne ; server = clôture
 *   heuristique du serveur (orpheline, réconciliation…), que l'arrêt réel de la borne peut corriger
 * @returns {{tx: object|undefined, closed: boolean}} closed = la transaction était active et
 *   vient d'être close (false : déjà close, refusée ou inconnue)
 */
function stopTransaction(
  chargepointId,
  transactionId,
  meterStop,
  stopTime,
  reason,
  closedBy = 'station'
) {
  const txId = String(transactionId);
  const info = db
    .prepare(
      `UPDATE transactions SET meter_stop = ?, stop_time = ?, stop_reason = ?, status = 'Completed',
    charging_state = NULL, closed_by = ?
    WHERE chargepoint_id = ? AND transaction_id = ? AND status = 'Active'`
    )
    .run(
      meterStop,
      stopTime,
      reason || 'Local',
      closedBy === 'server' ? 'server' : 'station',
      chargepointId,
      txId
    );
  const tx = getTransactionByTransactionId(chargepointId, txId);
  // Coût figé uniquement à la vraie clôture (un StopTransaction en double ne recalcule pas)
  if (info.changes > 0 && tx) finalizeTransactionCost(tx.id);
  return { tx: info.changes > 0 && tx ? getTransactionById(tx.id) : tx, closed: info.changes > 0 };
}

/**
 * Clôture manuelle (admin/manager) d'une transaction restée active alors que la borne ne la
 * renverra jamais. Rien n'est envoyé à la borne. Clôture closed_by = server avec le dernier
 * relevé connu (meter_start + energy) : un arrêt réel envoyé plus tard par la borne la corrige.
 * @param {number} id identifiant interne (transactions.id)
 * @returns {{tx: object|undefined, closed: boolean}} closed = false : inconnue ou déjà close
 */
function closeTransactionManually(id) {
  const tx = getTransactionById(id);
  if (!tx || tx.status !== 'Active') return { tx, closed: false };
  return stopTransaction(
    tx.chargepoint_id,
    tx.transaction_id,
    lastKnownMeterStop(tx),
    new Date().toISOString(),
    'Other',
    'server'
  );
}

/**
 * Arrêt réel envoyé par la borne pour une transaction déjà close par le serveur (closed_by =
 * server) : l'arrêt de la borne fait foi (compteur, heure, raison) et le coût est recalculé.
 * Un compteur d'arrêt absent ou incohérent (≤ compteur de départ) garde l'estimation du serveur.
 * @returns {object|null} la transaction corrigée, null si rien à corriger
 */
function correctServerClosedTransaction(chargepointId, transactionId, meterStop, stopTime, reason) {
  const tx = getTransactionByTransactionId(chargepointId, transactionId);
  if (!tx || tx.status !== 'Completed' || tx.closed_by !== 'server') return null;
  const coherent = meterStop != null && tx.meter_start != null && meterStop > tx.meter_start;
  db.prepare(
    `UPDATE transactions SET meter_stop = ?, stop_time = ?, stop_reason = ?, closed_by = 'station',
       power = NULL
     WHERE id = ?`
  ).run(coherent ? meterStop : tx.meter_stop, stopTime || tx.stop_time, reason || 'Local', tx.id);
  finalizeTransactionCost(tx.id);
  return getTransactionById(tx.id);
}

/**
 * Arrêt d'une transaction refusée (Rejected) : on garde le compteur et l'heure d'arrêt
 * (énergie délivrée avant la coupure), le statut reste Rejected et aucun coût n'est calculé.
 * @returns {object|null} la transaction mise à jour, null si elle n'est pas refusée ou déjà arrêtée
 */
function stopRejectedTransaction(chargepointId, transactionId, meterStop, stopTime, reason) {
  const info = db
    .prepare(
      `UPDATE transactions SET meter_stop = ?, stop_time = ?, stop_reason = ?, closed_by = 'station'
       WHERE chargepoint_id = ? AND transaction_id = ? AND status = 'Rejected' AND stop_time IS NULL`
    )
    .run(meterStop, stopTime, reason || 'DeAuthorized', chargepointId, String(transactionId));
  return info.changes > 0 ? getTransactionByTransactionId(chargepointId, transactionId) : null;
}

function getTransactionById(id) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

function updateTransactionChargingState(chargepointId, transactionId, chargingState) {
  db.prepare(
    `UPDATE transactions SET charging_state = ?
     WHERE chargepoint_id = ? AND transaction_id = ? AND status = 'Active'`
  ).run(chargingState, chargepointId, String(transactionId));
}

function getDashboardChartData(siteIds = null, days = 30) {
  const params = [];
  let siteFilter = '';
  if (siteIds !== null && siteIds.length > 0) {
    siteFilter = ` AND t.site_id IN (${siteIds.map(() => '?').join(',')})`;
    params.push(...siteIds);
  } else if (siteIds !== null && siteIds.length === 0) {
    return { energyPerDay: [], transactionsPerDay: [] };
  }

  const dateFilter = days > 0 ? `AND t.start_time >= date('now', '-${days} days')` : '';

  // Énergie par jour (kWh)
  const energyPerDay = db
    .prepare(
      `
    SELECT date(t.start_time) as day,
      ROUND(SUM(CASE
        WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
          THEN (t.meter_stop - t.meter_start) / 1000.0
        WHEN t.status = 'Active' AND t.energy IS NOT NULL
          THEN t.energy / 1000.0
        ELSE 0 END), 2) as energy_kwh,
      COUNT(*) as tx_count
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    WHERE t.status IN ('Completed', 'Active')
      ${dateFilter}${siteFilter}
    GROUP BY date(t.start_time)
    ORDER BY day ASC
  `
    )
    .all(...params);

  return { energyPerDay };
}

function getChargingKpi(siteIds = null, days = 30) {
  const params = [];
  let siteFilter = '';
  if (siteIds !== null && siteIds.length > 0) {
    siteFilter = ` AND t.site_id IN (${siteIds.map(() => '?').join(',')})`;
    params.push(...siteIds);
  } else if (siteIds !== null && siteIds.length === 0) {
    return {
      period: { totalEnergy: 0, totalSessions: 0, avgDuration: 0, avgEnergy: 0, utilization: 0 },
      allTime: { totalEnergy: 0, totalSessions: 0, avgDuration: 0, avgEnergy: 0, utilization: 0 },
    };
  }

  const kpiDateFilter = days > 0 ? `AND t.start_time >= date('now', '-${days} days')` : '';

  const period = db
    .prepare(
      `
    SELECT
      ROUND(COALESCE(SUM(CASE
        WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
          THEN (t.meter_stop - t.meter_start) / 1000.0
        WHEN t.status = 'Active' AND t.energy IS NOT NULL
          THEN t.energy / 1000.0
        ELSE 0 END), 0), 2) as totalEnergy,
      COUNT(*) as totalSessions,
      ROUND(COALESCE(AVG(
        CASE WHEN t.stop_time IS NOT NULL AND t.start_time IS NOT NULL
          THEN (julianday(t.stop_time) - julianday(t.start_time)) * 24 * 60
          ELSE NULL END
      ), 0), 0) as avgDuration,
      ROUND(COALESCE(AVG(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE NULL END), 0), 2) as avgEnergy
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    WHERE t.status IN ('Completed', 'Active')
      ${kpiDateFilter}${siteFilter}
  `
    )
    .get(...params);

  const allTime = db
    .prepare(
      `
    SELECT
      ROUND(COALESCE(SUM(CASE
        WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
          THEN (t.meter_stop - t.meter_start) / 1000.0
        WHEN t.status = 'Active' AND t.energy IS NOT NULL
          THEN t.energy / 1000.0
        ELSE 0 END), 0), 2) as totalEnergy,
      COUNT(*) as totalSessions,
      ROUND(COALESCE(AVG(
        CASE WHEN t.stop_time IS NOT NULL AND t.start_time IS NOT NULL
          THEN (julianday(t.stop_time) - julianday(t.start_time)) * 24 * 60
          ELSE NULL END
      ), 0), 0) as avgDuration,
      ROUND(COALESCE(AVG(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE NULL END), 0), 2) as avgEnergy
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    WHERE t.status IN ('Completed', 'Active')${siteFilter}
  `
    )
    .get(...params);

  // Taux d'utilisation : temps total de charge / (nb connecteurs × durée période)
  let connectorFilter = '';
  const connParams = [];
  if (siteIds !== null && siteIds.length > 0) {
    connectorFilter = ` WHERE cp.site_id IN (${siteIds.map(() => '?').join(',')})`;
    connParams.push(...siteIds);
  }
  const connCount = db
    .prepare(
      `
    SELECT COUNT(*) as cnt FROM connectors cn
    JOIN chargepoints cp ON cn.chargepoint_id = cp.id${connectorFilter}
  `
    )
    .get(...connParams);
  const totalConnectors = connCount?.cnt || 0;

  let utilizationPeriod = 0;
  let utilizationAllTime = 0;
  if (totalConnectors > 0) {
    const chargingHoursPeriod = db
      .prepare(
        `
      SELECT COALESCE(SUM(
        (julianday(COALESCE(t.stop_time, datetime('now'))) - julianday(t.start_time)) * 24
      ), 0) as hours
      FROM transactions t
      JOIN chargepoints cp ON t.chargepoint_id = cp.id
      WHERE t.status != 'Rejected'
        AND t.start_time >= date('now', '-' || ${days} || ' days')${siteFilter}
    `
      )
      .get(...params);
    utilizationPeriod = Math.min(
      100,
      Math.round((chargingHoursPeriod.hours / (totalConnectors * days * 24)) * 100)
    );

    const firstTx = db
      .prepare(
        `
      SELECT MIN(t.start_time) as first_time
      FROM transactions t
      JOIN chargepoints cp ON t.chargepoint_id = cp.id
      WHERE 1=1${siteFilter}
    `
      )
      .get(...params);
    if (firstTx?.first_time) {
      const totalDays = Math.max(
        1,
        (Date.now() - new Date(firstTx.first_time).getTime()) / (1000 * 60 * 60 * 24)
      );
      const chargingHoursAll = db
        .prepare(
          `
        SELECT COALESCE(SUM(
          (julianday(COALESCE(t.stop_time, datetime('now'))) - julianday(t.start_time)) * 24
        ), 0) as hours
        FROM transactions t
        JOIN chargepoints cp ON t.chargepoint_id = cp.id
        WHERE t.status != 'Rejected'${siteFilter}
      `
        )
        .get(...params);
      utilizationAllTime = Math.min(
        100,
        Math.round((chargingHoursAll.hours / (totalConnectors * totalDays * 24)) * 100)
      );
    }
  }

  return {
    period: { ...period, utilization: utilizationPeriod },
    allTime: { ...allTime, utilization: utilizationAllTime },
  };
}

// Base commune des requêtes transactions. Site, titulaire et catégorie sont ceux figés au
// démarrage (t.site_id, t.user_id, t.tag_category) ; seuls les libellés (nom du site, nom
// actuel du titulaire s'il existe encore) sont relus. chargepoint_site_id = site actuel de la borne.
const TRANSACTIONS_BASE_QUERY = `SELECT t.*, cp.identity as chargepoint_identity, cp.cpname as chargepoint_name,
    cp.site_id as chargepoint_site_id, s.sname as site_name,
    t.user_id as tag_user_id, COALESCE(u.shortname, u.useremail, t.user_name) as tag_username,
    CASE WHEN tv.id IS NOT NULL THEN 1 ELSE 0 END as has_values,
    cn.connector_name as connector_name,
    ev.evse_name as evse_name
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    LEFT JOIN sites s ON t.site_id = s.id
    LEFT JOIN users u ON t.user_id = u.id
    LEFT JOIN transactions_values tv
      ON tv.chargepoint_id = t.chargepoint_id AND tv.transaction_id = t.transaction_id
    LEFT JOIN connectors cn ON cn.chargepoint_id = t.chargepoint_id AND cn.connector_id = t.connector_id AND cn.evse_id IS t.evse_id
    LEFT JOIN evses ev ON ev.chargepoint_id = t.chargepoint_id AND ev.evse_id = t.evse_id`;

function buildTransactionQuery(baseCondition, baseParams, filters) {
  let whereClause = ' WHERE ' + baseCondition;
  const params = [...baseParams];
  if (filters.chargepoint_id) {
    whereClause += ' AND t.chargepoint_id = ?';
    params.push(filters.chargepoint_id);
  }
  // Site figé au démarrage. site_ids = périmètre autorisé, site_id = filtre choisi : les deux
  // s'appliquent (un manager qui filtre un site ne voit que ce site)
  if (filters.site_ids && filters.site_ids.length > 0) {
    whereClause += ` AND t.site_id IN (${filters.site_ids.map(() => '?').join(',')})`;
    params.push(...filters.site_ids);
  }
  if (filters.site_id) {
    whereClause += ' AND t.site_id = ?';
    params.push(filters.site_id);
  }
  if (filters.user_id) {
    whereClause += ' AND t.user_id = ?';
    params.push(filters.user_id);
  }
  if (filters.status) {
    whereClause += ' AND t.status = ?';
    params.push(filters.status);
  } else {
    // Transactions refusées (démarrage non autorisé) : jamais facturées, absentes des listes,
    // totaux et exports — consultables seulement en filtrant explicitement status=Rejected
    whereClause += " AND t.status != 'Rejected'";
  }
  if (filters.category) {
    whereClause += ' AND t.tag_category = ?';
    params.push(filters.category);
  }
  if (filters.from) {
    whereClause += ' AND date(t.start_time) >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    whereClause += ' AND date(t.start_time) <= ?';
    params.push(filters.to);
  }

  if (filters.limit == null) {
    // Chemin sans pagination (CSV export) : retourne tableau brut pour rétrocompat
    return db
      .prepare(TRANSACTIONS_BASE_QUERY + whereClause + ' ORDER BY t.id DESC')
      .all(...params)
      .map((row) => ({ ...row }));
  }

  // Chemin paginé : COUNT + stats agrégées + données
  const countQuery =
    `SELECT
    COUNT(*) as total,
    COALESCE(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
      THEN t.meter_stop - t.meter_start ELSE 0 END), 0) as totalEnergy,
    COUNT(CASE WHEN t.status = 'Active' THEN 1 END) as activeCount,
    COALESCE(SUM(CASE WHEN t.start_time IS NOT NULL AND t.stop_time IS NOT NULL
      THEN (julianday(t.stop_time) - julianday(t.start_time)) * 1440 ELSE 0 END), 0) as totalMinutes
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id` + whereClause;

  const countResult = db.prepare(countQuery).get(...params);
  const costByCurrency = db
    .prepare(
      `SELECT t.cost_currency AS currency, ROUND(SUM(t.cost), 2) AS total
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id` +
        whereClause +
        ' AND t.cost IS NOT NULL GROUP BY t.cost_currency ORDER BY t.cost_currency'
    )
    .all(...params);

  const rows = db
    .prepare(TRANSACTIONS_BASE_QUERY + whereClause + ' ORDER BY t.id DESC LIMIT ? OFFSET ?')
    .all(...params, filters.limit, filters.offset ?? 0)
    .map((row) => {
      // Le détail du coût n'est servi que par GET /transactions/:id
      delete row.cost_details;
      return row;
    });

  return {
    data: rows,
    total: countResult.total,
    stats: {
      totalEnergy: countResult.totalEnergy,
      activeCount: countResult.activeCount,
      totalMinutes: countResult.totalMinutes,
      costByCurrency,
    },
  };
}

function getTransactions(filters = {}) {
  return buildTransactionQuery('1=1', [], filters);
}

function getUserTransactions(userId, filters = {}) {
  return buildTransactionQuery('t.user_id = ?', [userId], filters);
}

/**
 * Rapport « remboursement » : sessions terminées agrégées par site, salarié et devise,
 * pour une catégorie de badge (pro par défaut). Énergie en kWh, coût figé à la clôture.
 * @param {{category?: string, site_id?: number, site_ids?: number[], from?: string, to?: string}} filters
 */
function getReimbursementReport(filters = {}) {
  const category = filters.category || 'pro';
  let where = `t.status = 'Completed' AND t.tag_category = ?`;
  const params = [category];
  if (filters.site_ids && filters.site_ids.length > 0) {
    where += ` AND t.site_id IN (${filters.site_ids.map(() => '?').join(',')})`;
    params.push(...filters.site_ids);
  }
  if (filters.site_id) {
    where += ' AND t.site_id = ?';
    params.push(filters.site_id);
  }
  if (filters.from) {
    where += ' AND date(t.start_time) >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    where += ' AND date(t.start_time) <= ?';
    params.push(filters.to);
  }
  return db
    .prepare(
      // Site, salarié et catégorie figés au démarrage ; nom actuel du salarié s'il existe encore,
      // sinon celui enregistré sur ses sessions
      `SELECT t.site_id AS site_id, s.sname AS site_name,
        t.user_id AS user_id, MAX(COALESCE(u.shortname, u.useremail, t.user_name)) AS user_name,
        t.tag_category AS category,
        COUNT(*) AS sessions,
        ROUND(COALESCE(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
          THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 0), 3) AS energy_kwh,
        ROUND(SUM(t.cost), 2) AS cost,
        t.cost_currency AS currency
      FROM transactions t
      LEFT JOIN sites s ON t.site_id = s.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE ${where}
      GROUP BY t.site_id, t.user_id, t.cost_currency
      ORDER BY s.sname, user_name, t.cost_currency`
    )
    .all(...params)
    .map((row) => ({ ...row }));
}

// ── Meter Values ──
function updateChargepointMeterValue(chargepointId, meterValue) {
  db.prepare(`UPDATE chargepoints SET meter_value = ? WHERE id = ?`).run(meterValue, chargepointId);
}

function updateConnectorMeterValue(chargepointId, connectorId, meterValue, evseId = null) {
  db.prepare(
    `UPDATE connectors SET meter_value = ?, updated_at = datetime('now')
    WHERE chargepoint_id = ? AND connector_id = ? AND COALESCE(evse_id, 0) = COALESCE(?, 0)`
  ).run(meterValue, chargepointId, connectorId, evseId);
  recalcChargepointMeterValue(chargepointId);
}

function recalcChargepointMeterValue(chargepointId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(meter_value), 0) as total FROM connectors WHERE chargepoint_id = ? AND meter_value > 0`
    )
    .get(chargepointId);
  db.prepare(`UPDATE chargepoints SET meter_value = ? WHERE id = ?`).run(row.total, chargepointId);
}

function updateEvseMeterValue(chargepointId, evseId, meterValue) {
  const first = db
    .prepare(
      `SELECT connector_id FROM connectors WHERE chargepoint_id = ? AND evse_id = ? AND connector_id > 0 ORDER BY connector_id LIMIT 1`
    )
    .get(chargepointId, evseId);
  if (!first) return;
  db.prepare(
    `UPDATE connectors SET meter_value = NULL WHERE chargepoint_id = ? AND evse_id = ? AND connector_id != ?`
  ).run(chargepointId, evseId, first.connector_id);
  db.prepare(
    `UPDATE connectors SET meter_value = ?, updated_at = datetime('now') WHERE chargepoint_id = ? AND connector_id = ? AND evse_id = ?`
  ).run(meterValue, chargepointId, first.connector_id, evseId);
  recalcChargepointMeterValue(chargepointId);
}

function updateTransactionPowerEnergy(chargepointId, transactionId, power, energyWh) {
  const updates = [];
  const params = [];
  if (power !== null) {
    updates.push('power = ?');
    params.push(power);
  }
  if (energyWh !== null) {
    updates.push('energy = ? - meter_start');
    params.push(energyWh);
  }
  if (updates.length === 0) return;
  params.push(chargepointId, String(transactionId));
  db.prepare(
    `UPDATE transactions SET ${updates.join(', ')}
     WHERE chargepoint_id = ? AND transaction_id = ? AND status = 'Active'`
  ).run(...params);
}

// Détail d'une transaction par son identifiant interne (transactions.id) : le transaction_id
// OCPP n'est unique que par borne, il ne peut pas servir de clé dans les URL
function getTransactionFullById(id) {
  return db.prepare(`${TRANSACTIONS_BASE_QUERY} WHERE t.id = ?`).get(id);
}

// evseId (OCPP 2.0.1) : les connectorId sont numérotés par EVSE (connecteur 1 sur chaque EVSE),
// connector_id seul est donc ambigu sur une borne multi-EVSE. Les transactions 1.6 ont evse_id NULL.
function getActiveTransactionByConnector(chargepointId, connectorId, evseId = null) {
  if (evseId != null) {
    return db
      .prepare(
        `SELECT * FROM transactions WHERE chargepoint_id = ? AND connector_id = ? AND status = 'Active'
         AND (evse_id IS NULL OR evse_id = ?) ORDER BY id DESC LIMIT 1`
      )
      .get(chargepointId, connectorId, evseId);
  }
  return db
    .prepare(
      `SELECT * FROM transactions WHERE chargepoint_id = ? AND connector_id = ? AND status = 'Active' ORDER BY id DESC LIMIT 1`
    )
    .get(chargepointId, connectorId);
}

// Renseigne le badge d'une transaction démarrée sans identification (2.0.1 : câble branché puis
// badge présenté dans un TransactionEvent Updated). Sans effet si un badge est déjà enregistré.
// Le titulaire et la catégorie du badge sont figés à ce moment, avec le site figé au démarrage.
function setTransactionIdTag(chargepointId, transactionId, idTag, idTokenType = null) {
  const tx = getTransactionByTransactionId(chargepointId, transactionId);
  const siteId =
    tx && tx.site_id != null
      ? tx.site_id
      : resolveTransactionAttribution(chargepointId, null).site_id;
  const attribution = resolveTagAttribution(idTag, siteId);
  return db
    .prepare(
      `UPDATE transactions SET id_tag = ?, id_token_type = COALESCE(?, id_token_type),
         user_id = ?, user_name = ?, tag_category = ?
       WHERE chargepoint_id = ? AND transaction_id = ? AND status = 'Active'
         AND (id_tag IS NULL OR id_tag = '')`
    )
    .run(
      idTag,
      idTokenType,
      attribution.user_id,
      attribution.user_name,
      attribution.tag_category,
      chargepointId,
      String(transactionId)
    ).changes;
}

function getTransactionValues(chargepointId, transactionId) {
  return db
    .prepare('SELECT * FROM transactions_values WHERE chargepoint_id = ? AND transaction_id = ?')
    .get(chargepointId, String(transactionId));
}

// ── Transactions Values ──
function upsertTransactionValues(
  chargepointId,
  transactionId,
  { energieEntry, courantEntry, socEntry, tempEntry, tensionEntry, freqEntry } = {}
) {
  transactionId = String(transactionId);
  const existing = getTransactionValues(chargepointId, transactionId);
  if (existing) {
    const updates = [];
    const params = [];
    if (socEntry) {
      const arr = existing.soc ? JSON.parse(existing.soc) : [];
      arr.push(socEntry);
      updates.push('soc = ?');
      params.push(JSON.stringify(arr));
    }
    if (courantEntry) {
      const arr = existing.courant ? JSON.parse(existing.courant) : [];
      arr.push(courantEntry);
      updates.push('courant = ?');
      params.push(JSON.stringify(arr));
    }
    if (energieEntry) {
      const arr = existing.energie ? JSON.parse(existing.energie) : [];
      arr.push(energieEntry);
      updates.push('energie = ?');
      params.push(JSON.stringify(arr));
    }
    if (tempEntry) {
      const arr = existing.temperature ? JSON.parse(existing.temperature) : [];
      arr.push(tempEntry);
      updates.push('temperature = ?');
      params.push(JSON.stringify(arr));
    }
    if (tensionEntry) {
      const arr = existing.tension ? JSON.parse(existing.tension) : [];
      arr.push(tensionEntry);
      updates.push('tension = ?');
      params.push(JSON.stringify(arr));
    }
    if (freqEntry) {
      const arr = existing.frequence ? JSON.parse(existing.frequence) : [];
      arr.push(freqEntry);
      updates.push('frequence = ?');
      params.push(JSON.stringify(arr));
    }
    if (updates.length > 0) {
      params.push(existing.id);
      db.prepare(`UPDATE transactions_values SET ${updates.join(', ')} WHERE id = ?`).run(
        ...params
      );
    }
  } else {
    db.prepare(
      'INSERT INTO transactions_values (chargepoint_id, transaction_id, energie, courant, soc, temperature, tension, frequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      chargepointId,
      transactionId,
      energieEntry ? JSON.stringify([energieEntry]) : null,
      courantEntry ? JSON.stringify([courantEntry]) : null,
      socEntry ? JSON.stringify([socEntry]) : null,
      tempEntry ? JSON.stringify([tempEntry]) : null,
      tensionEntry ? JSON.stringify([tensionEntry]) : null,
      freqEntry ? JSON.stringify([freqEntry]) : null
    );
  }
}

// ── OCPP Messages ──
function addOcppMessage(chargepointId, origin, messageType, action, payload) {
  db.prepare(
    `INSERT INTO ocpp_messages (chargepoint_id, origin, message_type, action, payload)
    VALUES (?, ?, ?, ?, ?)`
  ).run(
    chargepointId,
    origin,
    messageType,
    action || null,
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  );
}

function getOcppMessages(filters = {}) {
  let query = `SELECT om.*, cp.identity AS chargepoint_identity
    FROM ocpp_messages om
    LEFT JOIN chargepoints cp ON cp.id = om.chargepoint_id
    WHERE 1=1`;
  const params = [];
  if (filters.chargepoint_id) {
    query += ' AND om.chargepoint_id = ?';
    params.push(filters.chargepoint_id);
  }
  if (filters.origin) {
    query += ' AND om.origin = ?';
    params.push(filters.origin);
  }
  if (filters.message_type) {
    query += ' AND om.message_type = ?';
    params.push(filters.message_type);
  }
  if (filters.actions && filters.actions.length > 0) {
    const conditions = filters.actions.map(() => 'UPPER(om.action) LIKE UPPER(?)').join(' OR ');
    query += ` AND (${conditions})`;
    filters.actions.forEach((a) => params.push(`%${a}%`));
  }
  if (filters.date_from) {
    query += ' AND om.timestamp >= ?';
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    query += ' AND om.timestamp <= ?';
    params.push(filters.date_to);
  }
  if (filters.site_ids && filters.site_ids.length > 0) {
    query += ` AND cp.site_id IN (${filters.site_ids.map(() => '?').join(',')})`;
    params.push(...filters.site_ids);
  }
  query += ' ORDER BY om.id DESC';
  return db.prepare(query).all(...params);
}

function clearOcppMessages(chargepointId, before) {
  const conditions = [];
  const params = [];
  if (chargepointId) {
    conditions.push('chargepoint_id = ?');
    params.push(chargepointId);
  }
  if (before) {
    conditions.push('timestamp < ?');
    params.push(before);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`DELETE FROM ocpp_messages${where}`).run(...params).changes;
}

// ── Chargepoint Configuration ──
function upsertChargepointConfig(chargepointId, key, value, readonly, isOverride = false) {
  const existing = db
    .prepare('SELECT id FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?')
    .get(chargepointId, key);
  if (existing) {
    if (isOverride) {
      db.prepare(
        `UPDATE chargepoint_config SET value = ?, readonly = ?, is_override = 1, updated_at = datetime('now')
        WHERE chargepoint_id = ? AND key = ?`
      ).run(value, readonly ? 1 : 0, chargepointId, key);
    } else {
      db.prepare(
        `UPDATE chargepoint_config SET value = ?, readonly = ?, updated_at = datetime('now')
        WHERE chargepoint_id = ? AND key = ?`
      ).run(value, readonly ? 1 : 0, chargepointId, key);
    }
  } else {
    db.prepare(
      'INSERT INTO chargepoint_config (chargepoint_id, key, value, readonly, is_override) VALUES (?, ?, ?, ?, ?)'
    ).run(chargepointId, key, value, readonly ? 1 : 0, isOverride ? 1 : 0);
  }
}

function bulkUpsertChargepointConfig(chargepointId, configurationKeys) {
  const upsert = db.transaction((keys) => {
    for (const item of keys) {
      upsertChargepointConfig(chargepointId, item.key, item.value || null, item.readonly);
    }
    // Mettre à jour les feat_* si SupportedFeatureProfiles est présent
    const sfp = keys.find((k) => k.key === 'SupportedFeatureProfiles');
    if (sfp && sfp.value) {
      updateChargepointFeatures(chargepointId, sfp.value);
    }
  });
  upsert(configurationKeys);
}

/**
 * Met à jour les champs feat_* de la table chargepoints
 * à partir de la valeur de SupportedFeatureProfiles (liste séparée par des virgules).
 */
function updateChargepointFeatures(chargepointId, profilesString) {
  const profiles = profilesString.split(',').map((p) => p.trim());
  const feat_trigger = profiles.includes('RemoteTrigger') ? 1 : 0;
  const feat_firmware = profiles.includes('FirmwareManagement') ? 1 : 0;
  const feat_local_list = profiles.includes('LocalAuthListManagement') ? 1 : 0;
  const feat_reservation = profiles.includes('Reservation') ? 1 : 0;
  const feat_smartcharging = profiles.includes('SmartCharging') ? 1 : 0;
  db.prepare(
    `UPDATE chargepoints SET feat_trigger = ?, feat_firmware = ?, feat_local_list = ?, feat_reservation = ?, feat_smartcharging = ? WHERE id = ?`
  ).run(
    feat_trigger,
    feat_firmware,
    feat_local_list,
    feat_reservation,
    feat_smartcharging,
    chargepointId
  );
}

/**
 * Met à jour les champs feat_* de la table chargepoints pour une borne OCPP 2.0.1
 * en lisant la variable Available de chaque composant de capacité dans chargepoint_variables.
 */
function updateChargepointFeatures201(chargepointId) {
  const rows = db
    .prepare(
      "SELECT component, value FROM chargepoint_variables WHERE chargepoint_id = ? AND variable = 'Available' AND attribute = 'Actual'"
    )
    .all(chargepointId);
  const avail = {};
  for (const r of rows) avail[r.component] = r.value === 'true';
  db.prepare(
    `UPDATE chargepoints SET feat_trigger = 1, feat_firmware = ?, feat_local_list = ?, feat_reservation = ?, feat_smartcharging = ? WHERE id = ?`
  ).run(
    avail['FirmwareCtrlr'] ? 1 : 0,
    avail['LocalAuthListCtrlr'] ? 1 : 0,
    avail['ReservationCtrlr'] ? 1 : 0,
    avail['SmartChargingCtrlr'] ? 1 : 0,
    chargepointId
  );
}

function getChargepointConfig(chargepointId) {
  return db
    .prepare('SELECT * FROM chargepoint_config WHERE chargepoint_id = ? ORDER BY key')
    .all(chargepointId);
}

function getChargepointConfigByKey(chargepointId, key) {
  return db
    .prepare('SELECT * FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?')
    .get(chargepointId, key);
}

function setChargepointConfigOverride(chargepointId, key, isOverride) {
  db.prepare(
    `UPDATE chargepoint_config SET is_override = ?, updated_at = datetime('now')
     WHERE chargepoint_id = ? AND key = ?`
  ).run(isOverride ? 1 : 0, chargepointId, key);
}

function getChargepointOverrideConfigs(chargepointId) {
  return db
    .prepare('SELECT * FROM chargepoint_config WHERE chargepoint_id = ? AND is_override = 1')
    .all(chargepointId);
}

// Variable de niveau borne (pas d'EVSE / connecteur) ; `instance` '' = variable sans instance
function getChargepointVariableByKey(
  chargepointId,
  component,
  variable,
  attribute = 'Actual',
  instance = ''
) {
  return db
    .prepare(
      `SELECT * FROM chargepoint_variables WHERE chargepoint_id = ? AND component = ? AND variable = ?
       AND attribute = ? AND instance = ? AND evse_id = 0 AND connector_id = 0`
    )
    .get(chargepointId, component, variable, attribute, instance || '');
}

function setChargepointVariableOverride(
  chargepointId,
  component,
  variable,
  attribute,
  isOverride,
  instance = ''
) {
  db.prepare(
    `UPDATE chargepoint_variables SET is_override = ?, updated_at = datetime('now')
     WHERE chargepoint_id = ? AND component = ? AND variable = ? AND attribute = ?
       AND instance = ? AND evse_id = 0 AND connector_id = 0`
  ).run(isOverride ? 1 : 0, chargepointId, component, variable, attribute, instance || '');
}

function getChargepointOverrideVariables(chargepointId) {
  return db
    .prepare('SELECT * FROM chargepoint_variables WHERE chargepoint_id = ? AND is_override = 1')
    .all(chargepointId);
}

function deleteChargepointConfig(chargepointId, key) {
  db.prepare('DELETE FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?').run(
    chargepointId,
    key
  );
}

function getChargepointVariables(chargepointId) {
  return db
    .prepare(
      'SELECT * FROM chargepoint_variables WHERE chargepoint_id = ? ORDER BY component, variable, attribute'
    )
    .all(chargepointId);
}

function getInitialChargepointConfig() {
  return db.prepare('SELECT * FROM chargepoint_init_config ORDER BY key').all();
}

function getEnabledInitialChargepointConfig() {
  return db.prepare('SELECT * FROM chargepoint_init_config WHERE enabled = 1 ORDER BY key').all();
}

function getInitialChargepointConfigByKey(key) {
  return db.prepare('SELECT * FROM chargepoint_init_config WHERE key = ?').get(key);
}

function createInitialChargepointConfig(key, value, enabled) {
  return db
    .prepare('INSERT INTO chargepoint_init_config (key, value, enabled) VALUES (?, ?, ?)')
    .run(key, value, enabled ? 1 : 0);
}

function updateInitialChargepointConfig(id, data) {
  const fields = [];
  const values = [];
  if (data.value !== undefined) {
    fields.push('value = ?');
    values.push(data.value);
  }
  if (data.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(data.enabled ? 1 : 0);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE chargepoint_init_config SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function deleteInitialChargepointConfig(id) {
  db.prepare('DELETE FROM chargepoint_init_config WHERE id = ?').run(id);
}

function getInitialChargepointVariables() {
  return db
    .prepare(
      'SELECT * FROM chargepoint_init_variables ORDER BY component, variable, attribute, instance'
    )
    .all();
}

function getEnabledInitialChargepointVariables() {
  return db
    .prepare(
      'SELECT * FROM chargepoint_init_variables WHERE enabled = 1 ORDER BY component, variable, attribute, instance'
    )
    .all();
}

function getInitialChargepointVariableByKey(component, variable) {
  return db
    .prepare(
      "SELECT * FROM chargepoint_init_variables WHERE component = ? AND variable = ? AND attribute = 'Actual' AND instance = '' LIMIT 1"
    )
    .get(component, variable);
}

// `instance` : instance de la variable dans le Device Model ('' = aucune), ex. MessageTimeout
// n'existe qu'avec l'instance « Default »
function createInitialChargepointVariable(
  component,
  variable,
  attribute,
  value,
  enabled,
  instance = ''
) {
  return db
    .prepare(
      'INSERT INTO chargepoint_init_variables (component, variable, attribute, instance, value, enabled) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(component, variable, attribute || 'Actual', instance || '', value, enabled ? 1 : 0);
}

function updateInitialChargepointVariable(id, data) {
  const fields = [];
  const values = [];
  if (data.value !== undefined) {
    fields.push('value = ?');
    values.push(data.value);
  }
  if (data.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(data.enabled ? 1 : 0);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE chargepoint_init_variables SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values
  );
}

function deleteInitialChargepointVariable(id) {
  db.prepare('DELETE FROM chargepoint_init_variables WHERE id = ?').run(id);
}

function markChargepointInitialized(chargepointId) {
  db.prepare('UPDATE chargepoints SET initialized = 1 WHERE id = ?').run(chargepointId);
}

function resetChargepointInitialized(chargepointId) {
  db.prepare('UPDATE chargepoints SET initialized = 0 WHERE id = ?').run(chargepointId);
}

// ── Id Tags ──
function getAllIdTags() {
  const tags = db
    .prepare(
      `
    SELECT it.*, COALESCE(u.shortname, u.useremail) as user_name, s.sname as site_name
    FROM id_tags it
    LEFT JOIN users u ON it.user_id = u.id
    LEFT JOIN sites s ON it.site_id = s.id
    ORDER BY it.id_tag
  `
    )
    .all();
  // Pour les tags liés à un utilisateur sans site spécifique, récupérer les sites autorisés
  const stmtUserSites = db.prepare(`
    SELECT us.site_id, s.sname as site_name
    FROM user_sites us
    JOIN sites s ON us.site_id = s.id
    WHERE us.user_id = ? AND us.authorized = 1
    ORDER BY s.sname
  `);
  for (const t of tags) {
    if (t.user_id && !t.site_id) {
      t.user_sites = stmtUserSites.all(t.user_id);
    }
  }
  return tags;
}

function getIdTagById(id) {
  return db
    .prepare(
      `
    SELECT it.*, COALESCE(u.shortname, u.useremail) as user_name, s.sname as site_name
    FROM id_tags it
    LEFT JOIN users u ON it.user_id = u.id
    LEFT JOIN sites s ON it.site_id = s.id
    WHERE it.id = ?
  `
    )
    .get(id);
}

function getIdTagByTag(idTag, siteId) {
  if (siteId) {
    // Chercher d'abord un tag spécifique au site, puis un tag global
    return db
      .prepare(
        `
      SELECT it.*, COALESCE(u.shortname, u.useremail) as user_name, s.sname as site_name
      FROM id_tags it
      LEFT JOIN users u ON it.user_id = u.id
      LEFT JOIN sites s ON it.site_id = s.id
      WHERE it.id_tag = ? AND (it.site_id = ? OR it.site_id IS NULL)
      ORDER BY it.site_id DESC
      LIMIT 1
    `
      )
      .get(idTag, siteId);
  }
  return db
    .prepare(
      `
    SELECT it.*, COALESCE(u.shortname, u.useremail) as user_name, s.sname as site_name
    FROM id_tags it
    LEFT JOIN users u ON it.user_id = u.id
    LEFT JOIN sites s ON it.site_id = s.id
    WHERE it.id_tag = ?
    LIMIT 1
  `
    )
    .get(idTag);
}

// Un même code est soit global (tous les sites), soit limité à un ou plusieurs sites, jamais
// les deux : sinon la fiche du site prendrait la priorité sur la fiche globale à l'insu de son
// titulaire. Renvoie true si l'enregistrement (idTag, siteId) entrerait en conflit.
function hasIdTagScopeConflict(idTag, siteId, excludeId = null) {
  const row = siteId
    ? db
        .prepare(
          'SELECT 1 FROM id_tags WHERE id_tag = ? AND (site_id IS NULL OR site_id = ?) AND id IS NOT ? LIMIT 1'
        )
        .get(idTag, siteId, excludeId)
    : db
        .prepare('SELECT 1 FROM id_tags WHERE id_tag = ? AND id IS NOT ? LIMIT 1')
        .get(idTag, excludeId);
  return !!row;
}

// Codes enregistrés à la fois en global et pour un site (antérieurs à la règle ci-dessus)
function getIdTagScopeConflictCodes() {
  return db
    .prepare(
      `SELECT id_tag FROM id_tags GROUP BY id_tag
       HAVING SUM(CASE WHEN site_id IS NULL THEN 1 ELSE 0 END) > 0 AND COUNT(*) > 1
       ORDER BY id_tag`
    )
    .all()
    .map((r) => r.id_tag);
}

// Sessions (hors démarrages refusés) faites avec ce badge : un badge qui a servi ne se supprime
// pas, il se désactive (l'historique le référence)
function countIdTagSessions(tag) {
  const row = tag.site_id
    ? db
        .prepare(
          "SELECT COUNT(*) AS n FROM transactions WHERE id_tag = ? AND site_id = ? AND status != 'Rejected'"
        )
        .get(tag.id_tag, tag.site_id)
    : db
        .prepare("SELECT COUNT(*) AS n FROM transactions WHERE id_tag = ? AND status != 'Rejected'")
        .get(tag.id_tag);
  return row.n;
}

// Titulaire d'un badge, pour les contrôles de droits (idTagPolicy.js) : rôle et sites liés
function getUserScope(userId) {
  if (userId == null) return null;
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const siteIds = db
    .prepare('SELECT site_id FROM user_sites WHERE user_id = ?')
    .all(userId)
    .map((r) => r.site_id);
  return { role: user.role, site_ids: siteIds };
}

// Utilisateurs liés aux sites donnés (null = tous les utilisateurs), avec leurs sites
function getUsersWithSites(siteIds = null) {
  const users =
    siteIds === null
      ? db.prepare('SELECT id, useremail, shortname, role FROM users ORDER BY useremail').all()
      : siteIds.length === 0
        ? []
        : db
            .prepare(
              `SELECT DISTINCT u.id, u.useremail, u.shortname, u.role FROM users u
               JOIN user_sites us ON us.user_id = u.id
               WHERE us.site_id IN (${siteIds.map(() => '?').join(',')})
               ORDER BY u.useremail`
            )
            .all(...siteIds);
  const stmt = db.prepare('SELECT site_id FROM user_sites WHERE user_id = ?');
  return users.map((u) => ({ ...u, site_ids: stmt.all(u.id).map((r) => r.site_id) }));
}

function createIdTag(
  idTag,
  userId,
  siteId,
  description,
  expiryDate,
  active = 1,
  token_type = 'ISO14443',
  group_id_token = null,
  category = 'perso'
) {
  const info = db
    .prepare(
      'INSERT INTO id_tags (id_tag, user_id, site_id, description, expiry_date, active, token_type, group_id_token, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      idTag,
      userId || null,
      siteId || null,
      description || null,
      expiryDate || null,
      active ? 1 : 0,
      token_type,
      group_id_token || null,
      category || 'perso'
    );
  return getIdTagById(info.lastInsertRowid);
}

function updateIdTag(id, data) {
  const tag = db.prepare('SELECT * FROM id_tags WHERE id = ?').get(id);
  if (!tag) return null;
  const idTag = data.id_tag !== undefined ? data.id_tag : tag.id_tag;
  const userId = data.user_id !== undefined ? data.user_id : tag.user_id;
  const siteId = data.site_id !== undefined ? data.site_id : tag.site_id;
  const active = data.active !== undefined ? data.active : tag.active;
  const description = data.description !== undefined ? data.description : tag.description;
  const expiryDate = data.expiry_date !== undefined ? data.expiry_date : tag.expiry_date;
  const tokenType = data.token_type !== undefined ? data.token_type : tag.token_type || 'ISO14443';
  const groupIdToken = data.group_id_token !== undefined ? data.group_id_token : tag.group_id_token;
  const category = data.category !== undefined ? data.category : tag.category;
  db.prepare(
    'UPDATE id_tags SET id_tag = ?, user_id = ?, site_id = ?, active = ?, description = ?, expiry_date = ?, token_type = ?, group_id_token = ?, category = ? WHERE id = ?'
  ).run(
    idTag,
    userId || null,
    siteId || null,
    active,
    description || null,
    expiryDate || null,
    tokenType,
    groupIdToken || null,
    category || 'perso',
    id
  );
  return getIdTagById(id);
}

function deleteIdTag(id) {
  db.prepare('DELETE FROM id_tags WHERE id = ?').run(id);
}

/**
 * Vérifie si un idTag est autorisé pour un site donné.
 * Retourne { status: 'Accepted'|'Blocked'|'Expired'|'Invalid', tag, user }
 */
/**
 * Retourne tous les connecteurs des sites autorisés pour un utilisateur donné.
 * L'utilisateur doit être autorisé (user_sites.authorized = 1) sur le site.
 * Retourne tous les connecteurs, y compris hors ligne ou occupés.
 */
function getUserDashboardStats(userId) {
  // Nombre de recharges du mois en cours et énergie totale
  const monthStats = db
    .prepare(
      `
    SELECT COUNT(*) as charge_count,
      ROUND(COALESCE(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 0), 2) as total_energy_kwh
    FROM transactions t
    WHERE t.user_id = ?
      AND t.status = 'Completed'
      AND t.start_time >= date('now', 'start of month')
  `
    )
    .get(userId);

  return {
    chargesThisMonth: monthStats?.charge_count || 0,
    energyThisMonth: monthStats?.total_energy_kwh || 0,
  };
}

function getUserTransactionStats(userId, filters = {}) {
  const hasFilters = filters.from || filters.to || filters.status || filters.category;
  const buildQuery = (extraWhere) => `
    SELECT
      COUNT(*) as totalSessions,
      ROUND(COALESCE(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 0), 2) as totalEnergy,
      ROUND(COALESCE(AVG(
        CASE WHEN t.stop_time IS NOT NULL AND t.start_time IS NOT NULL
          THEN (julianday(t.stop_time) - julianday(t.start_time)) * 24 * 60
          ELSE NULL END
      ), 0), 0) as avgDuration,
      ROUND(COALESCE(AVG(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE NULL END), 0), 2) as avgEnergy
    FROM transactions t
    WHERE t.user_id = ? AND t.status = 'Completed'${extraWhere}`;

  // Coût figé des sessions, par devise (on n'additionne jamais des devises différentes)
  const buildCostQuery = (extraWhere) => `
    SELECT t.cost_currency AS currency, ROUND(SUM(t.cost), 2) AS total
    FROM transactions t
    WHERE t.user_id = ? AND t.status = 'Completed' AND t.cost IS NOT NULL${extraWhere}
    GROUP BY t.cost_currency ORDER BY t.cost_currency`;
  const withCost = (stats, extraWhere, params = [userId]) => ({
    ...stats,
    costByCurrency: db.prepare(buildCostQuery(extraWhere)).all(...params),
  });

  // Mois en cours
  const currentMonthWhere = ` AND t.start_time >= date('now', 'start of month')`;
  const currentMonth = withCost(
    db.prepare(buildQuery(currentMonthWhere)).get(userId),
    currentMonthWhere
  );

  // Mois précédent
  const prevMonthWhere = ` AND t.start_time >= date('now', 'start of month', '-1 month') AND t.start_time < date('now', 'start of month')`;
  const prevMonth = withCost(db.prepare(buildQuery(prevMonthWhere)).get(userId), prevMonthWhere);

  // All-time
  const allTime = withCost(db.prepare(buildQuery('')).get(userId), '');

  // Si des filtres de dates sont actifs, calculer les stats filtrées
  let filtered = null;
  if (hasFilters) {
    let filterWhere = '';
    const filterParams = [userId];
    if (filters.from) {
      filterWhere += ' AND date(t.start_time) >= ?';
      filterParams.push(filters.from);
    }
    if (filters.to) {
      filterWhere += ' AND date(t.start_time) <= ?';
      filterParams.push(filters.to);
    }
    if (filters.category) {
      filterWhere += ' AND t.tag_category = ?';
      filterParams.push(filters.category);
    }
    filtered = withCost(
      db.prepare(buildQuery(filterWhere)).get(...filterParams),
      filterWhere,
      filterParams
    );
  }

  return { currentMonth, prevMonth, allTime, filtered };
}

function getAvailableConnectorsForUser(userId) {
  return db
    .prepare(
      `
    SELECT c.*, cp.identity as chargepoint_identity, cp.id as chargepoint_id,
           cp.cpname as chargepoint_name, cp.mode, cp.connected, cp.cpstatus as cp_status,
           s.sname as site_name, s.id as site_id, us.authorized as site_authorized,
           t.transaction_id as active_transaction_id, t.id_tag as active_id_tag,
           t.power as active_power, t.energy as active_energy,
           t.user_id as active_user_id
    FROM connectors c
    JOIN chargepoints cp ON c.chargepoint_id = cp.id
    JOIN sites s ON cp.site_id = s.id
    JOIN user_sites us ON us.site_id = s.id AND us.user_id = ?
    LEFT JOIN transactions t ON t.chargepoint_id = cp.id AND t.connector_id = c.connector_id AND t.status = 'Active'
      AND (t.evse_id IS NULL OR c.evse_id IS NULL OR t.evse_id = c.evse_id)
    WHERE c.connector_id > 0 AND cp.archived_at IS NULL
    ORDER BY s.sname, cp.identity, c.connector_id
  `
    )
    .all(userId);
}

function authorizeIdTag(idTag, siteId, tokenType) {
  // Borne sans site : inactive, aucun badge n'y est accepté (voir chargepointPolicy.js)
  if (siteId == null) {
    return { status: 'Blocked', reason: 'chargepoint_no_site', tag: null };
  }
  const tag = getIdTagByTag(idTag, siteId);
  if (!tag) {
    return { status: 'Invalid', reason: 'unknown_tag', tag: null };
  }
  if (tokenType && tag.token_type && tag.token_type !== tokenType) {
    return { status: 'Invalid', reason: 'type_mismatch', tag };
  }
  if (!tag.active) {
    return { status: 'Blocked', reason: 'inactive_tag', tag };
  }
  if (tag.expiry_date) {
    const expiry = new Date(tag.expiry_date);
    if (expiry < new Date()) {
      return { status: 'Expired', reason: 'expired_tag', tag };
    }
  }
  // Vérifier le site : si site_id est défini sur le tag, il doit correspondre
  if (tag.site_id && tag.site_id !== siteId) {
    return { status: 'Blocked', reason: 'wrong_site', tag };
  }
  // Compte du titulaire désactivé : ses badges sont suspendus
  if (tag.user_id) {
    const owner = db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(tag.user_id);
    if (owner && owner.disabled_at) {
      return { status: 'Blocked', reason: 'user_disabled', tag };
    }
  }
  // Vérifier l'autorisation utilisateur sur le site
  // Un admin/manager peut configurer les bornes sans être autorisé à les utiliser
  if (tag.user_id) {
    const userSite = db
      .prepare('SELECT authorized FROM user_sites WHERE user_id = ? AND site_id = ?')
      .get(tag.user_id, siteId);
    // Si l'utilisateur est associé au site mais pas autorisé à charger
    if (userSite && !userSite.authorized) {
      return { status: 'Blocked', reason: 'user_not_authorized', tag };
    }
    // Si l'utilisateur n'est pas associé au site du tout, on bloque aussi
    if (!userSite) {
      return { status: 'Blocked', reason: 'user_not_linked', tag };
    }
  }
  return { status: 'Accepted', reason: null, tag };
}

// Badges d'un utilisateur utilisables pour démarrer une recharge depuis le site web sur une borne
// du site siteId. Mêmes contrôles qu'un badge présenté sur la borne (actif, expiration, site,
// autorisation sur le site) : un démarrage à distance en attente n'est pas recontrôlé à la
// réception du StartTransaction / TransactionEvent, c'est donc ici que le badge doit être valide.
// ignoreUserSite : un admin démarre sans être autorisé sur le site (même règle que la route).
// Retourne { candidates, usable, rejected } — candidates = nombre de badges de l'utilisateur
// pour ce site (0 → badge web automatique), usable = badges valides, rejected = les autres.
// Le badge web automatique WEB-<userId> n'est jamais compté : il reste inactif en base (refusé en
// RFID) et ne sert que de repli quand l'utilisateur n'a aucun autre badge. Le compter ferait
// refuser tout démarrage web après le premier.
const USER_SITE_REASONS = new Set(['user_not_authorized', 'user_not_linked']);

function getUserStartIdTags(userId, siteId, { ignoreUserSite = false } = {}) {
  const tags = db
    .prepare(
      'SELECT * FROM id_tags WHERE user_id = ? AND (site_id IS NULL OR site_id = ?) AND id_tag != ? ORDER BY id_tag'
    )
    .all(userId, siteId ?? null, `WEB-${userId}`);
  const usable = [];
  const rejected = [];
  for (const t of tags) {
    const auth = authorizeIdTag(t.id_tag, siteId ?? null);
    // Même id_tag enregistré aussi pour ce site (autre ligne prioritaire) : c'est cette autre
    // ligne qui serait retenue à la réception de la transaction, pas celle de l'utilisateur.
    if (!auth.tag || auth.tag.id !== t.id) {
      rejected.push({ id_tag: t.id_tag, status: 'Invalid', reason: 'shadowed_tag' });
      continue;
    }
    const ok = auth.status === 'Accepted' || (ignoreUserSite && USER_SITE_REASONS.has(auth.reason));
    if (ok) {
      usable.push({
        id_tag: t.id_tag,
        description: t.description,
        category: t.category,
        site_id: t.site_id,
      });
    } else {
      rejected.push({ id_tag: t.id_tag, status: auth.status, reason: auth.reason });
    }
  }
  return { candidates: tags.length, usable, rejected };
}

// ── Id Tags Events ──
function addIdTagEvent(chargepointId, connectorId, idTag, status, reason, source) {
  db.prepare(
    `INSERT INTO id_tags_events (chargepoint_id, connector_id, id_tag, status, reason, source)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(chargepointId, connectorId || null, idTag, status, reason || null, source || 'authorize');
}

function getIdTagEvents(filters = {}) {
  let query = `SELECT ite.*, cp.identity AS chargepoint_identity, cp.cpname AS chargepoint_name, cp.site_id
    FROM id_tags_events ite
    LEFT JOIN chargepoints cp ON cp.id = ite.chargepoint_id
    WHERE 1=1`;
  const params = [];
  if (filters.chargepoint_id) {
    query += ' AND ite.chargepoint_id = ?';
    params.push(filters.chargepoint_id);
  }
  if (filters.id_tag) {
    query += ' AND UPPER(ite.id_tag) LIKE UPPER(?)';
    params.push(`%${filters.id_tag}%`);
  }
  if (filters.status) {
    query += ' AND ite.status = ?';
    params.push(filters.status);
  }
  if (filters.site_ids && filters.site_ids.length > 0) {
    query += ` AND cp.site_id IN (${filters.site_ids.map(() => '?').join(',')})`;
    params.push(...filters.site_ids);
  }
  const limit = filters.limit || 100;
  query += ' ORDER BY ite.id DESC LIMIT ?';
  params.push(limit);
  return db.prepare(query).all(...params);
}

function getIdTagEventById(id) {
  return db
    .prepare(
      `SELECT ite.*, cp.site_id
     FROM id_tags_events ite
     LEFT JOIN chargepoints cp ON cp.id = ite.chargepoint_id
     WHERE ite.id = ?`
    )
    .get(id);
}

function deleteIdTagEvent(id) {
  return db.prepare('DELETE FROM id_tags_events WHERE id = ?').run(id).changes;
}

// ── Notification Preferences ──
function getNotificationPreferences(userId) {
  return db
    .prepare(
      'SELECT * FROM notification_preferences WHERE user_id = ? ORDER BY event_type, channel'
    )
    .all(userId);
}

function setNotificationPreference(userId, eventType, channel, enabled) {
  const existing = db
    .prepare(
      'SELECT id FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?'
    )
    .get(userId, eventType, channel);

  if (existing) {
    db.prepare('UPDATE notification_preferences SET enabled = ? WHERE id = ?').run(
      enabled ? 1 : 0,
      existing.id
    );
  } else {
    db.prepare(
      'INSERT INTO notification_preferences (user_id, event_type, channel, enabled) VALUES (?, ?, ?, ?)'
    ).run(userId, eventType, channel, enabled ? 1 : 0);
  }
}

function setNotificationPreferencesBulk(userId, preferences) {
  const upsert = db.transaction((prefs) => {
    for (const p of prefs) {
      setNotificationPreference(userId, p.event_type, p.channel, p.enabled);
    }
  });
  upsert(preferences);
}

// ── Push Subscriptions ──
function getPushSubscriptions(userId) {
  return db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

function savePushSubscription(userId, subscription, userAgent) {
  const existing = db
    .prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?')
    .get(subscription.endpoint);
  if (existing) {
    db.prepare(
      'UPDATE push_subscriptions SET user_id = ?, keys_p256dh = ?, keys_auth = ?, user_agent = ? WHERE endpoint = ?'
    ).run(
      userId,
      subscription.keys.p256dh,
      subscription.keys.auth,
      userAgent || null,
      subscription.endpoint
    );
    return existing;
  }
  const info = db
    .prepare(
      'INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth, user_agent) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      userId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      userAgent || null
    );
  return { id: info.lastInsertRowid };
}

function deletePushSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function deletePushSubscriptionByUser(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(
    userId,
    endpoint
  );
}

function deletePushSubscriptionsByUser(userId) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
}

// ── OCPP 2.0.1 — EVSEs & Variables ──
function upsertEvse(chargepointId, evseId, status) {
  const existing = db
    .prepare('SELECT id FROM evses WHERE chargepoint_id = ? AND evse_id = ?')
    .get(chargepointId, evseId);
  if (existing) {
    db.prepare('UPDATE evses SET status = ? WHERE chargepoint_id = ? AND evse_id = ?').run(
      status || 'Available',
      chargepointId,
      evseId
    );
  } else {
    db.prepare('INSERT INTO evses (chargepoint_id, evse_id, status) VALUES (?, ?, ?)').run(
      chargepointId,
      evseId,
      status || 'Available'
    );
  }
}

function getEvsesByChargepoint(chargepointId) {
  return db
    .prepare('SELECT * FROM evses WHERE chargepoint_id = ? ORDER BY evse_id')
    .all(chargepointId);
}

function updateEvseName(chargepointId, evseId, name) {
  db.prepare('UPDATE evses SET evse_name = ? WHERE chargepoint_id = ? AND evse_id = ?').run(
    name || null,
    chargepointId,
    evseId
  );
  return db
    .prepare('SELECT * FROM evses WHERE chargepoint_id = ? AND evse_id = ?')
    .get(chargepointId, evseId);
}

function upsertChargepointVariable(
  chargepointId,
  component,
  variable,
  attribute,
  value,
  readonly = 0,
  instance = '',
  evseId = 0,
  connectorId = 0
) {
  const attr = attribute || 'Actual';
  const existing = db
    .prepare(
      'SELECT id FROM chargepoint_variables WHERE chargepoint_id = ? AND component = ? AND variable = ? AND attribute = ? AND instance = ? AND evse_id = ? AND connector_id = ?'
    )
    .get(chargepointId, component, variable, attr, instance, evseId, connectorId);
  if (existing) {
    db.prepare(
      "UPDATE chargepoint_variables SET value = ?, readonly = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(value ?? null, readonly, existing.id);
  } else {
    db.prepare(
      'INSERT INTO chargepoint_variables (chargepoint_id, component, variable, attribute, value, readonly, instance, evse_id, connector_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      chargepointId,
      component,
      variable,
      attr,
      value ?? null,
      readonly,
      instance,
      evseId,
      connectorId
    );
  }
}

// ── Error Events ──
function insertErrorEvent(
  chargepointId,
  eventType,
  {
    ocpp_version = '1.6',
    connector_id,
    status,
    error_code,
    vendor_id,
    vendor_error_code,
    evse_id,
    component,
    variable,
    severity,
    tech_code,
    tech_info,
    info,
  } = {}
) {
  db.prepare(
    `INSERT INTO error_events
      (chargepoint_id, ocpp_version, event_type,
       connector_id, status, error_code, vendor_id, vendor_error_code,
       evse_id, component, variable, severity, tech_code, tech_info, info)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    chargepointId,
    ocpp_version,
    eventType,
    connector_id ?? null,
    status ?? null,
    error_code ?? null,
    vendor_id ?? null,
    vendor_error_code ?? null,
    evse_id ?? null,
    component ?? null,
    variable ?? null,
    severity ?? null,
    tech_code ?? null,
    tech_info ?? null,
    info ?? null
  );
}

function getErrorEvents(filters = {}) {
  let query = `SELECT ee.*, cp.identity AS chargepoint_identity, cp.cpname AS chargepoint_name, cp.site_id, s.sname AS site_name
    FROM error_events ee
    LEFT JOIN chargepoints cp ON cp.id = ee.chargepoint_id
    LEFT JOIN sites s ON s.id = cp.site_id
    WHERE 1=1`;
  const params = [];
  if (filters.chargepoint_id) {
    query += ' AND ee.chargepoint_id = ?';
    params.push(filters.chargepoint_id);
  }
  if (filters.event_type) {
    query += ' AND ee.event_type = ?';
    params.push(filters.event_type);
  }
  if (filters.ocpp_version) {
    query += ' AND ee.ocpp_version = ?';
    params.push(filters.ocpp_version);
  }
  if (filters.from) {
    query += ' AND ee.created_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    query += ' AND ee.created_at <= ?';
    params.push(filters.to);
  }
  if (filters.site_id) {
    query += ' AND cp.site_id = ?';
    params.push(filters.site_id);
  }
  if (filters.site_ids && filters.site_ids.length > 0) {
    query += ` AND cp.site_id IN (${filters.site_ids.map(() => '?').join(',')})`;
    params.push(...filters.site_ids);
  }
  if (filters.limit === null) {
    query += ' ORDER BY ee.id DESC';
  } else {
    const limit = Math.min(filters.limit || 100, 500);
    const offset = filters.offset || 0;
    query += ' ORDER BY ee.id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }
  return db.prepare(query).all(...params);
}

function getErrorEventById(id) {
  return db
    .prepare(
      `SELECT ee.*, cp.site_id
     FROM error_events ee
     LEFT JOIN chargepoints cp ON cp.id = ee.chargepoint_id
     WHERE ee.id = ?`
    )
    .get(id);
}

function deleteErrorEvent(id) {
  return db.prepare('DELETE FROM error_events WHERE id = ?').run(id).changes;
}

// ── Notification Log ──
function addNotificationLog(userId, eventType, channel, title, body, success, errorMessage) {
  db.prepare(
    'INSERT INTO notification_log (user_id, event_type, channel, title, body, success, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    userId,
    eventType,
    channel,
    title || null,
    body || null,
    success ? 1 : 0,
    errorMessage || null
  );
}

function getNotificationLog(userId, limit = 50) {
  return db
    .prepare('SELECT * FROM notification_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
}

function clearNotificationLog(userId) {
  db.prepare('DELETE FROM notification_log WHERE user_id = ?').run(userId);
}

// ── Queries for notification targets ──
function getUsersByRole(role) {
  const users = db
    .prepare(
      'SELECT id, useremail, shortname, role, langue, ntif_pushuser, ntif_pushtokn FROM users WHERE role = ?'
    )
    .all(role);
  for (const u of users) {
    u.sites = getUserSites(u.id);
  }
  return users;
}

function getUsersBySiteRole(siteId, siteRole) {
  const rows = db
    .prepare(
      `
    SELECT u.id, u.useremail, u.shortname, u.role, u.langue, u.ntif_pushuser, u.ntif_pushtokn
    FROM users u
    JOIN user_sites us ON us.user_id = u.id
    WHERE us.site_id = ? AND us.role = ?
  `
    )
    .all(siteId, siteRole);
  for (const u of rows) {
    u.sites = getUserSites(u.id);
  }
  return rows;
}

function getAllManagers() {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT u.id, u.useremail, u.shortname, u.role, u.langue, u.ntif_pushuser, u.ntif_pushtokn
    FROM users u
    JOIN user_sites us ON us.user_id = u.id
    WHERE us.role = 'manager'
  `
    )
    .all();
  for (const u of rows) {
    u.sites = getUserSites(u.id);
  }
  return rows;
}

function getAuthorizedUsersBySite(siteId) {
  const rows = db
    .prepare(
      `
    SELECT u.id, u.useremail, u.shortname, u.role, u.langue, u.ntif_pushuser, u.ntif_pushtokn
    FROM users u
    JOIN user_sites us ON us.user_id = u.id
    WHERE us.site_id = ? AND us.authorized = 1
  `
    )
    .all(siteId);
  for (const u of rows) {
    u.sites = getUserSites(u.id);
  }
  return rows;
}

// ── Charging Profiles ──
function createChargingProfile(data) {
  const {
    chargepoint_id,
    profile_id,
    connector_id = 0,
    evse_id = null,
    stack_level = 0,
    profile_purpose,
    profile_kind,
    recurrency_kind = null,
    valid_from = null,
    valid_to = null,
    charging_rate_unit = 'W',
    schedule_json,
    ocpp_version = '1.6',
  } = data;
  const result = db
    .prepare(
      `
    INSERT INTO charging_profiles
      (chargepoint_id, profile_id, connector_id, evse_id, stack_level,
       profile_purpose, profile_kind, recurrency_kind, valid_from, valid_to,
       charging_rate_unit, schedule_json, ocpp_version, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
  `
    )
    .run(
      chargepoint_id,
      profile_id,
      connector_id,
      evse_id,
      stack_level,
      profile_purpose,
      profile_kind,
      recurrency_kind,
      valid_from,
      valid_to,
      charging_rate_unit,
      typeof schedule_json === 'string' ? schedule_json : JSON.stringify(schedule_json),
      ocpp_version
    );
  return result.lastInsertRowid;
}

function getChargingProfiles(chargepointId, filters = {}) {
  const conditions = ['chargepoint_id = ?'];
  const params = [chargepointId];
  if (filters.connector_id !== undefined) {
    conditions.push('connector_id = ?');
    params.push(filters.connector_id);
  }
  if (filters.profile_purpose) {
    conditions.push('profile_purpose = ?');
    params.push(filters.profile_purpose);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  return db
    .prepare(
      `SELECT * FROM charging_profiles WHERE ${conditions.join(' AND ')} ORDER BY stack_level, connector_id`
    )
    .all(...params);
}

function getChargingProfileById(id) {
  return db.prepare('SELECT * FROM charging_profiles WHERE id = ?').get(id);
}

function updateChargingProfileStatus(id, status) {
  db.prepare(
    `UPDATE charging_profiles SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, id);
}

function deleteChargingProfileById(id) {
  db.prepare('DELETE FROM charging_profiles WHERE id = ?').run(id);
}

function clearChargingProfilesByFilter(chargepointId, filters = {}) {
  const conditions = ['chargepoint_id = ?'];
  const params = [chargepointId];
  if (filters.profile_id !== undefined) {
    conditions.push('profile_id = ?');
    params.push(filters.profile_id);
  }
  if (filters.connector_id !== undefined) {
    conditions.push('connector_id = ?');
    params.push(filters.connector_id);
  }
  if (filters.profile_purpose) {
    conditions.push('profile_purpose = ?');
    params.push(filters.profile_purpose);
  }
  if (filters.stack_level !== undefined) {
    conditions.push('stack_level = ?');
    params.push(filters.stack_level);
  }
  db.prepare(`DELETE FROM charging_profiles WHERE ${conditions.join(' AND ')}`).run(...params);
}

function getNextProfileId(chargepointId) {
  const row = db
    .prepare('SELECT MAX(profile_id) AS max_id FROM charging_profiles WHERE chargepoint_id = ?')
    .get(chargepointId);
  return (row?.max_id ?? 0) + 1;
}

// ── Reservations ──
function getNextReservationId(chargepointId) {
  const row = db
    .prepare(
      "SELECT MAX(reservation_id) AS max_id FROM reservations WHERE chargepoint_id = ? AND status NOT IN ('Cancelled','Expired','Fulfilled')"
    )
    .get(chargepointId);
  return (row?.max_id ?? 0) + 1;
}

function createReservation({
  chargepoint_id,
  connector_id = null,
  evse_id = null,
  reservation_id,
  id_tag,
  expiry_date,
  created_by,
}) {
  const result = db
    .prepare(
      'INSERT INTO reservations (chargepoint_id, connector_id, evse_id, reservation_id, id_tag, expiry_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(chargepoint_id, connector_id, evse_id, reservation_id, id_tag, expiry_date, created_by);
  return result.lastInsertRowid;
}

function getReservationsByChargepoint(chargepointId) {
  return db
    .prepare(
      `SELECT r.*, u.shortname AS created_by_name, e.evse_name, cn.connector_name
       FROM reservations r
       LEFT JOIN users u ON r.created_by = u.id
       LEFT JOIN evses e ON e.chargepoint_id = r.chargepoint_id AND e.evse_id = r.evse_id
       LEFT JOIN connectors cn ON cn.chargepoint_id = r.chargepoint_id AND cn.connector_id = r.connector_id AND cn.evse_id IS r.evse_id
       WHERE r.chargepoint_id = ?
       ORDER BY r.created_at DESC`
    )
    .all(chargepointId);
}

function getReservationById(id) {
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
}

function updateReservationStatus(id, status) {
  db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, id);
}

function activateReservationByConnector(chargepointId, connectorId) {
  db.prepare(
    "UPDATE reservations SET status = 'Active' WHERE chargepoint_id = ? AND connector_id = ? AND status = 'Pending'"
  ).run(chargepointId, connectorId);
}

function expireActiveReservationByConnector(chargepointId, connectorId) {
  db.prepare(
    "UPDATE reservations SET status = 'Expired' WHERE chargepoint_id = ? AND connector_id = ? AND status IN ('Pending','Active')"
  ).run(chargepointId, connectorId);
}

function getReservationByOcppId(chargepointId, ocppReservationId) {
  return db
    .prepare('SELECT * FROM reservations WHERE chargepoint_id = ? AND reservation_id = ?')
    .get(chargepointId, ocppReservationId);
}

function startUsingReservationByConnectorAndIdTag(chargepointId, connectorId, idTag) {
  return db
    .prepare(
      "UPDATE reservations SET status = 'InUse' WHERE chargepoint_id = ? AND connector_id = ? AND id_tag = ? AND status = 'Active'"
    )
    .run(chargepointId, connectorId, idTag).changes;
}

function fulfillReservationByConnectorAndIdTag(chargepointId, connectorId, idTag) {
  return db
    .prepare(
      "UPDATE reservations SET status = 'Fulfilled' WHERE chargepoint_id = ? AND connector_id = ? AND id_tag = ? AND status = 'InUse'"
    )
    .run(chargepointId, connectorId, idTag).changes;
}

function fulfillInUseReservationByConnector(chargepointId, connectorId) {
  db.prepare(
    "UPDATE reservations SET status = 'Fulfilled' WHERE chargepoint_id = ? AND connector_id = ? AND status = 'InUse'"
  ).run(chargepointId, connectorId);
}

function activateReservationByEvse(chargepointId, evseId) {
  db.prepare(
    "UPDATE reservations SET status = 'Active' WHERE chargepoint_id = ? AND evse_id = ? AND status = 'Pending'"
  ).run(chargepointId, evseId);
}

function expireActiveReservationByEvse(chargepointId, evseId) {
  db.prepare(
    "UPDATE reservations SET status = 'Expired' WHERE chargepoint_id = ? AND evse_id = ? AND status IN ('Pending','Active')"
  ).run(chargepointId, evseId);
}

function startUsingReservationByEvseAndIdTag(chargepointId, evseId, idTag) {
  return db
    .prepare(
      "UPDATE reservations SET status = 'InUse' WHERE chargepoint_id = ? AND evse_id = ? AND id_tag = ? AND status = 'Active'"
    )
    .run(chargepointId, evseId, idTag).changes;
}

function fulfillInUseReservationByEvse(chargepointId, evseId) {
  db.prepare(
    "UPDATE reservations SET status = 'Fulfilled' WHERE chargepoint_id = ? AND evse_id = ? AND status = 'InUse'"
  ).run(chargepointId, evseId);
}

function fulfillReservationByEvseAndIdTag(chargepointId, evseId, idTag) {
  return db
    .prepare(
      "UPDATE reservations SET status = 'Fulfilled' WHERE chargepoint_id = ? AND evse_id = ? AND id_tag = ? AND status = 'InUse'"
    )
    .run(chargepointId, evseId, idTag).changes;
}

function getExpiredActiveReservations(graceSeconds) {
  return db
    .prepare(
      `SELECT r.*, cp.identity FROM reservations r
       JOIN chargepoints cp ON r.chargepoint_id = cp.id
       WHERE datetime(r.expiry_date) < datetime('now', ?)
       AND r.status IN ('Pending', 'Active')`
    )
    .all(`-${graceSeconds} seconds`);
}

function deleteReservation(id) {
  return db.prepare('DELETE FROM reservations WHERE id = ?').run(id).changes;
}

function resetStateOnStartup() {
  const cpResult = db
    .prepare(
      `UPDATE chargepoints
       SET connected = 0, connected_wss = 0, endpoint_address = NULL, cpstatus = NULL`
    )
    .run();
  // Les transactions actives restent actives : seule la borne termine une transaction. Elle a pu
  // continuer à charger pendant l'arrêt du serveur ; son arrêt réel (mis en file) ou la
  // réconciliation à la reconnexion (StatusNotification Available, GetTransactionStatus) la
  // clôturera. Seules les valeurs instantanées périmées sont effacées ; `energy` est gardé
  // (dernier relevé connu, utilisé par lastKnownMeterStop).
  const txResult = db
    .prepare(`UPDATE transactions SET charging_state = NULL, power = NULL WHERE status = 'Active'`)
    .run();
  const cnResult = db
    .prepare(
      `UPDATE connectors
       SET cnstatus = NULL, cnstatus_raw = NULL, updated_at = datetime('now')`
    )
    .run();
  return {
    chargepoints: cpResult.changes,
    transactions: txResult.changes,
    connectors: cnResult.changes,
  };
}

function resetConnectorsByChargepoint(cpId) {
  db.prepare(
    `UPDATE connectors
     SET cnstatus = NULL, cnstatus_raw = NULL, updated_at = datetime('now')
     WHERE chargepoint_id = ?`
  ).run(cpId);
}

function touchLastHeartbeat(identity) {
  db.prepare(
    "UPDATE chargepoints SET last_heartbeat = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE identity = ?"
  ).run(identity);
}

// ── Admin — infos système ──
const ADMIN_STATS_TABLES = [
  'sites',
  'users',
  'chargepoints',
  'ocpp_messages',
  'transactions',
  'transactions_values',
  'id_tags_events',
  'reservations',
  'error_events',
  'notification_log',
];

function getDbFileSize() {
  const fs = require('fs');
  const suffixes = ['', '-wal', '-shm'];
  return suffixes.reduce((total, suffix) => {
    const filePath = DB_PATH + suffix;
    try {
      return total + fs.statSync(filePath).size;
    } catch {
      return total;
    }
  }, 0);
}

function getSystemStats() {
  const counts = {};
  for (const table of ADMIN_STATS_TABLES) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  const connectedDb = db
    .prepare('SELECT COUNT(*) AS n FROM chargepoints WHERE connected = 1')
    .get().n;
  return {
    counts,
    dbSizeBytes: getDbFileSize(),
    connectedDb,
  };
}

async function backupDatabase(dest) {
  await db.backup(dest);
}

// ── Admin — nettoyage des données ──
// Whitelist fixe : tableName n'est jamais dérivé d'une entrée utilisateur, ce qui rend
// son interpolation directe dans le SQL (impossible à paramétrer pour PRAGMA/nom de table) sûre.
const CLEANUP_TABLES = [
  'transactions_values',
  'ocpp_messages',
  'id_tags_events',
  'error_events',
  'notification_log',
  'reservations',
];

function estimateTableSize(tableName) {
  if (!CLEANUP_TABLES.includes(tableName)) {
    throw new Error('ERR_INVALID_TABLE');
  }
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const textColumns = columns.filter((c) => c.type === 'TEXT').map((c) => c.name);
  if (textColumns.length === 0) return 0;
  const sumExpr = textColumns.map((c) => `COALESCE(LENGTH(${c}), 0)`).join(' + ');
  const row = db.prepare(`SELECT SUM(${sumExpr}) AS bytes FROM ${tableName}`).get();
  return row.bytes || 0;
}

function getCleanupStats() {
  return CLEANUP_TABLES.map((table) => ({
    table,
    count: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    sizeBytes: estimateTableSize(table),
  }));
}

function deleteTransactionValuesBefore(before) {
  return db
    .prepare(
      `DELETE FROM transactions_values WHERE id IN (
         SELECT tv.id FROM transactions_values tv
         JOIN transactions t
           ON t.chargepoint_id = tv.chargepoint_id AND t.transaction_id = tv.transaction_id
         WHERE t.stop_time IS NOT NULL AND t.stop_time < ?
       )`
    )
    .run(before).changes;
}

function deleteIdTagEventsBefore(before) {
  return db.prepare('DELETE FROM id_tags_events WHERE timestamp < ?').run(before).changes;
}

function deleteErrorEventsBefore(before) {
  return db.prepare('DELETE FROM error_events WHERE created_at < ?').run(before).changes;
}

function deleteExpiredReservations(before) {
  if (before) {
    return db
      .prepare(
        `DELETE FROM reservations WHERE status IN ('Fulfilled','Cancelled','Expired') AND expiry_date < ?`
      )
      .run(before).changes;
  }
  return db
    .prepare(`DELETE FROM reservations WHERE status IN ('Fulfilled','Cancelled','Expired')`)
    .run().changes;
}

function deleteNotificationLogBefore(before) {
  return db.prepare('DELETE FROM notification_log WHERE created_at < ?').run(before).changes;
}

function vacuumDatabase() {
  db.exec('VACUUM');
}

module.exports = {
  getDb,
  closeDb,
  getSystemStats,
  backupDatabase,
  estimateTableSize,
  getCleanupStats,
  deleteTransactionValuesBefore,
  deleteIdTagEventsBefore,
  deleteErrorEventsBefore,
  deleteExpiredReservations,
  deleteNotificationLogBefore,
  vacuumDatabase,
  getAllSites,
  getSiteById,
  getSiteTariff,
  replaceSiteTariff,
  finalizeTransactionCost,
  createSite,
  updateSite,
  deleteSite,
  countSiteSessions,
  archiveSite,
  restoreSite,
  getAllUsers,
  getUserById,
  getUserByEmail,
  getUserByGoogleId,
  updateLastLogin,
  updateUserGoogleProfile,
  createUser,
  updateUser,
  deleteUser,
  setUserDisabled,
  isEmailTaken,
  createPasswordReset,
  getUserPasswordResetByToken,
  markUserPasswordResetAsUsed,
  deleteExpiredPasswordResets,
  getUserSites,
  getUserSiteIds,
  getUserManagedSiteIds,
  setUserSites,
  getSiteUsers,
  getSiteUsersWithStats,
  addUserToSite,
  removeUserFromSite,
  setUserSiteAuthorized,
  setUserSiteRole,
  countSiteManagers,
  getSolelyManagedSites,
  getAllChargepoints,
  getChargepointsBySite,
  getChargepointByIdentity,
  getChargepointById,
  upsertChargepoint,
  updateChargepointByIdentity,
  countChargepointSessions,
  countActiveTransactions,
  setChargepointArchived,
  createChargepoint,
  updateChargepoint,
  deleteChargepoint,
  assignChargepointToSite,
  updateChargepointStatus,
  touchLastHeartbeat,
  upsertConnector,
  getConnectorById,
  getConnectorsByChargepoint,
  getConnectorsByChargepoints,
  getConnectorByChargepointAndId,
  getAllConnectorsGrouped,
  updateConnectorFields,
  updateConnectorCnstatus,
  createTransaction,
  stopTransaction,
  updateTransactionChargingState,
  getTransactions,
  getUserTransactions,
  getReimbursementReport,
  getDashboardChartData,
  getTransactionByTransactionId,
  getTransactionById,
  getTransactionFullById,
  correctServerClosedTransaction,
  closeTransactionManually,
  stopRejectedTransaction,
  getActiveTransactionByConnector,
  setTransactionIdTag,
  getTransactionValues,
  updateChargepointMeterValue,
  updateConnectorMeterValue,
  updateEvseMeterValue,
  recalcChargepointMeterValue,
  updateTransactionPowerEnergy,
  upsertTransactionValues,
  addOcppMessage,
  getOcppMessages,
  clearOcppMessages,
  upsertChargepointConfig,
  bulkUpsertChargepointConfig,
  getChargepointConfig,
  getChargepointConfigByKey,
  setChargepointConfigOverride,
  getChargepointOverrideConfigs,
  deleteChargepointConfig,
  getChargepointVariables,
  getInitialChargepointConfig,
  getEnabledInitialChargepointConfig,
  getInitialChargepointConfigByKey,
  createInitialChargepointConfig,
  updateInitialChargepointConfig,
  deleteInitialChargepointConfig,
  getInitialChargepointVariables,
  getEnabledInitialChargepointVariables,
  getInitialChargepointVariableByKey,
  createInitialChargepointVariable,
  updateInitialChargepointVariable,
  deleteInitialChargepointVariable,
  markChargepointInitialized,
  resetChargepointInitialized,
  getAllIdTags,
  getIdTagById,
  getIdTagByTag,
  hasIdTagScopeConflict,
  getIdTagScopeConflictCodes,
  countIdTagSessions,
  getUserScope,
  getUsersWithSites,
  createIdTag,
  updateIdTag,
  deleteIdTag,
  authorizeIdTag,
  getUserStartIdTags,
  addIdTagEvent,
  getIdTagEvents,
  getIdTagEventById,
  deleteIdTagEvent,
  getAvailableConnectorsForUser,
  getChargingKpi,
  getUserDashboardStats,
  getUserTransactionStats,
  getNotificationPreferences,
  setNotificationPreference,
  setNotificationPreferencesBulk,
  getPushSubscriptions,
  savePushSubscription,
  deletePushSubscription,
  deletePushSubscriptionByUser,
  deletePushSubscriptionsByUser,
  addNotificationLog,
  getNotificationLog,
  clearNotificationLog,
  getUsersByRole,
  getUsersBySiteRole,
  getAllManagers,
  getAuthorizedUsersBySite,
  createChargingProfile,
  getChargingProfiles,
  getChargingProfileById,
  updateChargingProfileStatus,
  deleteChargingProfileById,
  clearChargingProfilesByFilter,
  getNextProfileId,
  getNextReservationId,
  createReservation,
  getReservationsByChargepoint,
  getReservationById,
  updateReservationStatus,
  activateReservationByConnector,
  expireActiveReservationByConnector,
  getReservationByOcppId,
  startUsingReservationByConnectorAndIdTag,
  fulfillReservationByConnectorAndIdTag,
  fulfillInUseReservationByConnector,
  activateReservationByEvse,
  expireActiveReservationByEvse,
  startUsingReservationByEvseAndIdTag,
  fulfillInUseReservationByEvse,
  fulfillReservationByEvseAndIdTag,
  getExpiredActiveReservations,
  deleteReservation,
  resetStateOnStartup,
  resetConnectorsByChargepoint,
  insertErrorEvent,
  getErrorEvents,
  getErrorEventById,
  deleteErrorEvent,
  upsertEvse,
  getEvsesByChargepoint,
  updateEvseName,
  upsertChargepointVariable,
  getChargepointVariableByKey,
  setChargepointVariableOverride,
  getChargepointOverrideVariables,
  updateChargepointFeatures201,
};
