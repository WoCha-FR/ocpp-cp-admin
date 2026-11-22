'use strict';

const { parseSampledValues, toBase } = require('../../src/meterSamples');

const E = 'Energy.Active.Import.Register';

describe('meterSamples — toBase', () => {
  it('kWh / kW → Wh / W', () => {
    expect(toBase(1.5, 'kWh', 0)).toBe(1500);
    expect(toBase(2, 'kW', 0)).toBe(2000);
  });
  it('multiplier = exposant de 10 (2.0.1)', () => {
    expect(toBase(12.5, 'Wh', 3)).toBe(12500);
    expect(toBase(7400, 'W', -1)).toBe(740);
  });
  it('multiplier et préfixe k se cumulent', () => {
    expect(toBase(2, 'kWh', 1)).toBe(20000);
  });
  it('unité inconnue / vide : valeur inchangée', () => {
    expect(toBase(42, '', 0)).toBe(42);
    expect(toBase(42, undefined, undefined)).toBe(42);
  });
});

describe('meterSamples — parseSampledValues', () => {
  it('tout à null sans échantillon', () => {
    const r = parseSampledValues([]);
    expect(Object.values(r).every((v) => v === null)).toBe(true);
    expect(parseSampledValues(undefined).energyWh).toBeNull();
  });

  it('measurand absent = Energy.Active.Import.Register', () => {
    expect(parseSampledValues([{ value: '4200' }]).energyWh).toBe(4200);
  });

  it('énergie 1.6 (unit) et 2.0.1 (unitOfMeasure)', () => {
    expect(parseSampledValues([{ measurand: E, value: '1.5', unit: 'kWh' }]).energyWh).toBe(1500);
    expect(
      parseSampledValues([{ measurand: E, value: '1.5', unitOfMeasure: { unit: 'kWh' } }]).energyWh
    ).toBe(1500);
    expect(
      parseSampledValues([
        { measurand: E, value: '12.5', unitOfMeasure: { unit: 'Wh', multiplier: 3 } },
      ]).energyWh
    ).toBe(12500);
  });

  it('ignore les valeurs non numériques', () => {
    expect(parseSampledValues([{ measurand: E, value: 'abc' }, { measurand: E, value: '10' }]).energyWh).toBe(10);
    expect(parseSampledValues([{ measurand: E, value: 'abc' }]).energyWh).toBeNull();
  });

  describe('mesures par phase', () => {
    const P = 'Power.Active.Import';
    it('la valeur totale (sans phase) prime sur les phases, quel que soit l\'ordre', () => {
      expect(
        parseSampledValues([
          { measurand: P, value: '100', phase: 'L1' },
          { measurand: P, value: '7000' },
          { measurand: P, value: '100', phase: 'L2' },
        ]).powerW
      ).toBe(7000);
      expect(
        parseSampledValues([
          { measurand: P, value: '7000' },
          { measurand: P, value: '100', phase: 'L1' },
        ]).powerW
      ).toBe(7000);
    });
    it('sans total : somme des phases', () => {
      expect(
        parseSampledValues([
          { measurand: P, value: '2.4', unit: 'kW', phase: 'L1' },
          { measurand: P, value: '2.4', unit: 'kW', phase: 'L2' },
          { measurand: P, value: '2.4', unit: 'kW', phase: 'L3' },
        ]).powerW
      ).toBe(7200);
    });
    it('Power.Offered suit la même règle', () => {
      expect(
        parseSampledValues([
          { measurand: 'Power.Offered', value: '11', unit: 'kW' },
          { measurand: 'Power.Offered', value: '4', unit: 'kW', phase: 'L1' },
        ]).powerOffered
      ).toBe(11000);
    });
  });

  describe('tensions', () => {
    const V = 'Voltage';
    it('sans phase → L1', () => {
      expect(parseSampledValues([{ measurand: V, value: '231' }]).voltageL1).toBe(231);
    });
    it('phase-neutre L1-N / L2-N / L3-N et L1 / L2 / L3', () => {
      const r = parseSampledValues([
        { measurand: V, value: '230', phase: 'L1-N' },
        { measurand: V, value: '231', phase: 'L2' },
        { measurand: V, value: '232', phase: 'L3-N' },
      ]);
      expect([r.voltageL1, r.voltageL2, r.voltageL3]).toEqual([230, 231, 232]);
    });
    it('phase-à-phase (L1-L2, L2-L3, L3-L1) et N : ignorées', () => {
      const r = parseSampledValues([
        { measurand: V, value: '398', phase: 'L1-L2' },
        { measurand: V, value: '399', phase: 'L2-L3' },
        { measurand: V, value: '397', phase: 'L3-L1' },
        { measurand: V, value: '1', phase: 'N' },
      ]);
      expect([r.voltageL1, r.voltageL2, r.voltageL3]).toEqual([null, null, null]);
    });
  });

  describe('courants', () => {
    it('Current.Import par phase (sans phase → L1, N ignoré)', () => {
      const r = parseSampledValues([
        { measurand: 'Current.Import', value: '16' },
        { measurand: 'Current.Import', value: '14', phase: 'L2' },
        { measurand: 'Current.Import', value: '15', phase: 'L3' },
        { measurand: 'Current.Import', value: '1', phase: 'N' },
      ]);
      expect([r.currentL1, r.currentL2, r.currentL3]).toEqual([16, 14, 15]);
    });
    it('Current.Offered : valeur sans phase prioritaire, sinon la première phase', () => {
      expect(
        parseSampledValues([
          { measurand: 'Current.Offered', value: '10', phase: 'L1' },
          { measurand: 'Current.Offered', value: '32' },
        ]).currentOffered
      ).toBe(32);
      expect(
        parseSampledValues([
          { measurand: 'Current.Offered', value: '10', phase: 'L1' },
          { measurand: 'Current.Offered', value: '11', phase: 'L2' },
        ]).currentOffered
      ).toBe(10);
    });
  });

  it('SoC, fréquence', () => {
    const r = parseSampledValues([
      { measurand: 'SoC', value: '80' },
      { measurand: 'Frequency', value: '50.01' },
    ]);
    expect(r.socValue).toBe(80);
    expect(r.freqValue).toBe(50.01);
  });

  it('température ramenée en °C (Celsius, Fahrenheit, Kelvin)', () => {
    const t = (value, unit) => parseSampledValues([{ measurand: 'Temperature', value, unit }]).tempValue;
    expect(t('25', 'Celsius')).toBe(25);
    expect(t('77', 'Fahrenheit')).toBeCloseTo(25, 5);
    expect(t('298.15', 'K')).toBeCloseTo(25, 5);
  });
});
