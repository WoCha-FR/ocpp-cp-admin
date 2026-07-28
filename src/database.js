const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const { getConfig, getConfigDir } = require('./config');
const { runMigrations, initNewDatabase } = require('./migrator');

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

function createSite(name, address) {
  const info = db
    .prepare('INSERT INTO sites (sname, address) VALUES (?, ?)')
    .run(name, address || null);
  return getSiteById(info.lastInsertRowid);
}

function updateSite(id, name, address) {
  db.prepare('UPDATE sites SET sname = ?, address = ? WHERE id = ?').run(name, address || null, id);
  return getSiteById(id);
}

function deleteSite(id) {
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
}

// ── Users ──
function getAllUsers() {
  const users = db
    .prepare(
      `
    SELECT u.id, u.useremail, u.shortname, u.role, u.created_at, u.last_login
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
    SELECT u.id, u.useremail, u.shortname, u.role, u.langue, u.created_at, u.ntif_pushuser, u.ntif_pushtokn
    FROM users u WHERE u.id = ?
  `
    )
    .get(id);
  if (user) {
    user.sites = getUserSites(user.id);
  }
  return user;
}

function getUserByEmail(useremail) {
  return db.prepare('SELECT * FROM users WHERE useremail = ?').get(useremail);
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

function deleteUser(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM user_sites WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
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
    SELECT u.id, u.useremail, u.shortname, u.role as global_role, us.role as site_role, us.authorized, us.created_at as linked_at
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
      SELECT it.user_id,
        COUNT(*) as charges_month,
        ROUND(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
          THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 2) as energy_month_kwh,
        MAX(t.start_time) as last_charge
      FROM transactions t
      JOIN chargepoints cp ON t.chargepoint_id = cp.id
      LEFT JOIN id_tags it ON it.id = (
        SELECT it2.id FROM id_tags it2
        JOIN chargepoints cp2 ON cp2.id = t.chargepoint_id
        WHERE it2.id_tag = t.id_tag
        ORDER BY CASE WHEN it2.site_id = cp2.site_id THEN 0 WHEN it2.site_id IS NULL THEN 1 ELSE 2 END
        LIMIT 1
      )
      WHERE cp.site_id = ?
        AND t.status = 'Completed'
        AND t.start_time >= date('now', 'start of month')
      GROUP BY it.user_id
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
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    WHERE cp.site_id = ?
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

function countSiteManagers(siteId) {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM user_sites WHERE site_id = ? AND role = ?')
    .get(siteId, 'manager');
  return row ? row.cnt : 0;
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

function deleteChargepoint(id) {
  db.prepare('DELETE FROM chargepoints WHERE id = ?').run(id);
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
    WHERE c.connector_id > 0
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
  } = {}
) {
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
    const info = db
      .prepare(
        `INSERT INTO transactions
      (chargepoint_id, connector_id, transaction_id, id_tag, meter_start, start_time, status, start_source, evse_id, charging_state, id_token_type)
      VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?)`
      )
      .run(
        chargepointId,
        connectorId,
        transactionId,
        idTag,
        meterStart,
        startTime,
        source,
        evse_id,
        charging_state,
        id_token_type
      );
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
  })();
}

function stopTransaction(transactionId, meterStop, stopTime, reason) {
  transactionId = String(transactionId);
  db.prepare(
    `UPDATE transactions SET meter_stop = ?, stop_time = ?, stop_reason = ?, status = 'Completed',
    charging_state = NULL
    WHERE transaction_id = ? AND status = 'Active'`
  ).run(meterStop, stopTime, reason || 'Local', transactionId);
  return db
    .prepare('SELECT * FROM transactions WHERE transaction_id = ? ORDER BY id DESC')
    .get(transactionId);
}

function updateTransactionChargingState(transactionId, chargingState) {
  db.prepare(
    `UPDATE transactions SET charging_state = ? WHERE transaction_id = ? AND status = 'Active'`
  ).run(chargingState, String(transactionId));
}

function getDashboardChartData(siteIds = null, days = 30) {
  const params = [];
  let siteFilter = '';
  if (siteIds !== null && siteIds.length > 0) {
    siteFilter = ` AND cp.site_id IN (${siteIds.map(() => '?').join(',')})`;
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
    siteFilter = ` AND cp.site_id IN (${siteIds.map(() => '?').join(',')})`;
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
      WHERE t.start_time >= date('now', '-' || ${days} || ' days')${siteFilter}
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
        WHERE 1=1${siteFilter}
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

// Base commune des requêtes transactions
const TRANSACTIONS_BASE_QUERY = `SELECT t.*, cp.identity as chargepoint_identity, cp.cpname as chargepoint_name,
    s.sname as site_name,
    it.user_id as tag_user_id, COALESCE(u.shortname, u.useremail) as tag_username,
    CASE WHEN tv.id IS NOT NULL THEN 1 ELSE 0 END as has_values,
    cn.connector_name as connector_name,
    ev.evse_name as evse_name
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    LEFT JOIN sites s ON cp.site_id = s.id
    LEFT JOIN id_tags it ON it.id = (
      SELECT it2.id FROM id_tags it2
      JOIN chargepoints cp2 ON cp2.id = t.chargepoint_id
      WHERE it2.id_tag = t.id_tag
      ORDER BY CASE WHEN it2.site_id = cp2.site_id THEN 0 WHEN it2.site_id IS NULL THEN 1 ELSE 2 END
      LIMIT 1
    )
    LEFT JOIN users u ON it.user_id = u.id
    LEFT JOIN transactions_values tv ON t.transaction_id = tv.transaction_id
    LEFT JOIN connectors cn ON cn.chargepoint_id = t.chargepoint_id AND cn.connector_id = t.connector_id AND cn.evse_id IS t.evse_id
    LEFT JOIN evses ev ON ev.chargepoint_id = t.chargepoint_id AND ev.evse_id = t.evse_id`;

function buildTransactionQuery(baseCondition, baseParams, filters) {
  let whereClause = ' WHERE ' + baseCondition;
  const params = [...baseParams];
  if (filters.chargepoint_id) {
    whereClause += ' AND t.chargepoint_id = ?';
    params.push(filters.chargepoint_id);
  }
  if (filters.site_ids && filters.site_ids.length > 0) {
    whereClause += ` AND cp.site_id IN (${filters.site_ids.map(() => '?').join(',')})`;
    params.push(...filters.site_ids);
  } else if (filters.site_id) {
    whereClause += ' AND cp.site_id = ?';
    params.push(filters.site_id);
  }
  if (filters.status) {
    whereClause += ' AND t.status = ?';
    params.push(filters.status);
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
  const ID_TAG_SUBQUERY = `(SELECT it2.id FROM id_tags it2
      JOIN chargepoints cp2 ON cp2.id = t.chargepoint_id
      WHERE it2.id_tag = t.id_tag
      ORDER BY CASE WHEN it2.site_id = cp2.site_id THEN 0 WHEN it2.site_id IS NULL THEN 1 ELSE 2 END
      LIMIT 1)`;
  const countQuery =
    `SELECT
    COUNT(*) as total,
    COALESCE(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
      THEN t.meter_stop - t.meter_start ELSE 0 END), 0) as totalEnergy,
    COUNT(CASE WHEN t.status = 'Active' THEN 1 END) as activeCount,
    COALESCE(SUM(CASE WHEN t.start_time IS NOT NULL AND t.stop_time IS NOT NULL
      THEN (julianday(t.stop_time) - julianday(t.start_time)) * 1440 ELSE 0 END), 0) as totalMinutes
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    LEFT JOIN id_tags it ON it.id = ${ID_TAG_SUBQUERY}` + whereClause;

  const countResult = db.prepare(countQuery).get(...params);

  const rows = db
    .prepare(TRANSACTIONS_BASE_QUERY + whereClause + ' ORDER BY t.id DESC LIMIT ? OFFSET ?')
    .all(...params, filters.limit, filters.offset ?? 0)
    .map((row) => ({ ...row }));

  return {
    data: rows,
    total: countResult.total,
    stats: {
      totalEnergy: countResult.totalEnergy,
      activeCount: countResult.activeCount,
      totalMinutes: countResult.totalMinutes,
    },
  };
}

function getTransactions(filters = {}) {
  return buildTransactionQuery('1=1', [], filters);
}

function getUserTransactions(userId, filters = {}) {
  return buildTransactionQuery('it.user_id = ?', [userId], filters);
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

function updateTransactionPowerEnergy(transactionId, power, energyWh) {
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
  params.push(String(transactionId));
  db.prepare(
    `UPDATE transactions SET ${updates.join(', ')} WHERE transaction_id = ? AND status = 'Active'`
  ).run(...params);
}

function getTransactionByTransactionId(transactionId) {
  return db
    .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
    .get(String(transactionId));
}

function getTransactionFull(transactionId) {
  return db
    .prepare(`${TRANSACTIONS_BASE_QUERY} WHERE t.transaction_id = ?`)
    .get(String(transactionId));
}

function getActiveTransactionByConnector(chargepointId, connectorId) {
  return db
    .prepare(
      `SELECT * FROM transactions WHERE chargepoint_id = ? AND connector_id = ? AND status = 'Active' ORDER BY id DESC LIMIT 1`
    )
    .get(chargepointId, connectorId);
}

function getTransactionValues(transactionId) {
  return db
    .prepare('SELECT * FROM transactions_values WHERE transaction_id = ?')
    .get(String(transactionId));
}

// ── Transactions Values ──
function upsertTransactionValues(
  transactionId,
  { energieEntry, courantEntry, socEntry, tempEntry, tensionEntry, freqEntry } = {}
) {
  transactionId = String(transactionId);
  const existing = db
    .prepare('SELECT * FROM transactions_values WHERE transaction_id = ?')
    .get(transactionId);
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
      params.push(transactionId);
      db.prepare(
        `UPDATE transactions_values SET ${updates.join(', ')} WHERE transaction_id = ?`
      ).run(...params);
    }
  } else {
    db.prepare(
      'INSERT INTO transactions_values (transaction_id, energie, courant, soc, temperature, tension, frequence) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
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

function clearOcppMessages(chargepointId) {
  if (chargepointId) {
    db.prepare('DELETE FROM ocpp_messages WHERE chargepoint_id = ?').run(chargepointId);
  } else {
    db.prepare('DELETE FROM ocpp_messages').run();
  }
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

function getChargepointVariableByKey(chargepointId, component, variable, attribute = 'Actual') {
  return db
    .prepare(
      'SELECT * FROM chargepoint_variables WHERE chargepoint_id = ? AND component = ? AND variable = ? AND attribute = ?'
    )
    .get(chargepointId, component, variable, attribute);
}

function setChargepointVariableOverride(chargepointId, component, variable, attribute, isOverride) {
  db.prepare(
    "UPDATE chargepoint_variables SET is_override = ?, updated_at = datetime('now') WHERE chargepoint_id = ? AND component = ? AND variable = ? AND attribute = ?"
  ).run(isOverride ? 1 : 0, chargepointId, component, variable, attribute);
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
    .prepare('SELECT * FROM chargepoint_init_variables ORDER BY component, variable, attribute')
    .all();
}

function getEnabledInitialChargepointVariables() {
  return db
    .prepare(
      'SELECT * FROM chargepoint_init_variables WHERE enabled = 1 ORDER BY component, variable, attribute'
    )
    .all();
}

function getInitialChargepointVariableByKey(component, variable) {
  return db
    .prepare(
      "SELECT * FROM chargepoint_init_variables WHERE component = ? AND variable = ? AND attribute = 'Actual' LIMIT 1"
    )
    .get(component, variable);
}

function createInitialChargepointVariable(component, variable, attribute, value, enabled) {
  return db
    .prepare(
      'INSERT INTO chargepoint_init_variables (component, variable, attribute, value, enabled) VALUES (?, ?, ?, ?, ?)'
    )
    .run(component, variable, attribute || 'Actual', value, enabled ? 1 : 0);
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

function createIdTag(
  idTag,
  userId,
  siteId,
  description,
  expiryDate,
  active = 1,
  token_type = 'ISO14443',
  group_id_token = null
) {
  const info = db
    .prepare(
      'INSERT INTO id_tags (id_tag, user_id, site_id, description, expiry_date, active, token_type, group_id_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      idTag,
      userId || null,
      siteId || null,
      description || null,
      expiryDate || null,
      active ? 1 : 0,
      token_type,
      group_id_token || null
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
  db.prepare(
    'UPDATE id_tags SET id_tag = ?, user_id = ?, site_id = ?, active = ?, description = ?, expiry_date = ?, token_type = ?, group_id_token = ? WHERE id = ?'
  ).run(
    idTag,
    userId || null,
    siteId || null,
    active,
    description || null,
    expiryDate || null,
    tokenType,
    groupIdToken || null,
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
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    LEFT JOIN id_tags it ON it.id = (
      SELECT it2.id FROM id_tags it2
      JOIN chargepoints cp2 ON cp2.id = t.chargepoint_id
      WHERE it2.id_tag = t.id_tag
      ORDER BY CASE WHEN it2.site_id = cp2.site_id THEN 0 WHEN it2.site_id IS NULL THEN 1 ELSE 2 END
      LIMIT 1
    )
    WHERE it.user_id = ?
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
  const hasFilters = filters.from || filters.to || filters.status;
  const idTagJoin = `LEFT JOIN id_tags it ON it.id = (
    SELECT it2.id FROM id_tags it2
    JOIN chargepoints cp2 ON cp2.id = t.chargepoint_id
    WHERE it2.id_tag = t.id_tag
    ORDER BY CASE WHEN it2.site_id = cp2.site_id THEN 0 WHEN it2.site_id IS NULL THEN 1 ELSE 2 END
    LIMIT 1
  )`;

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
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    ${idTagJoin}
    WHERE it.user_id = ? AND t.status = 'Completed'${extraWhere}`;

  // Mois en cours
  const currentMonth = db
    .prepare(buildQuery(` AND t.start_time >= date('now', 'start of month')`))
    .get(userId);

  // Mois précédent
  const prevMonth = db
    .prepare(
      buildQuery(
        ` AND t.start_time >= date('now', 'start of month', '-1 month') AND t.start_time < date('now', 'start of month')`
      )
    )
    .get(userId);

  // All-time
  const allTime = db.prepare(buildQuery('')).get(userId);

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
    filtered = db.prepare(buildQuery(filterWhere)).get(...filterParams);
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
           it.user_id as active_user_id
    FROM connectors c
    JOIN chargepoints cp ON c.chargepoint_id = cp.id
    JOIN sites s ON cp.site_id = s.id
    JOIN user_sites us ON us.site_id = s.id AND us.user_id = ?
    LEFT JOIN transactions t ON t.chargepoint_id = cp.id AND t.connector_id = c.connector_id AND t.status = 'Active'
    LEFT JOIN id_tags it ON it.id = (
      SELECT it2.id FROM id_tags it2
      JOIN chargepoints cp2 ON cp2.id = t.chargepoint_id
      WHERE it2.id_tag = t.id_tag
      ORDER BY CASE WHEN it2.site_id = cp2.site_id THEN 0 WHEN it2.site_id IS NULL THEN 1 ELSE 2 END
      LIMIT 1
    )
    WHERE c.connector_id > 0
    ORDER BY s.sname, cp.identity, c.connector_id
  `
    )
    .all(userId);
}

function authorizeIdTag(idTag, siteId, tokenType) {
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
  if (tag.site_id && siteId && tag.site_id !== siteId) {
    return { status: 'Blocked', reason: 'wrong_site', tag };
  }
  // Vérifier l'autorisation utilisateur sur le site
  // Un admin/manager peut configurer les bornes sans être autorisé à les utiliser
  if (tag.user_id && siteId) {
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
  const txResult = db
    .prepare(
      `UPDATE transactions
       SET status = 'Completed',
           stop_time = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
           stop_reason = 'Other',
           charging_state = NULL,
           power = NULL,
           meter_stop = CASE
                          WHEN energy IS NOT NULL AND meter_start IS NOT NULL
                          THEN meter_start + energy
                          ELSE meter_stop
                        END,
           energy = NULL
       WHERE status = 'Active'`
    )
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

module.exports = {
  getDb,
  closeDb,
  getAllSites,
  getSiteById,
  createSite,
  updateSite,
  deleteSite,
  getAllUsers,
  getUserById,
  getUserByEmail,
  getUserByGoogleId,
  updateLastLogin,
  updateUserGoogleProfile,
  createUser,
  updateUser,
  deleteUser,
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
  getAllChargepoints,
  getChargepointsBySite,
  getChargepointByIdentity,
  getChargepointById,
  upsertChargepoint,
  createChargepoint,
  updateChargepoint,
  deleteChargepoint,
  assignChargepointToSite,
  updateChargepointStatus,
  touchLastHeartbeat,
  upsertConnector,
  getConnectorById,
  getConnectorsByChargepoint,
  getConnectorByChargepointAndId,
  getAllConnectorsGrouped,
  updateConnectorFields,
  updateConnectorCnstatus,
  createTransaction,
  stopTransaction,
  updateTransactionChargingState,
  getTransactions,
  getUserTransactions,
  getDashboardChartData,
  getTransactionByTransactionId,
  getTransactionFull,
  getActiveTransactionByConnector,
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
  createIdTag,
  updateIdTag,
  deleteIdTag,
  authorizeIdTag,
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
