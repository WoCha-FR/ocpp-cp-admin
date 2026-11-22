'use strict';

// ── Variables OCPP 2.0.1 (Device Model) ──
// Module pur, partagé par la séquence d'initialisation (ocpp-server-201) et les routes
// (cascade / application des variables initiales).

/**
 * Entrée SetVariableData d'une variable (initiale ou de la borne). L'instance (ex.
 * MessageTimeout « Default », MessageAttempts « TransactionEvent ») et l'EVSE / connecteur du
 * composant font partie de l'identité de la variable dans le Device Model : sans eux la borne
 * répond UnknownVariable / UnknownComponent, ou règle une autre variable.
 * @param {{component: string, variable: string, attribute?: string, value: string,
 *   instance?: string, evse_id?: number, connector_id?: number}} v
 */
function buildSetVariableData(v) {
  const component = { name: v.component };
  if (v.evse_id) {
    component.evse = { id: v.evse_id, ...(v.connector_id ? { connectorId: v.connector_id } : {}) };
  }
  return {
    component,
    variable: { name: v.variable, ...(v.instance ? { instance: v.instance } : {}) },
    attributeType: v.attribute || 'Actual',
    attributeValue: v.value,
  };
}

module.exports = { buildSetVariableData };
