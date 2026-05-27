CREATE TABLE IF NOT EXISTS error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL REFERENCES chargepoints(id),
  ocpp_version TEXT NOT NULL DEFAULT '1.6',
  event_type TEXT NOT NULL,
  -- OCPP 1.6 (StatusNotification)
  connector_id INTEGER,
  status TEXT,
  error_code TEXT,
  vendor_id TEXT,
  vendor_error_code TEXT,
  -- OCPP 2.0.1 (StatusNotification EVSE + NotifyEvent)
  evse_id INTEGER,
  component TEXT,
  variable TEXT,
  severity INTEGER,
  tech_code TEXT,
  tech_info TEXT,
  info TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_events_cp_ts ON error_events(chargepoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_ts ON error_events(created_at DESC);
