'use strict';

const {
  lastKnownMeterStop,
  isRealTransactionId,
  pickRecoveryCandidate,
  resolveStopReason201,
  extractMeterEnergy,
  parseHeartbeatInterval,
} = require('../../src/txRecovery');

describe('txRecovery — lastKnownMeterStop', () => {
  it('meter_start + énergie cumulée', () => {
    expect(lastKnownMeterStop({ meter_start: 1000, energy: 2500 })).toBe(3500);
  });
  it('sans énergie : meter_start', () => {
    expect(lastKnownMeterStop({ meter_start: 1000, energy: 0 })).toBe(1000);
    expect(lastKnownMeterStop({ meter_start: 1000, energy: null })).toBe(1000);
  });
  it('sans meter_start : 0 (jamais null → énergie perdue)', () => {
    expect(lastKnownMeterStop({ energy: 400 })).toBe(0);
    expect(lastKnownMeterStop({})).toBe(0);
    expect(lastKnownMeterStop(null)).toBe(0);
  });
});

describe('txRecovery — isRealTransactionId', () => {
  it.each([0, '0', '', '  ', null, undefined])('%p n\'est pas un identifiant réel', (v) => {
    expect(isRealTransactionId(v)).toBe(false);
  });
  it.each([1, '261470005', 'TX-ABC'])('%p est un identifiant réel', (v) => {
    expect(isRealTransactionId(v)).toBe(true);
  });
});

describe('txRecovery — pickRecoveryCandidate', () => {
  const tx = (id, evse) => ({ transaction_id: id, evse_id: evse });

  it('aucune transaction active → null', () => {
    expect(pickRecoveryCandidate([])).toBeNull();
    expect(pickRecoveryCandidate(null)).toBeNull();
  });
  it('une seule transaction active → elle', () => {
    expect(pickRecoveryCandidate([tx('A', null)]).transaction_id).toBe('A');
  });
  it('plusieurs transactions actives sans EVSE → null (ambigu)', () => {
    expect(pickRecoveryCandidate([tx('A', 1), tx('B', 2)])).toBeNull();
  });
  it('EVSE connu : ne retient que celle de cet EVSE', () => {
    expect(pickRecoveryCandidate([tx('A', 1), tx('B', 2)], { evseId: 2 }).transaction_id).toBe('B');
  });
  it('EVSE connu mais la seule transaction est sur un autre EVSE → null', () => {
    expect(pickRecoveryCandidate([tx('A', 1)], { evseId: 2 })).toBeNull();
  });
  it('transaction sans evse_id (1.6) reste candidate', () => {
    expect(pickRecoveryCandidate([tx('A', null)], { evseId: 2 }).transaction_id).toBe('A');
  });
});

describe('txRecovery — resolveStopReason201', () => {
  it('stoppedReason valide prioritaire', () => {
    expect(resolveStopReason201({ stoppedReason: 'EVDisconnected' }, 'StopAuthorized')).toBe(
      'EVDisconnected'
    );
  });
  it('stoppedReason hors énumération ignoré (repli sur triggerReason)', () => {
    expect(resolveStopReason201({ stoppedReason: 'N-importe-quoi' }, 'RemoteStop')).toBe('Remote');
  });
  it('ImmediateReset ramené au vocabulaire UI (HardReset)', () => {
    expect(resolveStopReason201({ stoppedReason: 'ImmediateReset' }, 'ResetCommand')).toBe(
      'HardReset'
    );
  });
  it.each([
    ['StopAuthorized', 'Local'],
    ['RemoteStop', 'Remote'],
    ['Deauthorized', 'DeAuthorized'],
    ['EVDeparted', 'EVDisconnected'],
    ['EnergyLimitReached', 'EnergyLimitReached'],
    ['TimeLimitReached', 'TimeLimitReached'],
    ['EVCommunicationLost', 'Other'],
    ['AbnormalCondition', 'Other'],
    ['ResetCommand', 'Reboot'],
  ])('repli triggerReason %s → %s', (trigger, expected) => {
    expect(resolveStopReason201({}, trigger)).toBe(expected);
  });
  it('rien d\'exploitable → Local (valeur par défaut de la spec)', () => {
    expect(resolveStopReason201(undefined, undefined)).toBe('Local');
    expect(resolveStopReason201({}, 'MeterValuePeriodic')).toBe('Local');
  });
});

describe('txRecovery — extractMeterEnergy', () => {
  const sv = (value, extra = {}) => ({
    measurand: 'Energy.Active.Import.Register',
    value: String(value),
    ...extra,
  });

  it('aucune énergie → null', () => {
    expect(extractMeterEnergy([])).toBeNull();
    expect(extractMeterEnergy([{ sampledValue: [{ measurand: 'Voltage', value: '230' }] }])).toBeNull();
  });
  it('mode first : Transaction.Begin de préférence', () => {
    const mv = [{ sampledValue: [sv(900)] }, { sampledValue: [sv(1000, { context: 'Transaction.Begin' })] }];
    expect(extractMeterEnergy(mv, 'first')).toBe(1000);
  });
  it('mode first : à défaut, le premier échantillon', () => {
    expect(extractMeterEnergy([{ sampledValue: [sv(900)] }, { sampledValue: [sv(1500)] }], 'first')).toBe(900);
  });
  it('mode last : Transaction.End de préférence (même si ce n\'est pas le dernier)', () => {
    const mv = [
      { sampledValue: [sv(1000, { context: 'Transaction.Begin' })] },
      { sampledValue: [sv(5500, { context: 'Transaction.End' })] },
      { sampledValue: [sv(5400, { context: 'Sample.Periodic' })] },
    ];
    expect(extractMeterEnergy(mv, 'last')).toBe(5500);
  });
  it('mode last : à défaut, le dernier échantillon (jamais le Begin)', () => {
    const mv = [
      { sampledValue: [sv(1000, { context: 'Transaction.Begin' })] },
      { sampledValue: [sv(3000, { context: 'Sample.Periodic' })] },
    ];
    expect(extractMeterEnergy(mv, 'last')).toBe(3000);
  });
  it('convertit les kWh en Wh', () => {
    expect(extractMeterEnergy([{ sampledValue: [sv(12.5, { unitOfMeasure: { unit: 'kWh' } })] }])).toBe(12500);
  });
  it('measurand absent = Energy.Active.Import.Register (défaut spec)', () => {
    expect(extractMeterEnergy([{ sampledValue: [{ value: '777' }] }])).toBe(777);
  });
  it('applique unitOfMeasure.multiplier (exposant de 10)', () => {
    expect(extractMeterEnergy([{ sampledValue: [sv(12.5, { unitOfMeasure: { unit: 'Wh', multiplier: 3 } })] }])).toBe(12500);
  });
  it('ignore les valeurs non numériques', () => {
    expect(extractMeterEnergy([{ sampledValue: [sv('abc'), sv(42)] }])).toBe(42);
  });
});

describe('txRecovery — parseHeartbeatInterval', () => {
  it.each([['60', 60], ['0', 0], [300, 300]])('%p → %p', (v, expected) => {
    expect(parseHeartbeatInterval(v)).toBe(expected);
  });
  it.each([[undefined], [null], [''], ['abc'], ['-5']])('%p → repli 300 (jamais NaN)', (v) => {
    expect(parseHeartbeatInterval(v)).toBe(300);
  });
  it('repli personnalisé (intervalle global pour une borne sans valeur propre)', () => {
    expect(parseHeartbeatInterval(undefined, 120)).toBe(120);
    expect(parseHeartbeatInterval('xx', 120)).toBe(120);
  });
});
