-- Variables initiales OCPP 2.0.1 conformes au Device Model :
--  - certaines variables n'existent qu'avec une instance : OCPPCommCtrlr.MessageTimeout (Default),
--    OCPPCommCtrlr.MessageAttempts / MessageAttemptInterval (TransactionEvent). Envoyées sans
--    instance, la borne répond UnknownVariable (ou règle une autre variable) → colonne `instance`
--    (vide = pas d'instance) transmise dans SetVariables ;
--  - ReservationCtrlr.ReservationTimeOut n'existe pas dans le Device Model 2.0.1 → supprimée ;
--  - ClockCtrlr.TimeOffset attend un décalage RFC 3339 (« +00:00 »), pas « UTC+0 ».

CREATE TABLE chargepoint_init_variables_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  component   TEXT NOT NULL,
  variable    TEXT NOT NULL,
  attribute   TEXT NOT NULL DEFAULT 'Actual',
  instance    TEXT NOT NULL DEFAULT '',
  value       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (component, variable, attribute, instance)
);
INSERT INTO chargepoint_init_variables_new
  (id, component, variable, attribute, value, enabled, created_at, updated_at)
  SELECT id, component, variable, attribute, value, enabled, created_at, updated_at
  FROM chargepoint_init_variables;
DROP TABLE chargepoint_init_variables;
ALTER TABLE chargepoint_init_variables_new RENAME TO chargepoint_init_variables;

UPDATE chargepoint_init_variables SET instance = 'Default'
  WHERE component = 'OCPPCommCtrlr' AND variable = 'MessageTimeout' AND instance = '';
UPDATE chargepoint_init_variables SET instance = 'TransactionEvent'
  WHERE component = 'OCPPCommCtrlr' AND variable IN ('MessageAttempts', 'MessageAttemptInterval')
    AND instance = '';
DELETE FROM chargepoint_init_variables
  WHERE component = 'ReservationCtrlr' AND variable = 'ReservationTimeOut';
UPDATE chargepoint_init_variables SET value = '+00:00'
  WHERE component = 'ClockCtrlr' AND variable = 'TimeOffset' AND value = 'UTC+0';
