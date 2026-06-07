CREATE TABLE chargepoints_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT(45) UNIQUE NOT NULL,
  cpname TEXT(75),
  password TEXT,
  mode INTEGER(1) DEFAULT 1 CHECK(mode IN (1,2,3)),
  authorized INTEGER(1) DEFAULT 1 CHECK(authorized IN (0,1)),
  ocpp_version TEXT DEFAULT NULL,   -- NULL = version inconnue
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
INSERT INTO chargepoints_new SELECT * FROM chargepoints;
-- Mettre NULL pour les bornes qui ne se sont jamais connectées
UPDATE chargepoints_new SET ocpp_version = NULL WHERE connected = 0;
DROP TABLE chargepoints;
ALTER TABLE chargepoints_new RENAME TO chargepoints;
