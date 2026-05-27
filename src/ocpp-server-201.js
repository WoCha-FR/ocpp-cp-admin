const db = require('./database');
const notifications = require('./notifications');
const logger = require('./logger').scope('OCPP');
const {
  broadcast,
  getConnectedClients,
  trackRepeatedAuthReject,
  registerCallClientImpl,
  registerHandlersFn,
  debounceAvailabilityNotif,
} = require('./ocpp-common');

// ── Constantes ──

// Mapping statut OCPP 2.0.1 → cnstatus normalisé (vocabulaire 1.6 pour l'UI)
const STATUS_201_MAP = {
  Available: 'Available',
  Occupied: 'Charging', // état précis dans chargingState du TransactionEvent
  Reserved: 'Reserved',
  Unavailable: 'Unavailable',
  Faulted: 'Faulted',
};

// triggerReason → start_source
const TRIGGER_TO_START_SOURCE = {
  RemoteStart: 'remote',
  Authorized: 'rfid',
  CablePluggedIn: 'local',
  PowerPathClosed: 'local',
  EVDetected: 'local',
};

// triggerReason → stop_reason
const TRIGGER_TO_STOP_REASON = {
  Remote: 'Remote',
  Local: 'Local',
  EVDisconnected: 'EVDisconnected',
  HardReset: 'HardReset',
  SoftReset: 'SoftReset',
  PowerLoss: 'PowerLoss',
  Deauthorized: 'DeAuthorized',
  EmergencyStop: 'EmergencyStop',
  ImmediateReset: 'HardReset',
  StoppedByEV: 'EVDisconnected',
};

// ── Utilitaires ──

function sanitizeText(value, maxLen) {
  if (value == null) return null;
  const normalized = String(value)
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .replace(/[<>]/g, '')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLen);
}

function parseSampledValues(sampledValues = []) {
  let powerW = null,
    energyWh = null,
    powerOffered = null;
  let socValue = null,
    currentOffered = null;
  let currentL1 = null,
    currentL2 = null,
    currentL3 = null;
  let tempValue = null;
  let voltageL1 = null,
    voltageL2 = null,
    voltageL3 = null;
  let freqValue = null;

  for (const sv of sampledValues) {
    const val = parseFloat(sv.value);
    if (isNaN(val)) continue;
    const measurand = sv.measurand || 'Energy.Active.Import.Register';
    const phase = sv.phase || null;
    const unit = sv.unitOfMeasure?.unit || '';

    switch (measurand) {
      case 'Energy.Active.Import.Register':
        energyWh = unit === 'kWh' ? val * 1000 : val;
        break;
      case 'Power.Active.Import':
        powerW = unit === 'kW' ? val * 1000 : val;
        break;
      case 'Power.Offered':
        powerOffered = unit === 'kW' ? val * 1000 : val;
        break;
      case 'SoC':
        socValue = val;
        break;
      case 'Current.Offered':
        currentOffered = val;
        break;
      case 'Current.Import':
        if (!phase || phase === 'L1') currentL1 = val;
        else if (phase === 'L2') currentL2 = val;
        else if (phase === 'L3') currentL3 = val;
        break;
      case 'Temperature':
        tempValue = val;
        break;
      case 'Voltage':
        if (!phase || phase === 'L1' || phase === 'L1-N') voltageL1 = val;
        else if (phase === 'L2' || phase === 'L2-N') voltageL2 = val;
        else if (phase === 'L3' || phase === 'L3-N') voltageL3 = val;
        break;
      case 'Frequency':
        freqValue = val;
        break;
    }
  }
  return {
    powerW,
    energyWh,
    powerOffered,
    socValue,
    currentOffered,
    currentL1,
    currentL2,
    currentL3,
    tempValue,
    voltageL1,
    voltageL2,
    voltageL3,
    freqValue,
  };
}

// Extract energy (Wh) from a OCPP 2.0.1 meterValue array (first Energy.Active.Import.Register)
function extractMeterEnergy(meterValue = []) {
  for (const mv of meterValue) {
    for (const sv of mv.sampledValue || []) {
      if ((sv.measurand || 'Energy.Active.Import.Register') === 'Energy.Active.Import.Register') {
        const v = parseFloat(sv.value);
        if (!isNaN(v)) {
          const unit = sv.unitOfMeasure?.unit || '';
          return unit === 'kWh' ? v * 1000 : v;
        }
      }
    }
  }
  return null;
}

// ── Commandes CSMS → borne (OCPP 2.0.1) ──
async function callClient201(identity, method, params) {
  const client = getConnectedClients().get(identity);
  if (!client) throw new Error(`Chargepoint ${identity} not connected`);

  const cp = db.getChargepointByIdentity(identity);
  const cpId = cp ? cp.id : null;

  if (cpId) db.addOcppMessage(cpId, 'csms', 'CALL', method, params);
  broadcast(
    'ocpp_message',
    { identity, origin: 'csms', message_type: 'CALL', action: method, payload: params },
    cp?.site_id ?? null
  );
  logger.info(`[2.0.1] Calling ${method} on ${identity}: ${JSON.stringify(params)}`);

  let result;
  try {
    result = await client.call(method, params);
  } catch (err) {
    if (cpId) db.addOcppMessage(cpId, 'chargepoint', 'CALLERROR', method, { error: err.message });
    broadcast(
      'ocpp_message',
      {
        identity,
        origin: 'chargepoint',
        message_type: 'CALLERROR',
        action: method,
        payload: { error: err.message },
      },
      cp?.site_id ?? null
    );
    logger.warn(`[2.0.1] Error response for ${method} from ${identity}: ${err.message}`);
    throw err;
  }

  if (cpId) db.addOcppMessage(cpId, 'chargepoint', 'CALLRESULT', method, result);
  broadcast(
    'ocpp_message',
    {
      identity,
      origin: 'chargepoint',
      message_type: 'CALLRESULT',
      action: method,
      payload: result,
    },
    cp?.site_id ?? null
  );
  logger.debug(`[2.0.1] Response for ${method} from ${identity}: ${JSON.stringify(result)}`);
  return result;
}

// ── Handlers entrants (borne → CSMS) OCPP 2.0.1 ──
function register201Handlers(client, loggedHandle) {
  const identity = client.identity;
  const cpRecord = db.getChargepointByIdentity(identity);
  const chargepointId = cpRecord ? cpRecord.id : null;

  // ── BootNotification ──
  loggedHandle('BootNotification', (params) => {
    const cs = params.chargingStation || {};
    const modem = cs.modem || {};

    db.upsertChargepoint(identity, {
      vendor: sanitizeText(cs.vendorName, 25),
      model: sanitizeText(cs.model, 20),
      serial_number: sanitizeText(cs.serialNumber, 25),
      firmware_version: sanitizeText(cs.firmwareVersion, 50),
      iccid: sanitizeText(modem.iccid, 20),
      imsi: sanitizeText(modem.imsi, 20),
      cpstatus: 'Available',
      connected: 1,
    });

    const cp = db.getChargepointByIdentity(identity);
    broadcast('chargepoint_update', cp, cp?.site_id ?? null);

    const hbConfig = db.getInitialChargepointConfigByKey('HeartbeatInterval');
    const heartbeatInterval = hbConfig ? parseInt(hbConfig.value, 10) : 300;
    return {
      status: 'Accepted',
      interval: heartbeatInterval,
      currentTime: new Date().toISOString(),
    };
  });

  // ── Heartbeat ──
  loggedHandle('Heartbeat', (_params) => {
    db.updateChargepointStatus(identity, undefined, true);
    const cp = db.getChargepointByIdentity(identity);
    broadcast(
      'chargepoint_heartbeat',
      { identity, last_heartbeat: cp?.last_heartbeat },
      cp?.site_id ?? null
    );
    return { currentTime: new Date().toISOString() };
  });

  // ── StatusNotification ──
  // evseId=0 : statut au niveau borne entière
  // evseId>0 : statut d'un connecteur — on utilise evseId comme connector_id en DB
  loggedHandle('StatusNotification', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    if (!cp) return {};

    const evseId = params.evseId ?? 0;
    const rawStatus = params.connectorStatus || 'Unavailable';
    const cnstatus = STATUS_201_MAP[rawStatus] || 'Unavailable';

    if (evseId === 0) {
      db.updateChargepointStatus(identity, cnstatus, true);
    } else {
      // connector_id en DB = evseId (1 connecteur par EVSE dans le cas standard)
      const connectorDbId = evseId;
      const existingConnector = db.getConnectorByChargepointAndId(cp.id, connectorDbId);
      const previousStatus = existingConnector?.cnstatus || null;

      db.upsertConnector(
        cp.id,
        connectorDbId,
        cnstatus,
        'NoError',
        null,
        null,
        null,
        evseId,
        rawStatus
      );
      db.upsertEvse(cp.id, evseId, cnstatus);

      // Gestion des réservations
      if (cnstatus === 'Reserved') {
        db.activateReservationByConnector(cp.id, connectorDbId);
        broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
      } else if (cnstatus === 'Charging') {
        const activeTx = db.getActiveTransactionByConnector(cp.id, connectorDbId);
        if (activeTx) {
          const changed = db.startUsingReservationByConnectorAndIdTag(
            cp.id,
            connectorDbId,
            activeTx.id_tag
          );
          if (changed > 0)
            broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
        }
      } else if (['Available', 'Faulted', 'Unavailable'].includes(cnstatus)) {
        db.expireActiveReservationByConnector(cp.id, connectorDbId);
        db.fulfillInUseReservationByConnector(cp.id, connectorDbId);
        broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
      }

      db.updateChargepointStatus(identity, undefined, true);

      // Transaction orpheline : borne redevenue Available sans TransactionEvent Ended
      const activeTx = db
        .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
        .find((t) => t.connector_id === connectorDbId);
      if (activeTx && cnstatus === 'Available') {
        db.stopTransaction(
          activeTx.transaction_id,
          activeTx.meter_start || 0,
          params.timestamp || new Date().toISOString(),
          'EVDisconnected'
        );
        broadcast(
          'transaction_stop',
          { identity, transactionId: activeTx.transaction_id, reason: 'EVDisconnected' },
          cp.site_id ?? null
        );
        logger.warn(
          `[2.0.1] StatusNotification: closed orphan transaction ${activeTx.transaction_id} on ${identity} EVSE#${evseId}`
        );
      }

      const updatedCp = db.getChargepointByIdentity(identity);
      const connectors = db.getConnectorsByChargepoint(cp.id);
      broadcast('status_update', { chargepoint: updatedCp, connectors }, cp.site_id ?? null);

      if (
        cnstatus === 'Available' &&
        (previousStatus === 'Unavailable' || previousStatus === 'Faulted')
      ) {
        debounceAvailabilityNotif(identity, connectorDbId, () => {
          notifications
            .emit(
              'connector_available',
              {
                identity,
                connector_id: connectorDbId,
                cp_name: updatedCp?.cpname ?? null,
                cn_name:
                  connectors.find((c) => c.connector_id === connectorDbId)?.connector_name ?? null,
                site_name: updatedCp?.site_name ?? null,
              },
              { siteId: updatedCp?.site_id ?? null }
            )
            .catch(() => {});
        });
      }
      if (cnstatus === 'Unavailable') {
        debounceAvailabilityNotif(identity, connectorDbId, () => {
          notifications
            .emit(
              'connector_unavailable',
              {
                identity,
                connector_id: connectorDbId,
                cp_name: updatedCp?.cpname ?? null,
                cn_name:
                  connectors.find((c) => c.connector_id === connectorDbId)?.connector_name ?? null,
                site_name: updatedCp?.site_name ?? null,
              },
              { siteId: updatedCp?.site_id ?? null }
            )
            .catch(() => {});
        });
      }
      if (rawStatus === 'Faulted') {
        logger.warn(`[2.0.1] Connector error on ${identity} EVSE#${evseId}: status=Faulted`);
        db.insertErrorEvent(cp.id, 'status_error', {
          ocpp_version: '2.0.1',
          evse_id: evseId,
          status: cnstatus,
          error_code: 'Faulted',
        });
        broadcast('error_event', { chargepoint_id: cp.id }, cp.site_id ?? null);
      }
    }
    return {};
  });

  // ── Authorize ──
  loggedHandle('Authorize', (params) => {
    const idTokenObj = params.idToken || {};
    const idTag = idTokenObj.idToken || '';
    const AUTO_TAG_PREFIXES = ['WEB-', 'ADMIN', 'MGR-'];

    if (AUTO_TAG_PREFIXES.some((p) => idTag.startsWith(p))) {
      if (chargepointId) {
        db.addIdTagEvent(chargepointId, null, idTag, 'Blocked', 'auto_tag_rfid', 'authorize');
      }
      return { idTokenInfo: { status: 'Blocked' } };
    }

    const cp = db.getChargepointByIdentity(identity);
    const siteId = cp?.site_id ?? null;
    const authResult = db.authorizeIdTag(idTag, siteId);

    if (cp && cp.mode === 3) {
      logger.info(`[2.0.1] Authorize ${identity}: Accepted (free mode)`);
      return { idTokenInfo: { status: 'Accepted' } };
    }

    logger.info(`[2.0.1] Authorize ${identity}: ${authResult.status}`);
    if (authResult.status !== 'Accepted' && chargepointId) {
      db.addIdTagEvent(
        chargepointId,
        null,
        idTag,
        authResult.status,
        authResult.reason,
        'authorize'
      );
      broadcast(
        'auth_rejected',
        {
          identity,
          id_tag: idTag,
          status: authResult.status,
          reason: authResult.reason,
          source: 'authorize',
          cp_name: cp?.cpname ?? null,
        },
        siteId
      );
      trackRepeatedAuthReject(idTag, identity, cp);
    }
    return { idTokenInfo: { status: authResult.status } };
  });

  // ── TransactionEvent ──
  loggedHandle('TransactionEvent', (params) => {
    const {
      eventType,
      triggerReason,
      transactionInfo = {},
      idToken,
      evse = {},
      meterValue = [],
      timestamp,
    } = params;

    const txId = transactionInfo.transactionId;
    const evseId = evse.id ?? null;
    // connector_id en DB = evseId (mapping 1:1 EVSE→connecteur pour le cas standard)
    const connectorDbId = evseId ?? 1;
    const cp = db.getChargepointByIdentity(identity);

    // ── Started ──
    if (eventType === 'Started') {
      logger.info(`[2.0.1] TransactionEvent Started from ${identity} EVSE#${evseId} txId=${txId}`);
      const idTag = idToken?.idToken || '';
      const startSource = TRIGGER_TO_START_SOURCE[triggerReason] || 'rfid';

      let authStatus = 'Accepted';
      let authReason = null;
      if (cp && cp.mode === 1 && startSource === 'rfid') {
        const AUTO_TAG_PREFIXES = ['WEB-', 'ADMIN', 'MGR-'];
        if (AUTO_TAG_PREFIXES.some((p) => idTag.startsWith(p))) {
          authStatus = 'Blocked';
          authReason = 'auto_tag_rfid';
        } else {
          const authResult = db.authorizeIdTag(idTag, cp.site_id);
          authStatus = authResult.status;
          authReason = authResult.reason;
        }
      }
      if (authStatus !== 'Accepted') {
        if (chargepointId) {
          db.addIdTagEvent(chargepointId, null, idTag, authStatus, authReason, 'authorize');
          broadcast(
            'auth_rejected',
            {
              identity,
              id_tag: idTag,
              status: authStatus,
              reason: authReason,
              source: 'authorize',
              cp_name: cp?.cpname ?? null,
            },
            cp?.site_id ?? null
          );
          trackRepeatedAuthReject(idTag, identity, cp);
        }
        return { idTokenInfo: { status: authStatus } };
      }

      if (cp) {
        // Fermer les transactions orphelines sur le même connecteur
        const orphans = db
          .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
          .filter((t) => t.connector_id === connectorDbId);
        for (const orphan of orphans) {
          db.stopTransaction(orphan.transaction_id, null, timestamp, 'Other');
          broadcast(
            'transaction_stop',
            { identity, transactionId: orphan.transaction_id, reason: 'Other' },
            cp.site_id ?? null
          );
          logger.warn(
            `[2.0.1] TransactionEvent Started: closed orphan ${orphan.transaction_id} on ${identity} EVSE#${evseId}`
          );
        }

        const meterStart = extractMeterEnergy(meterValue) ?? 0;
        const tx = db.createTransaction(
          cp.id,
          connectorDbId,
          idTag,
          meterStart,
          timestamp,
          startSource,
          {
            transactionId: txId,
            evse_id: evseId,
            charging_state: 'Charging',
            id_token_type: idToken?.type || 'ISO14443',
          }
        );

        if (meterStart > 0) db.updateConnectorMeterValue(cp.id, connectorDbId, meterStart);

        broadcast(
          'transaction_start',
          { identity, connectorId: connectorDbId, transactionId: tx.transaction_id, idTag },
          cp.site_id ?? null
        );

        const connectors = db.getConnectorsByChargepoint(cp.id);
        notifications
          .emit(
            'site_transaction_started',
            {
              identity,
              connector_id: connectorDbId,
              cp_name: cp.cpname ?? null,
              cn_name:
                connectors.find((c) => c.connector_id === connectorDbId)?.connector_name ?? null,
              site_name: cp.site_name ?? null,
            },
            { siteId: cp.site_id }
          )
          .catch(() => {});

        if (idTag) {
          const tag = db.getIdTagByTag(idTag, cp.site_id);
          if (tag?.user_id) {
            notifications
              .emit(
                'transaction_started',
                {
                  identity,
                  connector_id: connectorDbId,
                  transaction_id: tx.transaction_id,
                  cp_name: cp.cpname ?? null,
                  cn_name:
                    connectors.find((c) => c.connector_id === connectorDbId)?.connector_name ??
                    null,
                  site_name: cp.site_name ?? null,
                },
                { userId: tag.user_id }
              )
              .catch(() => {});
          }
        }

        // Réservation
        if (transactionInfo.reservationId != null) {
          const reservation = db.getReservationByOcppId(cp.id, transactionInfo.reservationId);
          if (reservation && reservation.status === 'Active' && reservation.id_tag === idTag) {
            db.updateReservationStatus(reservation.id, 'InUse');
            broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
          }
        }
      }

      return { idTokenInfo: { status: 'Accepted' } };
    }

    // ── Updated ──
    if (eventType === 'Updated') {
      if (!cp || !txId) return {};
      const tx = db.getTransactionByTransactionId(txId);
      if (!tx) {
        logger.warn(`[2.0.1] TransactionEvent Updated for unknown transaction ${txId}`);
        return {};
      }

      const chargingState = transactionInfo.chargingState || null;
      if (chargingState) db.updateTransactionChargingState(txId, chargingState);

      let lastPowerW = null;
      let lastEnergyWh = null;

      for (const mv of meterValue) {
        const parsed = parseSampledValues(mv.sampledValue || []);
        const {
          powerW,
          energyWh,
          powerOffered,
          socValue,
          currentOffered,
          currentL1,
          currentL2,
          currentL3,
          tempValue,
          voltageL1,
          voltageL2,
          voltageL3,
          freqValue,
        } = parsed;

        if (powerW !== null) lastPowerW = powerW;
        if (energyWh !== null) {
          lastEnergyWh = energyWh;
          db.updateConnectorMeterValue(cp.id, connectorDbId, energyWh);
        }

        db.updateTransactionPowerEnergy(
          txId,
          powerW !== null ? Math.round(powerW) : null,
          energyWh !== null ? Math.round(energyWh) : null
        );

        const ts = mv.timestamp || timestamp;
        if (ts) {
          const unixTs = Math.floor(new Date(ts).getTime() / 1000);
          const tvData = {};
          if (powerOffered !== null || powerW !== null || energyWh !== null) {
            const relativeEnergy =
              energyWh !== null
                ? Math.round(energyWh - (tx.meter_start != null ? tx.meter_start : 0))
                : null;
            tvData.energieEntry = {
              x: unixTs,
              offer: powerOffered !== null ? Math.round(powerOffered) : null,
              power: powerW !== null ? Math.round(powerW) : null,
              energy: relativeEnergy,
            };
          }
          if (
            currentOffered !== null ||
            currentL1 !== null ||
            currentL2 !== null ||
            currentL3 !== null
          )
            tvData.courantEntry = {
              x: unixTs,
              offer: currentOffered,
              l1: currentL1,
              l2: currentL2,
              l3: currentL3,
            };
          if (socValue !== null) tvData.socEntry = { x: unixTs, y: socValue };
          if (tempValue !== null) tvData.tempEntry = { x: unixTs, y: tempValue };
          if (voltageL1 !== null || voltageL2 !== null || voltageL3 !== null)
            tvData.tensionEntry = { x: unixTs, l1: voltageL1, l2: voltageL2, l3: voltageL3 };
          if (freqValue !== null) tvData.freqEntry = { x: unixTs, y: freqValue };
          if (Object.keys(tvData).length > 0) db.upsertTransactionValues(txId, tvData);
        }
      }

      if (lastEnergyWh !== null) {
        const updatedCp = db.getChargepointByIdentity(identity);
        broadcast(
          'chargepoint_meter_update',
          { identity, meter_value: updatedCp?.meter_value },
          cp.site_id ?? null
        );
      }

      broadcast(
        'transaction_updated',
        {
          identity,
          connectorId: connectorDbId,
          transactionId: txId,
          power: lastPowerW !== null ? Math.round(lastPowerW) : null,
          energy: lastEnergyWh !== null ? Math.round(lastEnergyWh) : null,
          charging_state: chargingState,
        },
        cp.site_id ?? null
      );
      return {};
    }

    // ── Ended ──
    if (eventType === 'Ended') {
      logger.info(`[2.0.1] TransactionEvent Ended from ${identity} txId=${txId}`);
      if (!txId) return {};

      const meterStop = extractMeterEnergy(meterValue);
      const stopReason = TRIGGER_TO_STOP_REASON[triggerReason] || triggerReason || 'Local';

      db.stopTransaction(txId, meterStop, timestamp, stopReason);
      broadcast(
        'transaction_stop',
        { identity, transactionId: txId, meterStop, reason: stopReason },
        cp?.site_id ?? null
      );

      const stoppedTx = db.getTransactionByTransactionId(txId);
      if (stoppedTx) {
        const cpForTx = db.getChargepointById(stoppedTx.chargepoint_id);
        if (cpForTx && meterStop != null) {
          db.updateConnectorMeterValue(cpForTx.id, stoppedTx.connector_id, meterStop);
        }

        let energyKwh = null;
        let duration = null;
        if (stoppedTx.meter_stop != null && stoppedTx.meter_start != null) {
          energyKwh = ((stoppedTx.meter_stop - stoppedTx.meter_start) / 1000).toFixed(2);
        }
        if (stoppedTx.start_time && stoppedTx.stop_time) {
          const mins = Math.floor(
            (new Date(stoppedTx.stop_time) - new Date(stoppedTx.start_time)) / 60000
          );
          duration =
            mins >= 60
              ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`
              : `${mins} min`;
        }

        const connectors = cpForTx ? db.getConnectorsByChargepoint(cpForTx.id) : [];
        const cnName =
          connectors.find((c) => c.connector_id === stoppedTx.connector_id)?.connector_name ?? null;

        notifications
          .emit(
            'site_transaction_stopped',
            {
              identity,
              connector_id: stoppedTx.connector_id,
              energy_kwh: energyKwh,
              duration,
              stop_reason: stopReason,
              cp_name: cpForTx?.cpname ?? null,
              cn_name: cnName,
              site_name: cpForTx?.site_name ?? null,
            },
            { siteId: cpForTx?.site_id ?? null }
          )
          .catch(() => {});

        const idTag = stoppedTx.id_tag;
        if (idTag && cpForTx) {
          const tag = db.getIdTagByTag(idTag, cpForTx.site_id);
          if (tag?.user_id) {
            notifications
              .emit(
                'transaction_stopped',
                {
                  identity,
                  connector_id: stoppedTx.connector_id,
                  energy_kwh: energyKwh,
                  duration,
                  transaction_id: txId,
                  stop_reason: stopReason,
                  cp_name: cpForTx.cpname ?? null,
                  cn_name: cnName,
                  site_name: cpForTx.site_name ?? null,
                },
                { userId: tag.user_id }
              )
              .catch(() => {});
          }
          const changed = db.fulfillReservationByConnectorAndIdTag(
            cpForTx.id,
            stoppedTx.connector_id,
            idTag
          );
          if (changed > 0)
            broadcast(
              'reservation_updated',
              { chargepoint_id: cpForTx.id },
              cpForTx.site_id ?? null
            );
        }
      }
      return {};
    }

    return {};
  });

  // ── MeterValues (hors-transaction) ──
  loggedHandle('MeterValues', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    if (!cp || !params.meterValue) return {};

    const evseId = params.evseId ?? 0;
    const connectorDbId = evseId;

    for (const mv of params.meterValue) {
      const { energyWh, powerW } = parseSampledValues(mv.sampledValue || []);

      if (energyWh !== null) {
        if (evseId === 0) db.updateChargepointMeterValue(cp.id, energyWh);
        else db.updateConnectorMeterValue(cp.id, connectorDbId, energyWh);

        const updatedCp = db.getChargepointByIdentity(identity);
        broadcast(
          'chargepoint_meter_update',
          { identity, meter_value: updatedCp?.meter_value },
          cp.site_id ?? null
        );
      }
      broadcast(
        'meter_values',
        { identity, connectorId: connectorDbId, meterValue: [mv] },
        cp.site_id ?? null
      );
      void powerW;
    }
    return {};
  });

  // ── NotifyReport ──
  // Réponse à GetReport : stocke les variables en DB, émet config_refreshed sur le dernier batch
  loggedHandle('NotifyReport', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    if (!cp) return {};

    for (const reportData of params.reportData || []) {
      const component = reportData.component?.name || null;
      const variable = reportData.variable?.name || null;
      if (!component || !variable) continue;
      for (const attrProp of reportData.variableAttribute || []) {
        const attribute = attrProp.type || 'Actual';
        const value = attrProp.value ?? null;
        db.upsertChargepointVariable(cp.id, component, variable, attribute, value);
      }
    }

    if (!params.tbc) {
      broadcast('config_refreshed', { chargepointId: cp.id, identity }, cp.site_id ?? null);
      logger.info(`[2.0.1] NotifyReport complete for ${identity}`);
    }
    return {};
  });

  // ── ReservationStatusUpdate ──
  loggedHandle('ReservationStatusUpdate', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    if (!cp) return {};

    const reservation = db.getReservationByOcppId(cp.id, params.reservationId);
    if (reservation) {
      const statusMap = { Expired: 'Expired', Removed: 'Expired', Failed: 'Expired' };
      const newStatus = statusMap[params.reservationUpdateStatus] || null;
      if (newStatus) {
        db.updateReservationStatus(reservation.id, newStatus);
        broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
      }
    }
    return {};
  });
}

// ── Enregistrement au chargement du module ──
registerHandlersFn('2.0.1', register201Handlers);
registerCallClientImpl('2.0.1', callClient201);

module.exports = { register201Handlers, callClient201 };
