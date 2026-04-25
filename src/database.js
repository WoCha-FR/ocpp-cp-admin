const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const { getConfig, getConfigDir } = require('./config');
const { runMigrations } = require('./migrator');

const config = getConfig();
const DB_PATH = path.resolve(getConfigDir(), config.dbname);

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
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
    ORDER BY cp.identity
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
  updates.push("last_heartbeat = datetime('now')");
  values.push(identity);
  db.prepare(`UPDATE chargepoints SET ${updates.join(', ')} WHERE identity = ?`).run(...values);
  return getChargepointByIdentity(identity);
}

// ── Connectors ──
function upsertConnector(chargepointId, connectorId, status, errorCode, info, vendorId, vendorEC) {
  // Le connecteur 0 représente la borne elle-même, ses données sont stockées dans la table chargepoints
  if (connectorId === 0) return null;
  const existing = db
    .prepare('SELECT * FROM connectors WHERE chargepoint_id = ? AND connector_id = ?')
    .get(chargepointId, connectorId);
  if (existing) {
    db.prepare(
      `UPDATE connectors SET cnstatus = ?, error_code = ?, info = ?, vendor_id = ?, vendor_error_code = ?, updated_at = datetime('now')
      WHERE chargepoint_id = ? AND connector_id = ?`
    ).run(
      status,
      errorCode || 'NoError',
      info || null,
      vendorId || null,
      vendorEC || null,
      chargepointId,
      connectorId
    );
  } else {
    db.prepare(
      'INSERT INTO connectors (chargepoint_id, connector_id, cnstatus, error_code, info, vendor_id, vendor_error_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      chargepointId,
      connectorId,
      status,
      errorCode || 'NoError',
      info || null,
      vendorId || null,
      vendorEC || null
    );
  }
  return db
    .prepare('SELECT * FROM connectors WHERE chargepoint_id = ? AND connector_id = ?')
    .get(chargepointId, connectorId);
}

function getConnectorById(connectorId) {
  return db
    .prepare(
      'SELECT c.*, cp.identity as chargepoint_identity, cp.site_id as site_id FROM connectors c JOIN chargepoints cp ON c.chargepoint_id = cp.id WHERE c.id = ?'
    )
    .get(connectorId);
}

function getConnectorByChargepointAndId(chargepointId, connectorId) {
  return db
    .prepare('SELECT * FROM connectors WHERE chargepoint_id = ? AND connector_id = ?')
    .get(chargepointId, connectorId);
}

function getConnectorsByChargepoint(chargepointId) {
  return db
    .prepare(
      'SELECT * FROM connectors WHERE chargepoint_id = ? AND connector_id > 0 ORDER BY connector_id'
    )
    .all(chargepointId);
}

function updateConnectorFields(connectorId, data) {
  const existing = db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
  if (!existing) throw new Error('ERR_CONNECTOR_NOT_FOUND');
  db.prepare(
    `UPDATE connectors SET connector_name = ?, connector_power = ?, connector_type = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    data.connector_name ?? existing.connector_name,
    data.connector_power ?? existing.connector_power,
    data.connector_type ?? existing.connector_type,
    connectorId
  );
  return db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
}

function getAllConnectorsGrouped(siteIds) {
  let query = `
    SELECT c.*, cp.identity as chargepoint_identity, cp.id as chargepoint_id,
           cp.cpname as chargepoint_name, cp.connected, cp.cpstatus as cp_status,
           cp.mode,
           s.sname as site_name, s.id as site_id,
           t.transaction_id as active_transaction_id, t.id_tag as active_id_tag,
           t.power as active_power, t.energy as active_energy
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
function createTransaction(chargepointId, connectorId, idTag, meterStart, startTime, startSource) {
  return db.transaction(() => {
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
      SELECT COALESCE(MAX(transaction_id), ?) + 1 AS next_id
      FROM transactions
      WHERE transaction_id BETWEEN ? AND ?
    `
      )
      .get(base, base, base + 9999);
    const transactionId = row.next_id;

    const source = startSource || 'rfid';
    const info = db
      .prepare(
        `INSERT INTO transactions
      (chargepoint_id, connector_id, transaction_id, id_tag, meter_start, start_time, status, start_source)
      VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)`
      )
      .run(chargepointId, connectorId, transactionId, idTag, meterStart, startTime, source);
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
  })();
}

function stopTransaction(transactionId, meterStop, stopTime, reason) {
  db.prepare(
    `UPDATE transactions SET meter_stop = ?, stop_time = ?, stop_reason = ?, status = 'Completed'
    WHERE transaction_id = ? AND status = 'Active'`
  ).run(meterStop, stopTime, reason || 'Local', transactionId);
  return db
    .prepare('SELECT * FROM transactions WHERE transaction_id = ? ORDER BY id DESC')
    .get(transactionId);
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

  // Énergie par jour (kWh)
  const energyPerDay = db
    .prepare(
      `
    SELECT date(t.start_time) as day,
      ROUND(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 2) as energy_kwh,
      COUNT(*) as tx_count
    FROM transactions t
    JOIN chargepoints cp ON t.chargepoint_id = cp.id
    WHERE t.status = 'Completed'
      AND t.start_time >= date('now', '-' || ${days} || ' days')${siteFilter}
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

  const period = db
    .prepare(
      `
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 0), 2) as totalEnergy,
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
    WHERE t.status = 'Completed'
      AND t.start_time >= date('now', '-' || ${days} || ' days')${siteFilter}
  `
    )
    .get(...params);

  const allTime = db
    .prepare(
      `
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN t.meter_stop IS NOT NULL AND t.meter_start IS NOT NULL
        THEN (t.meter_stop - t.meter_start) / 1000.0 ELSE 0 END), 0), 2) as totalEnergy,
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
    WHERE t.status = 'Completed'${siteFilter}
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
    CASE WHEN tv.id IS NOT NULL THEN 1 ELSE 0 END as has_values
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
    LEFT JOIN transactions_values tv ON t.transaction_id = tv.transaction_id`;

function buildTransactionQuery(baseCondition, baseParams, filters) {
  let query = TRANSACTIONS_BASE_QUERY + ' WHERE ' + baseCondition;
  const params = [...baseParams];
  if (filters.chargepoint_id) {
    query += ' AND t.chargepoint_id = ?';
    params.push(filters.chargepoint_id);
  }
  if (filters.site_ids && filters.site_ids.length > 0) {
    query += ` AND cp.site_id IN (${filters.site_ids.map(() => '?').join(',')})`;
    params.push(...filters.site_ids);
  } else if (filters.site_id) {
    query += ' AND cp.site_id = ?';
    params.push(filters.site_id);
  }
  if (filters.status) {
    query += ' AND t.status = ?';
    params.push(filters.status);
  }
  if (filters.from) {
    query += ' AND t.start_time >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    query += ' AND t.start_time <= ?';
    params.push(filters.to);
  }
  query += ` ORDER BY t.id DESC`;
  return db.prepare(query).all(...params);
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

function updateConnectorMeterValue(chargepointId, connectorId, meterValue) {
  db.prepare(
    `UPDATE connectors SET meter_value = ?, updated_at = datetime('now')
    WHERE chargepoint_id = ? AND connector_id = ?`
  ).run(meterValue, chargepointId, connectorId);
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
  params.push(transactionId);
  db.prepare(
    `UPDATE transactions SET ${updates.join(', ')} WHERE transaction_id = ? AND status = 'Active'`
  ).run(...params);
}

function getTransactionByTransactionId(transactionId) {
  return db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId);
}

function getTransactionValues(transactionId) {
  return db
    .prepare('SELECT * FROM transactions_values WHERE transaction_id = ?')
    .get(transactionId);
}

// ── Transactions Values ──
function upsertTransactionValues(transactionId, { energieEntry, courantEntry, socEntry } = {}) {
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
    if (updates.length > 0) {
      params.push(transactionId);
      db.prepare(
        `UPDATE transactions_values SET ${updates.join(', ')} WHERE transaction_id = ?`
      ).run(...params);
    }
  } else {
    db.prepare(
      'INSERT INTO transactions_values (transaction_id, energie, courant, soc) VALUES (?, ?, ?, ?)'
    ).run(
      transactionId,
      energieEntry ? JSON.stringify([energieEntry]) : null,
      courantEntry ? JSON.stringify([courantEntry]) : null,
      socEntry ? JSON.stringify([socEntry]) : null
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
  if (filters.action) {
    query += ' AND om.action = ?';
    params.push(filters.action);
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

function deleteChargepointConfig(chargepointId, key) {
  db.prepare('DELETE FROM chargepoint_config WHERE chargepoint_id = ? AND key = ?').run(
    chargepointId,
    key
  );
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

function createIdTag(idTag, userId, siteId, description, expiryDate) {
  const info = db
    .prepare(
      'INSERT INTO id_tags (id_tag, user_id, site_id, description, expiry_date) VALUES (?, ?, ?, ?, ?)'
    )
    .run(idTag, userId || null, siteId || null, description || null, expiryDate || null);
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
  db.prepare(
    'UPDATE id_tags SET id_tag = ?, user_id = ?, site_id = ?, active = ?, description = ?, expiry_date = ? WHERE id = ?'
  ).run(idTag, userId || null, siteId || null, active, description || null, expiryDate || null, id);
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
      filterWhere += ' AND t.start_time >= ?';
      filterParams.push(filters.from);
    }
    if (filters.to) {
      filterWhere += ' AND t.start_time <= ?';
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

function authorizeIdTag(idTag, siteId) {
  const tag = getIdTagByTag(idTag, siteId);
  if (!tag) {
    return { status: 'Invalid', reason: 'unknown_tag', tag: null };
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
    query += ' AND ite.id_tag = ?';
    params.push(filters.id_tag);
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

function deletePushSubscriptionsByUser(userId) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
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
  upsertConnector,
  getConnectorById,
  getConnectorsByChargepoint,
  getConnectorByChargepointAndId,
  getAllConnectorsGrouped,
  updateConnectorFields,
  createTransaction,
  stopTransaction,
  getTransactions,
  getUserTransactions,
  getDashboardChartData,
  getTransactionByTransactionId,
  getTransactionValues,
  updateChargepointMeterValue,
  updateConnectorMeterValue,
  updateTransactionPowerEnergy,
  upsertTransactionValues,
  addOcppMessage,
  getOcppMessages,
  clearOcppMessages,
  upsertChargepointConfig,
  bulkUpsertChargepointConfig,
  getChargepointConfig,
  getChargepointConfigByKey,
  deleteChargepointConfig,
  getInitialChargepointConfig,
  getEnabledInitialChargepointConfig,
  getInitialChargepointConfigByKey,
  createInitialChargepointConfig,
  updateInitialChargepointConfig,
  deleteInitialChargepointConfig,
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
  deletePushSubscriptionsByUser,
  addNotificationLog,
  getNotificationLog,
  clearNotificationLog,
  getUsersByRole,
  getUsersBySiteRole,
  getAllManagers,
  getAuthorizedUsersBySite,
};
