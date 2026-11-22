'use strict';

// ── Lecture des SampledValue OCPP (MeterValues 1.6 / meterValue 2.0.1) ──
// Module pur, partagé par les deux serveurs OCPP : une seule logique pour les unités, les
// phases et le measurand par défaut.
//
// Règles de la spec appliquées ici :
//  - `measurand` absent = Energy.Active.Import.Register (défaut 1.6 et 2.0.1) ;
//  - 2.0.1 : unitOfMeasure.{unit (défaut Wh), multiplier (exposant de 10, défaut 0)} ;
//  - une mesure avec `phase` n'est PAS la valeur totale : une puissance par phase ne doit pas
//    écraser la puissance totale, une tension phase-à-phase (L1-L2…) n'est pas la tension L1.

const ENERGY = 'Energy.Active.Import.Register';

// Valeur ramenée à l'unité de base (Wh / W) : multiplier 2.0.1, puis préfixe « k » de l'unité
function toBase(value, unit, multiplier) {
  let v = multiplier ? value * 10 ** multiplier : value;
  if (unit === 'kWh' || unit === 'kW') v *= 1000;
  return v;
}

// 1.6 SampledValue.format : Raw (défaut) | SignedData. En 2.0.1, la valeur signée est dans un
// champ séparé (signedMeterValue) et `value` reste toujours un nombre.
function isSignedData(sv) {
  return sv?.format === 'SignedData';
}

function toCelsius(value, unit) {
  if (unit === 'Fahrenheit') return ((value - 32) * 5) / 9;
  if (unit === 'K') return value - 273.15;
  return value;
}

// Accumulateur « total prioritaire, sinon somme des phases »
function makeSum() {
  return { total: null, phases: null };
}
function addSum(acc, value, phase) {
  if (!phase) acc.total = value;
  else acc.phases = (acc.phases ?? 0) + value;
}
const sumResult = (acc) => acc.total ?? acc.phases;

/**
 * @param {object[]} samples  SampledValue[] (1.6 : `unit` ; 2.0.1 : `unitOfMeasure`)
 * @returns {{powerW, energyWh, powerOffered, socValue, currentOffered, currentL1, currentL2,
 *   currentL3, tempValue, voltageL1, voltageL2, voltageL3, freqValue}} null si absent
 */
function parseSampledValues(samples = []) {
  const energy = makeSum();
  const power = makeSum();
  const offered = makeSum();
  const r = {
    socValue: null,
    currentOffered: null,
    currentL1: null,
    currentL2: null,
    currentL3: null,
    tempValue: null,
    voltageL1: null,
    voltageL2: null,
    voltageL3: null,
    freqValue: null,
  };

  for (const sv of samples || []) {
    // 1.6 : format SignedData = valeur signée (blob encodé), pas un nombre. parseFloat en
    // extrairait un préfixe numérique aberrant (ex. « 3A4F… » → 3) pris pour l'énergie.
    if (isSignedData(sv)) continue;
    const raw = parseFloat(sv.value);
    if (isNaN(raw)) continue;
    const measurand = sv.measurand || ENERGY;
    const phase = sv.phase || null;
    // 2.0.1 : unitOfMeasure ; 1.6 : unit
    const unit = sv.unitOfMeasure?.unit ?? sv.unit ?? '';
    const multiplier = sv.unitOfMeasure?.multiplier ?? 0;
    // 2.0.1 : le multiplier (exposant de 10) s'applique à toutes les mesures, pas seulement à
    // l'énergie et à la puissance (ex. tension 2300 × 10^-1 = 230 V)
    const val = multiplier ? raw * 10 ** multiplier : raw;

    switch (measurand) {
      case ENERGY:
        addSum(energy, toBase(val, unit, 0), phase);
        break;
      case 'Power.Active.Import':
        addSum(power, toBase(val, unit, 0), phase);
        break;
      case 'Power.Offered':
        addSum(offered, toBase(val, unit, 0), phase);
        break;
      case 'SoC':
        r.socValue = val;
        break;
      case 'Current.Offered':
        // valeur sans phase prioritaire (sinon la première phase rencontrée)
        if (!phase || r.currentOffered === null) r.currentOffered = val;
        break;
      case 'Current.Import':
        if (!phase || phase === 'L1') r.currentL1 = val;
        else if (phase === 'L2') r.currentL2 = val;
        else if (phase === 'L3') r.currentL3 = val;
        break;
      case 'Temperature':
        r.tempValue = toCelsius(val, unit);
        break;
      case 'Voltage':
        // Seules les tensions phase-neutre alimentent L1/L2/L3 ; L1-L2, L2-L3, L3-L1 et N sont ignorées
        if (!phase || phase === 'L1' || phase === 'L1-N') r.voltageL1 = val;
        else if (phase === 'L2' || phase === 'L2-N') r.voltageL2 = val;
        else if (phase === 'L3' || phase === 'L3-N') r.voltageL3 = val;
        break;
      case 'Frequency':
        r.freqValue = val;
        break;
    }
  }
  return {
    powerW: sumResult(power),
    energyWh: sumResult(energy),
    powerOffered: sumResult(offered),
    ...r,
  };
}

module.exports = { parseSampledValues, toBase, isSignedData };
