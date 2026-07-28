CREATE TABLE chargepoint_variables_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL,
  component      TEXT NOT NULL,
  variable       TEXT NOT NULL,
  attribute      TEXT NOT NULL DEFAULT 'Actual',  -- Actual | Target | MinSet | MaxSet
  instance       TEXT NOT NULL DEFAULT '',
  evse_id        INTEGER NOT NULL DEFAULT 0,
  connector_id   INTEGER NOT NULL DEFAULT 0,
  value          TEXT,
  readonly       INTEGER DEFAULT 0,
  is_override    INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE,
  UNIQUE (chargepoint_id, component, variable, attribute, instance, evse_id, connector_id)
);
INSERT INTO chargepoint_variables_new
  (id, chargepoint_id, component, variable, attribute, value, readonly, is_override, updated_at)
  SELECT id, chargepoint_id, component, variable, attribute, value, readonly, is_override, updated_at
  FROM chargepoint_variables;
DROP TABLE chargepoint_variables;
ALTER TABLE chargepoint_variables_new RENAME TO chargepoint_variables;
