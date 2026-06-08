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
  pendingRemoteStarts,
} = require('./ocpp-common');

// ── Constantes ──

// Mapping statut OCPP 2.0.1 → cnstatus normalisé (vocabulaire 1.6 pour l'UI)
const STATUS_201_MAP = {
  Available: 'Available',
  Occupied: 'Preparing',
  Reserved: 'Reserved',
  Unavailable: 'Unavailable',
  Faulted: 'Faulted',
};

// chargingState OCPP 2.0.1 → cnstatus normalisé
const CHARGING_STATE_TO_CNSTATUS = {
  EVConnected: 'Preparing',
  Charging: 'Charging',
  SuspendedEV: 'SuspendedEV',
  SuspendedEVSE: 'SuspendedEVSE',
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

const initSeqVersions201 = new Map();

function isDisconnectionError(e) {
  const msg = e.message || '';
  return (
    msg.includes('not connected') ||
    msg.toLowerCase().includes('disconnected') ||
    msg.includes('going away') ||
    msg.includes('socket not open')
  );
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
  let pendingStatusAfterBootCallback = null;

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

    const seqVersion = (initSeqVersions201.get(identity) || 0) + 1;
    initSeqVersions201.set(identity, seqVersion);

    setImmediate(
      async (cpSnap, seqVersion) => {
        if (!cpSnap || cpSnap.initialized) return;

        const isSuperseded = () => initSeqVersions201.get(identity) !== seqVersion;
        let disconnectedDuringInit = false;
        let lastFailedStep = null;

        // Step 1/4 — ClearCache
        if (isSuperseded()) return;
        try {
          logger.debug(`[InitSeq201] ${identity} step 1/4 — ClearCache`);
          await callClient201(identity, 'ClearCache', {});
        } catch (e) {
          logger.warn(`[InitSeq201] ${identity} ClearCache: ${e.message}`);
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'ClearCache';
          }
        }

        // Step 2/4 — ClearChargingProfile (si aucun profil géré)
        if (isSuperseded()) return;
        try {
          const existingProfiles = db.getChargingProfiles(cpSnap.id);
          if (existingProfiles.length === 0) {
            logger.debug(`[InitSeq201] ${identity} step 2/4 — ClearChargingProfile`);
            await callClient201(identity, 'ClearChargingProfile', {});
          } else {
            logger.debug(
              `[InitSeq201] ${identity} step 2/4 — skipped (${existingProfiles.length} profil(s) géré(s))`
            );
          }
        } catch (e) {
          logger.warn(`[InitSeq201] ${identity} ClearChargingProfile: ${e.message}`);
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'ClearChargingProfile';
          }
        }

        // Step 3/4 — GetBaseReport (synchronise l'état courant en DB via NotifyReport)
        if (isSuperseded()) return;
        try {
          logger.debug(`[InitSeq201] ${identity} step 3/4 — GetBaseReport`);
          await callClient201(identity, 'GetBaseReport', {
            requestId: Date.now(),
            reportBase: 'FullInventory',
          });
        } catch (e) {
          logger.warn(`[InitSeq201] ${identity} GetBaseReport: ${e.message}`);
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'GetBaseReport';
          }
        }

        // Step 4/4 — SetVariables (application des variables initiales)
        if (isSuperseded()) return;
        const vars = db.getEnabledInitialChargepointVariables();
        const rebootVars = [];
        for (const v of vars) {
          if (isSuperseded()) break;
          try {
            logger.debug(
              `[InitSeq201] ${identity} step 4/4 — SetVariables ${v.component}.${v.variable}`
            );
            const result = await callClient201(identity, 'SetVariables', {
              setVariableData: [
                {
                  component: { name: v.component },
                  variable: { name: v.variable },
                  attributeType: v.attribute || 'Actual',
                  attributeValue: v.value,
                },
              ],
            });
            const setResult = result?.setVariableResult?.[0];
            if (
              setResult?.attributeStatus === 'Accepted' ||
              setResult?.attributeStatus === 'RebootRequired'
            ) {
              const refreshedCp = db.getChargepointByIdentity(identity);
              if (refreshedCp)
                db.upsertChargepointVariable(
                  refreshedCp.id,
                  v.component,
                  v.variable,
                  v.attribute || 'Actual',
                  v.value
                );
              if (setResult.attributeStatus === 'RebootRequired')
                rebootVars.push(`${v.component}.${v.variable}`);
            } else {
              logger.warn(
                `[InitSeq201] ${identity} SetVariables ${v.component}.${v.variable}: ${setResult?.attributeStatus}`
              );
            }
          } catch (e) {
            logger.warn(
              `[InitSeq201] ${identity} SetVariables ${v.component}.${v.variable}: ${e.message}`
            );
            if (isDisconnectionError(e)) {
              disconnectedDuringInit = true;
              lastFailedStep = `SetVariables(${v.component}.${v.variable})`;
              break;
            }
          }
        }

        if (isSuperseded()) return;

        if (disconnectedDuringInit) {
          logger.warn(
            `[InitSeq201] ${identity} initialisation interrompue à "${lastFailedStep}" — retry à la reconnexion`
          );
          return;
        }

        if (rebootVars.length > 0) {
          notifications
            .emit('init_config_result', {
              identity,
              rebootKeys: rebootVars,
              rejectedKeys: [],
              notSupportedKeys: [],
            })
            .catch(() => {});
        }

        db.markChargepointInitialized(cpSnap.id);
        logger.debug(`[InitSeq201] ${identity} séquence d'initialisation terminée`);
      },
      cp,
      seqVersion
    );

    const hbConfig = db.getInitialChargepointVariableByKey('OCPPCommCtrlr', 'HeartbeatInterval');
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
  // evseId>0 : statut d'un connecteur EVSE — connector_id en DB = params.connectorId, evse_id = evseId
  loggedHandle('StatusNotification', (params) => {
    if (pendingStatusAfterBootCallback) {
      pendingStatusAfterBootCallback();
      pendingStatusAfterBootCallback = null;
    }
    const cp = db.getChargepointByIdentity(identity);
    if (!cp) return {};

    const evseId = params.evseId ?? 0;
    const rawStatus = params.connectorStatus || 'Unavailable';
    let cnstatus = STATUS_201_MAP[rawStatus] || 'Unavailable';

    if (evseId === 0) {
      db.updateChargepointStatus(identity, cnstatus, true);
    } else {
      const connectorDbId = params.connectorId ?? 1;
      const existingConnector = db.getConnectorByChargepointAndId(cp.id, connectorDbId, evseId);
      const previousStatus = existingConnector?.cnstatus || null;

      // 'Occupied' est un statut grossier — ne pas écraser le statut fin établi par TransactionEvent
      if (rawStatus === 'Occupied') {
        const activeTx = db.getActiveTransactionByConnector(cp.id, connectorDbId);
        if (activeTx?.charging_state) {
          cnstatus = CHARGING_STATE_TO_CNSTATUS[activeTx.charging_state] || cnstatus;
        }

        // Plug&Charge mode 2 : déclencher RequestStartTransaction automatiquement
        if (cp.mode === 2 && evseId > 0 && !activeTx) {
          const idTag = `MGR-${cp.site_id}`;
          if (!db.getIdTagByTag(idTag)) {
            db.createIdTag(idTag, null, cp.site_id, `Tag manager site ${cp.site_id} auto`, null, 0);
          }
          const pendingKey = `${identity}_${connectorDbId}`;
          pendingRemoteStarts.set(pendingKey, { source: 'remote', userId: null });
          const pendingRemoteStartTimer = setTimeout(
            () => pendingRemoteStarts.delete(pendingKey),
            60000
          );
          pendingRemoteStartTimer.unref();

          callClient201(identity, 'RequestStartTransaction', {
            evseId,
            idToken: { idToken: idTag, type: 'ISO14443' },
          })
            .then((result) => {
              logger.info(
                `[2.0.1] RequestStartTransaction Plug&Charge for ${identity} EVSE#${evseId}: ${result.status}`
              );
              if (result.status !== 'Accepted') pendingRemoteStarts.delete(pendingKey);
            })
            .catch((err) => {
              logger.error(
                `[2.0.1] RequestStartTransaction Plug&Charge error for ${identity} EVSE#${evseId}: ${err.message}`
              );
              pendingRemoteStarts.delete(pendingKey);
            });
        }
      }

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
        db.activateReservationByEvse(cp.id, evseId);
        broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
      } else if (cnstatus === 'Charging') {
        const activeTx = db.getActiveTransactionByConnector(cp.id, connectorDbId);
        if (activeTx) {
          const changed = db.startUsingReservationByEvseAndIdTag(cp.id, evseId, activeTx.id_tag);
          if (changed > 0)
            broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
        }
      } else if (['Available', 'Faulted', 'Unavailable'].includes(cnstatus)) {
        db.expireActiveReservationByEvse(cp.id, evseId);
        db.fulfillInUseReservationByEvse(cp.id, evseId);
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
    const idTokenType = idTokenObj.type || null;
    const AUTO_TAG_PREFIXES = ['WEB-', 'ADMIN', 'MGR-'];

    if (AUTO_TAG_PREFIXES.some((p) => idTag.startsWith(p))) {
      if (chargepointId) {
        db.addIdTagEvent(chargepointId, null, idTag, 'Blocked', 'auto_tag_rfid', 'authorize');
      }
      return { idTokenInfo: { status: 'Blocked' } };
    }

    const cp = db.getChargepointByIdentity(identity);
    const siteId = cp?.site_id ?? null;
    const authResult = db.authorizeIdTag(idTag, siteId, idTokenType);

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

    let txId = transactionInfo.transactionId;
    const evseId = evse.id ?? null;
    const connectorDbId = evse.connectorId ?? 1;
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
          const authResult = db.authorizeIdTag(idTag, cp.site_id, idToken?.type || null);
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
            charging_state: transactionInfo.chargingState || 'EVConnected',
            id_token_type: idToken?.type || 'ISO14443',
          }
        );

        if (meterStart > 0) db.updateEvseMeterValue(cp.id, evseId, meterStart);

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

        // Mise à jour cnstatus connecteur — fallback EVConnected si chargingState absent (cohérent avec l. 682)
        const txChargingState = transactionInfo.chargingState || 'EVConnected';
        const newCnStatus = CHARGING_STATE_TO_CNSTATUS[txChargingState] || 'Preparing';
        if (evseId !== null) {
          db.updateConnectorCnstatus(cp.id, connectorDbId, evseId, newCnStatus);
          db.upsertEvse(cp.id, evseId, newCnStatus);
        }
        // Toujours diffuser status_update — équivalent du StatusNotification(Charging) en 1.6
        const updatedCp2 = db.getChargepointByIdentity(identity);
        const connectors2 = db.getConnectorsByChargepoint(cp.id);
        broadcast(
          'status_update',
          { chargepoint: updatedCp2, connectors: connectors2 },
          cp.site_id ?? null
        );

        // Réservation par reservationId (cas nominal)
        if (transactionInfo.reservationId != null) {
          const reservation = db.getReservationByOcppId(cp.id, transactionInfo.reservationId);
          if (reservation && reservation.status === 'Active' && reservation.id_tag === idTag) {
            db.updateReservationStatus(reservation.id, 'InUse');
            broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
          }
        } else if (idTag) {
          // Fallback : borne n'envoie pas reservationId — on cherche par id_tag
          const changed = db.startUsingReservationByEvseAndIdTag(cp.id, evseId, idTag);
          if (changed > 0)
            broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
        }
      }

      return { idTokenInfo: { status: 'Accepted' } };
    }

    // ── Updated ──
    if (eventType === 'Updated') {
      if (!cp || !txId) return {};
      let tx = db.getTransactionByTransactionId(txId);
      if (!tx) {
        const activeTx = db.getActiveTransactionByConnector(cp.id, connectorDbId);
        if (activeTx) {
          logger.warn(
            `[2.0.1] MeterValues txId inconnu ${txId} depuis ${identity}, redirigé vers tx active ${activeTx.transaction_id}`
          );
          txId = activeTx.transaction_id;
          tx = activeTx;
        } else {
          logger.warn(`[2.0.1] TransactionEvent Updated for unknown transaction ${txId}`);
          return {};
        }
      }
      if (tx.status !== 'Active') {
        logger.warn(
          `[2.0.1] TransactionEvent Updated pour transaction clôturée ${txId} depuis ${identity} — ignorés`
        );
        return {};
      }

      const chargingState = transactionInfo.chargingState || null;
      if (chargingState) {
        db.updateTransactionChargingState(txId, chargingState);
        const effectiveEvseId = evseId ?? tx.evse_id ?? null;
        if (effectiveEvseId !== null) {
          const newCnStatus = CHARGING_STATE_TO_CNSTATUS[chargingState] || 'Preparing';
          db.updateConnectorCnstatus(cp.id, connectorDbId, effectiveEvseId, newCnStatus);
          db.upsertEvse(cp.id, effectiveEvseId, newCnStatus);
          const updatedCp2 = db.getChargepointByIdentity(identity);
          const connectors2 = db.getConnectorsByChargepoint(cp.id);
          broadcast(
            'status_update',
            { chargepoint: updatedCp2, connectors: connectors2 },
            cp.site_id ?? null
          );
        }
      }

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
          db.updateEvseMeterValue(cp.id, evseId, energyWh);
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
      // Diffuser meter_values si présents — aligne avec 1.6 MeterValues handler (connecteurs tab)
      if (meterValue.length > 0) {
        broadcast(
          'meter_values',
          { identity, connectorId: connectorDbId, meterValue },
          cp.site_id ?? null
        );
      }
      return {};
    }

    // ── Ended ──
    if (eventType === 'Ended') {
      logger.info(`[2.0.1] TransactionEvent Ended from ${identity} txId=${txId}`);
      if (!txId) return {};

      let meterStop = extractMeterEnergy(meterValue);
      const stopReason = TRIGGER_TO_STOP_REASON[triggerReason] || triggerReason || 'Local';

      // Corriger meterStop si la borne envoie une valeur <= meter_start alors que de l'énergie a été consommée
      const preTx = db.getTransactionByTransactionId(txId);
      if (
        preTx &&
        preTx.status === 'Active' &&
        preTx.energy != null &&
        preTx.energy > 0 &&
        (meterStop == null || meterStop <= preTx.meter_start)
      ) {
        const corrected = preTx.meter_start + preTx.energy;
        logger.warn(
          `[2.0.1] TransactionEvent Ended meterStop incohérent (${meterStop}) sur ${identity} tx ${txId}, corrigé à ${corrected}`
        );
        meterStop = corrected;
      }

      db.stopTransaction(txId, meterStop, timestamp, stopReason);

      let stoppedTx = db.getTransactionByTransactionId(txId);
      // Fallback : si le transactionId est inconnu, chercher une tx active sur ce chargeur
      if (!stoppedTx && cp) {
        const activeTxs = db.getTransactions({ chargepoint_id: cp.id, status: 'Active' });
        if (activeTxs.length >= 1) {
          const activeTx = activeTxs.sort(
            (a, b) => new Date(b.start_time) - new Date(a.start_time)
          )[0];
          db.stopTransaction(activeTx.transaction_id, meterStop, timestamp, stopReason || 'Other');
          stoppedTx = db.getTransactionByTransactionId(activeTx.transaction_id);
          logger.warn(
            `[2.0.1] [Recovery] TransactionEvent Ended txId inconnu ${txId} sur ${identity}, ` +
              `${activeTxs.length > 1 ? `${activeTxs.length} tx actives — ` : ''}tx ${activeTx.transaction_id} fermée`
          );
        } else {
          logger.warn(
            `[2.0.1] [Recovery] TransactionEvent Ended txId inconnu ${txId} sur ${identity}, aucune tx active`
          );
        }
      }

      if (!stoppedTx) {
        logger.warn(
          `[2.0.1] TransactionEvent Ended txId=${txId} sur ${identity} ignoré : aucune transaction trouvée (idToken probablement invalide)`
        );
        return {};
      }
      const resolvedTransactionId = stoppedTx.transaction_id;
      broadcast(
        'transaction_stop',
        { identity, transactionId: resolvedTransactionId, meterStop, reason: stopReason },
        cp?.site_id ?? null
      );
      if (stoppedTx && stoppedTx.evse_id != null) {
        db.updateConnectorCnstatus(
          stoppedTx.chargepoint_id,
          stoppedTx.connector_id,
          stoppedTx.evse_id,
          'Finishing'
        );
        db.upsertEvse(stoppedTx.chargepoint_id, stoppedTx.evse_id, 'Finishing');
        const updatedCpF = db.getChargepointById(stoppedTx.chargepoint_id);
        const connectorsF = db.getConnectorsByChargepoint(stoppedTx.chargepoint_id);
        broadcast(
          'status_update',
          { chargepoint: updatedCpF, connectors: connectorsF },
          updatedCpF?.site_id ?? null
        );
      }
      if (stoppedTx) {
        const cpForTx = db.getChargepointById(stoppedTx.chargepoint_id);
        if (cpForTx && meterStop != null && stoppedTx.evse_id != null) {
          db.updateEvseMeterValue(cpForTx.id, stoppedTx.evse_id, meterStop);
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
                  transaction_id: resolvedTransactionId,
                  stop_reason: stopReason,
                  cp_name: cpForTx.cpname ?? null,
                  cn_name: cnName,
                  site_name: cpForTx.site_name ?? null,
                },
                { userId: tag.user_id }
              )
              .catch(() => {});
          }
          const changed =
            stoppedTx.evse_id != null
              ? db.fulfillReservationByEvseAndIdTag(cpForTx.id, stoppedTx.evse_id, idTag)
              : db.fulfillReservationByConnectorAndIdTag(cpForTx.id, stoppedTx.connector_id, idTag);
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
    const connectorDbId = params.connectorId ?? evseId;

    for (const mv of params.meterValue) {
      const { energyWh, powerW } = parseSampledValues(mv.sampledValue || []);

      if (energyWh !== null) {
        if (evseId === 0) db.updateChargepointMeterValue(cp.id, energyWh);
        else db.updateEvseMeterValue(cp.id, evseId, energyWh);

        const updatedCp = db.getChargepointByIdentity(identity);
        broadcast(
          'chargepoint_meter_update',
          { identity, meter_value: updatedCp?.meter_value },
          cp.site_id ?? null
        );
      }
      broadcast(
        'meter_values',
        { identity, evseId, connectorId: connectorDbId, meterValue: [mv] },
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
        const readonly = attrProp.mutability === 'ReadOnly' ? 1 : 0;
        db.upsertChargepointVariable(cp.id, component, variable, attribute, value, readonly);
      }
    }

    if (!params.tbc) {
      db.updateChargepointFeatures201(cp.id);
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

  // ── DataTransfer ──
  loggedHandle('DataTransfer', (_params) => {
    return { status: 'Accepted' };
  });

  // ── FirmwareStatusNotification ──
  loggedHandle('FirmwareStatusNotification', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    broadcast('firmware_status', { identity, status: params.status }, cp?.site_id ?? null);
    if (['Installed', 'InstallationFailed', 'DownloadFailed'].includes(params.status)) {
      notifications
        .emit('firmware_status', {
          identity,
          status: params.status,
          cp_name: cp?.cpname ?? null,
          site_name: cp?.site_name ?? null,
        })
        .catch(() => {});
    }
    return {};
  });

  // ── LogStatusNotification (équivalent 2.0.1 de DiagnosticsStatusNotification) ──
  loggedHandle('LogStatusNotification', (params) => {
    if (params.status === 'Uploaded' || params.status === 'UploadFailed') {
      const cp = db.getChargepointByIdentity(identity);
      broadcast('diagnostics_upload', { identity, status: params.status }, cp?.site_id ?? null);
    }
    return {};
  });

  // ── SecurityEventNotification ──
  loggedHandle('SecurityEventNotification', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    if (cp) {
      logger.warn(
        `[2.0.1] SecurityEvent on ${identity}: type=${params.type} tech=${params.techInfo ?? ''}`
      );
      db.insertErrorEvent(cp.id, 'security_event', {
        ocpp_version: '2.0.1',
        tech_code: params.type,
        tech_info: params.techInfo ?? null,
      });
      broadcast('error_event', { chargepoint_id: cp.id }, cp.site_id ?? null);
    }
    return {};
  });

  // ── NotifyEvent ──
  loggedHandle('NotifyEvent', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    if (cp) {
      const ALERT_TRIGGERS = new Set(['Alerting', 'Critical']);
      for (const ev of params.eventData ?? []) {
        if (!ALERT_TRIGGERS.has(ev.trigger)) continue;
        db.insertErrorEvent(cp.id, 'notify_event', {
          ocpp_version: '2.0.1',
          evse_id: ev.component?.evse?.id ?? null,
          connector_id: ev.component?.evse?.connectorId ?? null,
          component: ev.component?.name ?? null,
          variable: ev.variable?.name ?? null,
          severity: ev.severity ?? null,
          tech_code: ev.techCode ?? ev.trigger ?? null,
          tech_info: ev.techInfo ?? ev.eventNotificationType ?? null,
          info: ev.actualValue ?? null,
        });
        broadcast('error_event', { chargepoint_id: cp.id }, cp.site_id ?? null);
      }
    }
    return {};
  });

  // Après reconnexion sans BootNotification : demander à la borne de renvoyer son état
  if (cpRecord && cpRecord.initialized) {
    const refreshTimer = setTimeout(async () => {
      const current = db.getChargepointByIdentity(identity);
      if (!current || !current.connected || current.cpstatus) return;

      logger.info(
        `[StateRefresh201] ${identity}: reconnecté sans BootNotification, envoi TriggerMessage`
      );
      try {
        await callClient201(identity, 'TriggerMessage', { requestedMessage: 'BootNotification' });
      } catch (e) {
        logger.warn(
          `[StateRefresh201] ${identity}: TriggerMessage(BootNotification) échoué: ${e.message}`
        );
        return;
      }

      const statusReceived = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingStatusAfterBootCallback = null;
          resolve(false);
        }, 10000);
        timer.unref();
        pendingStatusAfterBootCallback = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });

      if (!db.getChargepointByIdentity(identity)?.connected) return;

      if (statusReceived) {
        logger.info(
          `[StateRefresh201] ${identity}: StatusNotification auto-reçu, skip TriggerMessage(StatusNotification)`
        );
        return;
      }

      try {
        await callClient201(identity, 'TriggerMessage', { requestedMessage: 'StatusNotification' });
      } catch (e) {
        logger.warn(
          `[StateRefresh201] ${identity}: TriggerMessage(StatusNotification) échoué: ${e.message}`
        );
      }
    }, 8000);
    refreshTimer.unref();

    client.once('close', () => clearTimeout(refreshTimer));
  }
}

// ── Enregistrement au chargement du module ──
registerHandlersFn('2.0.1', register201Handlers);
registerCallClientImpl('2.0.1', callClient201);

module.exports = { register201Handlers, callClient201 };
