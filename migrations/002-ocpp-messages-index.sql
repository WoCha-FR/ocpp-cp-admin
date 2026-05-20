CREATE INDEX IF NOT EXISTS idx_ocpp_messages_cp_ts
  ON ocpp_messages(chargepoint_id, timestamp);
