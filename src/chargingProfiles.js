'use strict';

// ── Construction des profils de charge OCPP (SetChargingProfile / ClearChargingProfile) ──
// Module pur : la même logique sert à la création, à la copie et au « tout renvoyer »,
// pour OCPP 1.6 et 2.0.1.
//
// Rappels de la spec appliqués ici :
//  - ChargePointMaxProfile (1.6) / ChargingStationMaxProfile (2.0.1) : connecteur / EVSE 0 uniquement ;
//  - recurrencyKind n'existe que pour un profil Recurring (et y est requis) ;
//  - startSchedule ancre un profil Absolute ou Recurring ; il n'a pas de sens pour un profil
//    Relative (qui démarre avec la transaction) ;
//  - les dates sont des date-time complets (ISO 8601).

const MAX_PROFILE_PURPOSES = ['ChargePointMaxProfile', 'ChargingStationMaxProfile'];

// Vocabulaire interne = 1.6 (ChargePointMaxProfile) ; 2.0.1 le renomme ChargingStationMaxProfile
function mapPurpose(version, purpose) {
  if (!purpose) return purpose;
  if (version === '2.0.1')
    return purpose === 'ChargePointMaxProfile' ? 'ChargingStationMaxProfile' : purpose;
  return purpose === 'ChargingStationMaxProfile' ? 'ChargePointMaxProfile' : purpose;
}

// Date-time ISO 8601 complet (UTC, sans millisecondes) ; valeur inchangée si illisible
function toIsoDateTime(value) {
  if (value == null || value === '') return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Valide et complète une demande de création de profil.
 * @returns {{ error: string } | { value: object }}  error = clé d'erreur i18n
 */
function normalizeProfileInput(body, now = new Date()) {
  const purpose = body.profile_purpose;
  const kind = body.profile_kind;
  const connectorId = body.connector_id ?? 0;

  if (MAX_PROFILE_PURPOSES.includes(purpose) && Number(connectorId) !== 0) {
    return { error: 'VALIDATION_MAX_PROFILE_CONNECTOR' };
  }
  if (kind === 'Recurring' && !body.recurrency_kind) {
    return { error: 'VALIDATION_RECURRENCY_KIND' };
  }

  const validFrom = body.valid_from ? toIsoDateTime(body.valid_from) : null;
  const validTo = body.valid_to ? toIsoDateTime(body.valid_to) : null;

  // Ancrage du calendrier : explicite, sinon Absolute = début de validité (ou maintenant),
  // Recurring = minuit UTC du jour (les startPeriod sont alors des secondes depuis 00:00 UTC).
  let startSchedule = null;
  if (kind === 'Absolute' || kind === 'Recurring') {
    if (body.start_schedule) startSchedule = toIsoDateTime(body.start_schedule);
    else if (kind === 'Absolute') startSchedule = validFrom || toIsoDateTime(now);
    else startSchedule = toIsoDateTime(startOfUtcDay(now));
  }

  const schedule = {
    chargingRateUnit: body.charging_rate_unit || 'W',
    chargingSchedulePeriod: (body.schedule_periods || []).map((p) => {
      const period = { startPeriod: p.startPeriod, limit: p.limit };
      if (p.numberPhases != null) period.numberPhases = p.numberPhases;
      return period;
    }),
  };
  if (startSchedule) schedule.startSchedule = startSchedule;

  return {
    value: {
      connector_id: connectorId,
      stack_level: body.stack_level ?? 0,
      profile_purpose: purpose,
      profile_kind: kind,
      recurrency_kind: kind === 'Recurring' ? body.recurrency_kind : null,
      valid_from: validFrom,
      valid_to: validTo,
      charging_rate_unit: schedule.chargingRateUnit,
      schedule,
    },
  };
}

/**
 * Paramètres d'un SetChargingProfile à partir d'un profil (ligne BDD ou saisie normalisée).
 * @param {string} version  '1.6' | '2.0.1'
 * @param {object} p        { profile_id, connector_id, evse_id?, stack_level, profile_purpose,
 *                            profile_kind, recurrency_kind, valid_from, valid_to, schedule }
 */
function buildSetChargingProfileParams(version, p) {
  const common = {
    stackLevel: p.stack_level,
    chargingProfilePurpose: mapPurpose(version, p.profile_purpose),
    chargingProfileKind: p.profile_kind,
  };
  // Un profil Relative démarre avec la transaction : pas de startSchedule
  const schedule = { ...(p.schedule || {}) };
  if (p.profile_kind === 'Relative') delete schedule.startSchedule;

  const optional = {};
  if (p.profile_kind === 'Recurring' && p.recurrency_kind)
    optional.recurrencyKind = p.recurrency_kind;
  if (p.valid_from) optional.validFrom = p.valid_from;
  if (p.valid_to) optional.validTo = p.valid_to;

  if (version === '2.0.1') {
    return {
      evseId: p.evse_id ?? p.connector_id ?? 0,
      chargingProfile: {
        id: p.profile_id,
        ...common,
        chargingSchedule: [{ id: 1, ...schedule }],
        ...optional,
      },
    };
  }
  return {
    connectorId: p.connector_id ?? 0,
    csChargingProfiles: {
      chargingProfileId: p.profile_id,
      ...common,
      chargingSchedule: schedule,
      ...optional,
    },
  };
}

module.exports = {
  mapPurpose,
  toIsoDateTime,
  normalizeProfileInput,
  buildSetChargingProfileParams,
};
