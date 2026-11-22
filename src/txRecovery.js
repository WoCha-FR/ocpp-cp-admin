'use strict';

// ── Aides pures pour la clôture/réconciliation des transactions OCPP ──
// Module sans dépendance applicative (ni base, ni logger) : partagé par ocpp-common,
// ocpp-server-16 et ocpp-server-201, facile à tester isolément.

// Dernier relevé de compteur connu d'une transaction active : meter_start + énergie cumulée
// par les MeterValues. Utilisé quand le serveur doit clore lui-même une transaction (borne
// déconnectée, transaction orpheline) : meter_stop = meter_start donnerait 0 kWh facturé.
const { toBase, isSignedData } = require('./meterSamples');

function lastKnownMeterStop(tx) {
  if (!tx) return 0;
  const start = tx.meter_start;
  if (start != null && tx.energy > 0) return start + tx.energy;
  return start ?? 0;
}

// Un transactionId « réel » : en 1.6, une StartTransaction refusée renvoie transactionId 0
// (la borne enverra quand même un StopTransaction avec cet identifiant si
// StopTransactionOnInvalidId=true) ; il ne correspond à aucune transaction.
function isRealTransactionId(txId) {
  if (txId == null) return false;
  const s = String(txId).trim();
  return s !== '' && s !== '0';
}

// Transaction à clore quand un arrêt arrive avec un transactionId inconnu (ex. base restaurée).
// On ne devine que s'il n'y a AUCUNE ambiguïté : une seule transaction active compatible.
// `evseId` (2.0.1) écarte les transactions d'un autre EVSE ; sans information, on ne
// retient que le cas d'une unique transaction active sur la borne.
function pickRecoveryCandidate(activeTxs, { evseId = null } = {}) {
  const candidates = (activeTxs || []).filter(
    (tx) => evseId == null || tx.evse_id == null || tx.evse_id === evseId
  );
  return candidates.length === 1 ? candidates[0] : null;
}

// Intervalle de heartbeat renvoyé à la borne (BootNotificationResponse.interval, entier requis) :
// une valeur de configuration absente ou non numérique ne doit pas produire NaN (→ réponse invalide)
function parseHeartbeatInterval(value, fallback = 300) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// ── OCPP 2.0.1 : raison d'arrêt ──
// La raison d'arrêt est portée par transactionInfo.stoppedReason (ReasonEnumType), PAS par
// triggerReason (qui décrit l'événement déclencheur). stoppedReason peut être omis quand
// la raison est « Local ».
const STOPPED_REASONS_201 = new Set([
  'DeAuthorized',
  'EmergencyStop',
  'EnergyLimitReached',
  'EVDisconnected',
  'GroundFault',
  'ImmediateReset',
  'Local',
  'LocalOutOfCredit',
  'MasterPass',
  'Other',
  'OvercurrentFault',
  'PowerLoss',
  'PowerQuality',
  'Reboot',
  'Remote',
  'SOCLimitReached',
  'StoppedByEV',
  'TimeLimitReached',
  'Timeout',
]);

// Repli quand stoppedReason est absent : déduction depuis triggerReason (TriggerReasonEnumType)
const TRIGGER_TO_STOP_REASON_201 = {
  RemoteStop: 'Remote',
  StopAuthorized: 'Local',
  Deauthorized: 'DeAuthorized',
  EVDeparted: 'EVDisconnected',
  EnergyLimitReached: 'EnergyLimitReached',
  TimeLimitReached: 'TimeLimitReached',
  EVCommunicationLost: 'Other',
  AbnormalCondition: 'Other',
  ResetCommand: 'Reboot',
};

// Vocabulaire déjà affiché par l'UI (badges) : on y ramène les valeurs équivalentes
const STOP_REASON_UI_ALIAS = { ImmediateReset: 'HardReset' };

function resolveStopReason201(transactionInfo, triggerReason) {
  const stopped = transactionInfo?.stoppedReason;
  let reason;
  if (stopped && STOPPED_REASONS_201.has(stopped)) reason = stopped;
  else reason = TRIGGER_TO_STOP_REASON_201[triggerReason] || 'Local';
  return STOP_REASON_UI_ALIAS[reason] || reason;
}

// ── OCPP 2.0.1 : relevé de compteur dans un meterValue[] ──
// mode 'first' (démarrage) : premier Energy.Active.Import.Register, de préférence
//   context Transaction.Begin. mode 'last' (arrêt) : de préférence context Transaction.End,
//   sinon le dernier échantillon (l'ordre du tableau est chronologique) — jamais le
//   Transaction.Begin que contient aussi un TransactionEvent Ended.
function extractMeterEnergy(meterValue = [], mode = 'first') {
  const samples = [];
  for (const mv of meterValue) {
    for (const sv of mv.sampledValue || []) {
      if (isSignedData(sv)) continue;
      if ((sv.measurand || 'Energy.Active.Import.Register') !== 'Energy.Active.Import.Register') {
        continue;
      }
      const v = parseFloat(sv.value);
      if (isNaN(v)) continue;
      // unité (défaut Wh) et multiplier (exposant de 10) de unitOfMeasure
      const unit = sv.unitOfMeasure?.unit || '';
      const multiplier = sv.unitOfMeasure?.multiplier ?? 0;
      samples.push({ wh: toBase(v, unit, multiplier), context: sv.context || null });
    }
  }
  if (samples.length === 0) return null;
  const preferred = mode === 'last' ? 'Transaction.End' : 'Transaction.Begin';
  const match = samples.find((s) => s.context === preferred);
  if (match) return match.wh;
  return mode === 'last' ? samples[samples.length - 1].wh : samples[0].wh;
}

module.exports = {
  lastKnownMeterStop,
  isRealTransactionId,
  parseHeartbeatInterval,
  pickRecoveryCandidate,
  resolveStopReason201,
  extractMeterEnergy,
};
