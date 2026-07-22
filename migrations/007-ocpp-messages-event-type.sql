CREATE TABLE ocpp_messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('chargepoint','csms','system')),
  message_type TEXT NOT NULL CHECK(message_type IN ('CALL','CALLRESULT','CALLERROR','EVENT')),
  action TEXT,
  payload TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE
);
INSERT INTO ocpp_messages_new SELECT * FROM ocpp_messages;
DROP TABLE ocpp_messages;
ALTER TABLE ocpp_messages_new RENAME TO ocpp_messages;
CREATE INDEX IF NOT EXISTS idx_ocpp_messages_cp_ts ON ocpp_messages(chargepoint_id, timestamp);
