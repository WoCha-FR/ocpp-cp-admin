'use strict';

const { buildSetVariableData } = require('../../src/ocppVariables');

describe('ocppVariables — buildSetVariableData', () => {
  it('variable simple : composant, variable, attribut Actual par défaut', () => {
    expect(
      buildSetVariableData({ component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: '600' })
    ).toEqual({
      component: { name: 'OCPPCommCtrlr' },
      variable: { name: 'HeartbeatInterval' },
      attributeType: 'Actual',
      attributeValue: '600',
    });
  });

  it('M6 — transmet l’instance (ex. MessageTimeout « Default »)', () => {
    expect(
      buildSetVariableData({
        component: 'OCPPCommCtrlr',
        variable: 'MessageTimeout',
        instance: 'Default',
        attribute: 'Actual',
        value: '30',
      }).variable
    ).toEqual({ name: 'MessageTimeout', instance: 'Default' });
  });

  it('variable d’un EVSE / connecteur : evse dans le composant', () => {
    expect(
      buildSetVariableData({
        component: 'Connector',
        variable: 'Enabled',
        value: 'true',
        evse_id: 2,
        connector_id: 1,
      }).component
    ).toEqual({ name: 'Connector', evse: { id: 2, connectorId: 1 } });
    expect(
      buildSetVariableData({ component: 'EVSE', variable: 'Power', value: '1', evse_id: 3 }).component
    ).toEqual({ name: 'EVSE', evse: { id: 3 } });
  });

  it('instance vide et evse 0 : rien d’ajouté', () => {
    const d = buildSetVariableData({
      component: 'TxCtrlr',
      variable: 'TxStartPoint',
      value: 'PowerPathClosed',
      instance: '',
      evse_id: 0,
      connector_id: 0,
      attribute: 'Target',
    });
    expect(d).toEqual({
      component: { name: 'TxCtrlr' },
      variable: { name: 'TxStartPoint' },
      attributeType: 'Target',
      attributeValue: 'PowerPathClosed',
    });
  });
});
