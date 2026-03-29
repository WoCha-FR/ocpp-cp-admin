-- Migration 001: Schéma initial
-- Création de toutes les tables de base

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sname TEXT(75) UNIQUE NOT NULL,
  address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  useremail TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  shortname TEXT,
  langue TEXT DEFAULT 'fr',
  auth_gglid TEXT UNIQUE,
  ntif_pushuser TEXT DEFAULT NULL,
  ntif_pushtokn TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS user_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('manager', 'user') ),
  authorized INTEGER(1) DEFAULT 1 CHECK (authorized IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now') ),
  FOREIGN KEY (user_id)
  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id)
  REFERENCES sites(id) ON DELETE CASCADE,
  UNIQUE (user_id,site_id)
);

CREATE TABLE IF NOT EXISTS users_password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER(1) DEFAULT 0 CHECK (used IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chargepoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT(45) UNIQUE NOT NULL,
  cpname TEXT(75),
  password TEXT,
  mode INTEGER(1) DEFAULT 1 CHECK(mode IN (1,2,3)),
  authorized INTEGER(1) DEFAULT 1 CHECK(authorized IN (0,1)),
  vendor TEXT(25),
  model TEXT(20),
  serial_number TEXT(25),
  firmware_version TEXT(50),
  iccid TEXT(20),
  imsi TEXT(20),
  meter_sn TEXT(25),
  meter_type TEXT(25),
  meter_value INTEGER DEFAULT 0,
  site_id INTEGER,
  cpstatus TEXT DEFAULT 'Unavailable',
  last_heartbeat TEXT,
  error_code TEXT DEFAULT 'NoError',
  error_info TEXT,
  vendor_id TEXT,
  vendor_error_code TEXT,
  connected INTEGER DEFAULT 0,
  connected_wss INTEGER DEFAULT 0,
  endpoint_address TEXT,
  feat_trigger INTEGER DEFAULT 0,
  feat_firmware INTEGER DEFAULT 0,
  feat_local_list INTEGER DEFAULT 0,
  feat_reservation INTEGER DEFAULT 0,
  feat_smartcharging INTEGER DEFAULT 0,
  has_connector0 INTEGER DEFAULT 0,
  initialized INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  connector_name TEXT,
  cnstatus TEXT DEFAULT 'Available',
  error_code TEXT DEFAULT 'NoError',
  info TEXT,
  vendor_id TEXT,
  vendor_error_code TEXT,
  meter_value INTEGER,
  connector_power INTEGER,
  connector_type TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE,
  UNIQUE(chargepoint_id, connector_id)
);

CREATE TABLE IF NOT EXISTS chargepoint_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  readonly INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  is_override INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE,
  UNIQUE(chargepoint_id, key)
);

CREATE TABLE IF NOT EXISTS chargepoint_init_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  enabled INTEGER DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER UNIQUE,
  chargepoint_id INTEGER NOT NULL,
  connector_id INTEGER NOT NULL,
  id_tag TEXT,
  start_source TEXT DEFAULT 'rfid' CHECK(start_source IN ('rfid', 'web', 'local', 'remote')),
  meter_start INTEGER,
  meter_stop INTEGER,
  start_time TEXT,
  stop_time TEXT,
  stop_reason TEXT,
  status TEXT DEFAULT 'Active',
  power INTEGER,
  energy INTEGER,
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  energie TEXT,
  courant TEXT,
  soc TEXT,
  FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ocpp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('chargepoint','csms')),
  message_type TEXT NOT NULL CHECK(message_type IN ('CALL','CALLRESULT','CALLERROR')),
  action TEXT,
  payload TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS id_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_tag TEXT (20) NOT NULL,
  user_id INTEGER,
  site_id INTEGER,
  active INTEGER (1) DEFAULT 1 CHECK (active IN (0, 1)),
  expiry_date TEXT,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS id_tags_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL,
  connector_id INTEGER,
  id_tag TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  source TEXT DEFAULT 'authorize',
  timestamp TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  enabled INTEGER(1) DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, event_type, channel)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT,
  body TEXT,
  success INTEGER(1) DEFAULT 1,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_token ON users_password_resets(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_id_tag_site ON id_tags(id_tag, COALESCE(site_id, 0));
CREATE INDEX IF NOT EXISTS idx_auth_events_cp ON id_tags_events(chargepoint_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_auth_events_tag ON id_tags_events(id_tag);
CREATE INDEX IF NOT EXISTS idx_notif_prefs_user ON notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_user ON notification_log(user_id, created_at);

INSERT OR IGNORE INTO users (useremail, password, role, shortname) VALUES ('admin@admin.com', '$2b$10$OHSdpl41Wv4kFwtYqfmyRu2rjEzi1QI3n6W33S1gn1PVn5Ue4mTTG', 'admin', 'Admin');
INSERT OR IGNORE INTO chargepoint_init_config (key, value, enabled) VALUES
  ('HeartbeatInterval', '3600', 0),
  ('WebSocketPingInterval', '60', 0),
  ('ConnectionTimeOut', '60', 0),
  ('StopTransactionOnEVSideDisconnect', 'true', 0),
  ('UnlockConnectorOnEVSideDisconnect', 'true', 0),
  ('StopTransactionOnInvalidId', 'true', 0),
  ('TransactionMessageAttempts', '3', 0),
  ('TransactionMessageRetryInterval', '60', 0),
  ('MeterValueSampleInterval', '60', 0),
  ('MeterValuesSampledData', 'Energy.Active.Import.Register,Power.Active.Import', 0),
  ('ClockAlignedDataInterval', '0', 0),
  ('LocalPreAuthorize', 'true', 0),
  ('AllowOfflineTxForUnknownId', 'false', 0),
  ('MinimumStatusDuration', '0', 0),
  ('ResetRetries', '3', 0),
  ('LocalAuthListEnabled', 'false', 0);
