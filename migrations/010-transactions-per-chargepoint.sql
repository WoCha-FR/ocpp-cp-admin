-- Transactions identifiées par (borne, transaction_id) au lieu de transaction_id seul.
-- En OCPP 2.0.1 le transactionId est généré par la borne : il n'est unique que pour elle.
-- Avec l'ancienne contrainte globale, deux bornes produisant le même identifiant se
-- marchaient dessus (Started pris pour une retransmission, Ended clôturant la transaction
-- d'une autre borne).
--
-- Ajout de closed_by : station (arrêt envoyé par la borne) | server (clôture heuristique du
-- serveur, que l'arrêt réel de la borne peut encore corriger). Les transactions antérieures
-- restent à NULL (origine inconnue : jamais corrigées).

CREATE TABLE transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT(36),
  chargepoint_id INTEGER NOT NULL,
  evse_id INTEGER,
  connector_id INTEGER NOT NULL,
  charging_state TEXT,
  id_tag TEXT,
  id_token_type TEXT,
  start_source TEXT DEFAULT 'rfid' CHECK(start_source IN ('rfid', 'web', 'local', 'remote')),
  meter_start INTEGER,
  meter_stop INTEGER,
  start_time TEXT,
  stop_time TEXT,
  stop_reason TEXT,
  status TEXT DEFAULT 'Active',
  power INTEGER,
  energy INTEGER,
  cost REAL,
  cost_currency TEXT,
  cost_details TEXT,
  closed_by TEXT CHECK (closed_by IN ('station', 'server')),
  UNIQUE (chargepoint_id, transaction_id),
  FOREIGN KEY (chargepoint_id) REFERENCES chargepoints(id) ON DELETE CASCADE
);
INSERT INTO transactions_new
  (id, transaction_id, chargepoint_id, evse_id, connector_id, charging_state, id_tag,
   id_token_type, start_source, meter_start, meter_stop, start_time, stop_time, stop_reason,
   status, power, energy, cost, cost_currency, cost_details)
  SELECT id, transaction_id, chargepoint_id, evse_id, connector_id, charging_state, id_tag,
   id_token_type, start_source, meter_start, meter_stop, start_time, stop_time, stop_reason,
   status, power, energy, cost, cost_currency, cost_details
  FROM transactions;

CREATE TABLE transactions_values_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargepoint_id INTEGER NOT NULL,
  transaction_id TEXT(36) NOT NULL,
  energie TEXT,
  courant TEXT,
  soc TEXT,
  temperature TEXT,
  tension TEXT,
  frequence TEXT,
  UNIQUE (chargepoint_id, transaction_id),
  FOREIGN KEY (chargepoint_id, transaction_id)
    REFERENCES transactions(chargepoint_id, transaction_id) ON DELETE CASCADE
);
-- Les relevés sans transaction correspondante (orphelins) sont abandonnés
INSERT INTO transactions_values_new
  (id, chargepoint_id, transaction_id, energie, courant, soc, temperature, tension, frequence)
  SELECT tv.id, t.chargepoint_id, tv.transaction_id, tv.energie, tv.courant, tv.soc,
   tv.temperature, tv.tension, tv.frequence
  FROM transactions_values tv
  JOIN transactions t ON t.transaction_id = tv.transaction_id;

DROP TABLE transactions_values;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
ALTER TABLE transactions_values_new RENAME TO transactions_values;
CREATE INDEX IF NOT EXISTS idx_transactions_cp_status ON transactions(chargepoint_id, status);
