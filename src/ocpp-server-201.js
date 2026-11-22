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
const {
  lastKnownMeterStop,
  pickRecoveryCandidate,
  resolveStopReason201,
  extractMeterEnergy,
  parseHeartbeatInterval,
} = require('./txRecovery');
const { parseSampledValues } = require('./meterSamples');
const {
  isGeneratedTag,
  registerPendingRemoteStart,
  findPendingRemoteStart,
} = require('./remoteStarts');
const { toIsoDateTime } = require('./chargingProfiles');

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

// La raison d'arrêt se lit dans transactionInfo.stoppedReason (repli sur triggerReason) :
// voir resolveStopReason201 dans txRecovery.js

// ── Utilitaires ──

// Statuts de connecteur (vocabulaire normalisé) dont on peut passer à « Occupied » par un nouveau
// branchement ; null = premier statut connu (ex. reconnexion avec un véhicule déjà branché).
// Preparing / Finishing / Charging / Suspended* : véhicule déjà branché, session déjà vue.
const NEW_PLUG_IN_FROM = new Set(['Available', 'Unavailable', 'Reserved', 'Faulted']);
function isNewPlugIn(previousStatus) {
  return previousStatus == null || NEW_PLUG_IN_FROM.has(previousStatus);
}

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

// idTokenInfo avec cacheExpiryDateTime quand le tag en base a une date d'expiration
// (équivalent 2.0.1 de idTagInfo.expiryDate en 1.6 — `expiryDate` n'existe pas dans IdTokenInfoType)
function buildIdTokenInfo(status, tag) {
  return {
    status,
    ...(tag && tag.expiry_date ? { cacheExpiryDateTime: toIsoDateTime(tag.expiry_date) } : {}),
  };
}

// ── Badge présenté pendant une transaction (TransactionEvent Updated avec idToken) ──
// Cas nominal 2.0.1 : « câble branché d'abord » → Started(CablePluggedIn) sans idToken, puis le
// badge est présenté : Updated(Authorized, idToken). Le CSMS doit contrôler le badge et répondre
// idTokenInfo (la borne coupe la session si le statut n'est pas Accepted), et rattacher le badge
// à la transaction (attribution à l'utilisateur, tarif, remboursement).
// Cas « démarrage à distance, câble branché d'abord » (F02) : la transaction existe déjà, la
// borne envoie Updated(RemoteStart, remoteStartId, idToken) avec le badge du démarrage à
// distance (souvent un badge généré ADMIN / MGR-x / WEB-x) → `isRemoteStart` : accepté et
// rattaché sans contrôle, comme un Started(RemoteStart).
// Retourne l'idTokenInfo à renvoyer à la borne.
function evaluateIdTokenOnUpdate({
  cp,
  tx,
  txId,
  idToken,
  identity,
  chargepointId,
  isRemoteStart = false,
}) {
  const idTag = idToken.idToken;
  const tokenType = idToken.type || null;

  // Même badge que celui de la session : déjà contrôlé au démarrage (ex. arrêt par le même badge)
  if (tx.id_tag && tx.id_tag === idTag) return buildIdTokenInfo('Accepted', null);

  let authStatus = 'Accepted';
  let authReason = null;
  let authTag = null;
  // Même règle qu'au démarrage : seul le mode 1 (badge contrôlé par le CSMS) refuse un badge
  if (cp.mode === 1 && !isRemoteStart) {
    if (isGeneratedTag(idTag)) {
      authStatus = 'Blocked';
      authReason = 'auto_tag_rfid';
    } else {
      const authResult = db.authorizeIdTag(idTag, cp.site_id, tokenType);
      authStatus = authResult.status;
      authReason = authResult.reason;
      authTag = authResult.tag;
    }
  }

  if (authStatus !== 'Accepted') {
    if (chargepointId) {
      db.addIdTagEvent(chargepointId, null, idTag, authStatus, authReason, 'authorize');
    }
    broadcast(
      'auth_rejected',
      {
        identity,
        id_tag: idTag,
        status: authStatus,
        reason: authReason,
        source: 'authorize',
        cp_name: cp.cpname ?? null,
      },
      cp.site_id ?? null
    );
    trackRepeatedAuthReject(idTag, identity, cp);
    return buildIdTokenInfo(authStatus, authTag);
  }

  // Badge accepté sur une transaction démarrée sans identification : on le rattache
  if (!tx.id_tag) {
    const changed = db.setTransactionIdTag(cp.id, txId, idTag, tokenType);
    if (changed > 0) {
      tx.id_tag = idTag;
      logger.info(`[2.0.1] Transaction ${txId} on ${identity}: badge ${idTag} attached`);
      const tag = db.getIdTagByTag(idTag, cp.site_id);
      if (tag?.user_id) {
        const connectors = db.getConnectorsByChargepoint(cp.id);
        notifications
          .emit(
            'transaction_started',
            {
              identity,
              connector_id: tx.connector_id,
              transaction_id: txId,
              cp_name: cp.cpname ?? null,
              cn_name:
                connectors.find((c) => c.connector_id === tx.connector_id)?.connector_name ?? null,
              site_name: cp.site_name ?? null,
            },
            { userId: tag.user_id }
          )
          .catch(() => {});
      }
      if (tx.evse_id != null) {
        const reserved = db.startUsingReservationByEvseAndIdTag(cp.id, tx.evse_id, idTag);
        if (reserved > 0)
          broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
      }
    }
  }
  return buildIdTokenInfo('Accepted', authTag);
}

const initSeqVersions201 = new Map();
const pendingNotifyReportWaiters = new Map(); // clé: `${identity}_${requestId}` → resolve fn

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

// ── Réconciliation des transactions actives via GetTransactionStatus ──
// Après (re)connexion, une transaction « Active » en base peut ne plus exister côté borne
// (coupure de courant, TransactionEvent Ended jamais reçu). On interroge la borne et on ne clôture
// que si elle confirme explicitement : transaction terminée ET aucun message en attente.
const TX_RECONCILE_DELAY_MS = 30000;
const TX_RECONCILE_RETRY_MS = 60000;

async function reconcileActiveTransactions(identity, isCancelled = () => false, attempt = 0) {
  const cp = db.getChargepointByIdentity(identity);
  if (!cp || !cp.connected) return;

  const activeTxs = db.getTransactions({ chargepoint_id: cp.id, status: 'Active' }) || [];
  let hasQueuedMessages = false;

  for (const tx of activeTxs) {
    if (isCancelled()) return;

    let status;
    try {
      status = await callClient201(identity, 'GetTransactionStatus', {
        transactionId: tx.transaction_id,
      });
    } catch (e) {
      if (isDisconnectionError(e)) return;
      // Message optionnel : une borne qui ne le supporte pas ne le supportera pour aucune transaction
      logger.info(
        `[TxReconcile201] ${identity}: GetTransactionStatus non pris en charge (${e.message})`
      );
      return;
    }

    // La transaction a pu être clôturée par la borne pendant l'attente de la réponse
    const current = db.getTransactionByTransactionId(cp.id, tx.transaction_id);
    if (!current || current.status !== 'Active') continue;

    if (status?.messagesInQueue) {
      hasQueuedMessages = true; // TransactionEvent en attente d'envoi : laisser la borne les vider
      continue;
    }
    if (status?.ongoingIndicator !== false) continue; // en cours, ou réponse non concluante

    // Dernier état connu : meter_start + énergie cumulée par les MeterValues
    const meterStop = lastKnownMeterStop(current);
    db.stopTransaction(
      cp.id,
      current.transaction_id,
      meterStop,
      new Date().toISOString(),
      'Other',
      'server'
    );
    broadcast(
      'transaction_stop',
      { identity, transactionId: current.transaction_id, meterStop, reason: 'Other' },
      cp.site_id ?? null
    );
    logger.warn(
      `[TxReconcile201] ${identity}: tx ${current.transaction_id} terminée côté borne ` +
        `(GetTransactionStatus) mais jamais clôturée en base — fermée`
    );
  }

  if (hasQueuedMessages && attempt < 1) {
    const timer = setTimeout(
      () => reconcileActiveTransactions(identity, isCancelled, attempt + 1).catch(() => {}),
      TX_RECONCILE_RETRY_MS
    );
    timer.unref();
  }
}

// ── Handlers entrants (borne → CSMS) OCPP 2.0.1 ──
function register201Handlers(client, loggedHandle) {
  const identity = client.identity;
  const cpRecord = db.getChargepointByIdentity(identity);
  const chargepointId = cpRecord ? cpRecord.id : null;
  let pendingStatusAfterBootCallback = null;
  let refreshTimer = null;

  // ── BootNotification ──
  loggedHandle('BootNotification', (params) => {
    clearTimeout(refreshTimer);
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
          logger.debug(`[InitSeq201] ${identity} step 1/5 — ClearCache`);
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
            logger.debug(`[InitSeq201] ${identity} step 2/5 — ClearChargingProfile`);
            await callClient201(identity, 'ClearChargingProfile', {});
          } else {
            logger.debug(
              `[InitSeq201] ${identity} step 2/5 — skipped (${existingProfiles.length} profil(s) géré(s))`
            );
          }
        } catch (e) {
          logger.warn(`[InitSeq201] ${identity} ClearChargingProfile: ${e.message}`);
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'ClearChargingProfile';
          }
        }

        // Step 3/5 — GetBaseReport (synchronise l'état courant en DB via NotifyReport)
        if (isSuperseded()) return;
        const baseReportRequestId = Math.floor(Date.now() / 1000) % 2147483647;
        const notifyReportDone = new Promise((resolve) => {
          pendingNotifyReportWaiters.set(`${identity}_${baseReportRequestId}`, resolve);
        });
        let baseReportAccepted = false;
        try {
          logger.debug(`[InitSeq201] ${identity} step 3/5 — GetBaseReport`);
          const baseReport = await callClient201(identity, 'GetBaseReport', {
            requestId: baseReportRequestId,
            reportBase: 'FullInventory',
          });
          // Rejected / NotSupported / EmptyResultSet : aucun NotifyReport ne suivra
          baseReportAccepted = baseReport?.status === 'Accepted';
          if (!baseReportAccepted) {
            logger.warn(
              `[InitSeq201] ${identity} GetBaseReport ${baseReport?.status} — pas d'attente de NotifyReport`
            );
          }
        } catch (e) {
          logger.warn(`[InitSeq201] ${identity} GetBaseReport: ${e.message}`);
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'GetBaseReport';
          }
        }
        if (baseReportAccepted && !disconnectedDuringInit && !isSuperseded()) {
          let timeoutId;
          try {
            logger.debug(`[InitSeq201] ${identity} en attente des NotifyReport…`);
            await Promise.race([
              notifyReportDone,
              new Promise((_, reject) => {
                timeoutId = setTimeout(
                  () => reject(new Error('NotifyReport timeout (30s)')),
                  30000
                );
              }),
            ]);
          } catch (e) {
            logger.warn(`[InitSeq201] ${identity} ${e.message} — on continue`);
          } finally {
            clearTimeout(timeoutId);
          }
        }
        pendingNotifyReportWaiters.delete(`${identity}_${baseReportRequestId}`);

        // Step 4/4 — SetVariables (application des variables initiales)
        if (isSuperseded()) return;
        const vars = db.getEnabledInitialChargepointVariables();
        const rebootVars = [];
        for (const v of vars) {
          if (isSuperseded()) break;
          // Variable verrouillée (override) : la valeur globale ne l'écrase pas (l'étape 5/5
          // l'appliquera) — même règle que pour OCPP 1.6
          if (
            db.getChargepointVariableByKey(
              cpSnap.id,
              v.component,
              v.variable,
              v.attribute || 'Actual'
            )?.is_override
          ) {
            continue;
          }
          try {
            logger.debug(
              `[InitSeq201] ${identity} step 4/5 — SetVariables ${v.component}.${v.variable}`
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

        // Step 5/5 — SetVariables (ré-application des overrides locaux)
        if (!isSuperseded()) {
          const overrideVars = db.getChargepointOverrideVariables(cp.id);
          for (const v of overrideVars) {
            if (isSuperseded()) break;
            try {
              logger.debug(
                `[InitSeq201] ${identity} step 5/5 — SetVariables override ${v.component}.${v.variable}`
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
              if (setResult?.attributeStatus === 'RebootRequired')
                rebootVars.push(`${v.component}.${v.variable}`);
            } catch (e) {
              logger.warn(
                `[InitSeq201] ${identity} SetVariables override ${v.component}.${v.variable}: ${e.message}`
              );
              if (isDisconnectionError(e)) {
                disconnectedDuringInit = true;
                lastFailedStep = `SetVariables override(${v.component}.${v.variable})`;
                break;
              }
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
    const heartbeatInterval = parseHeartbeatInterval(hbConfig?.value);
    return {
      status: 'Accepted',
      interval: heartbeatInterval,
      currentTime: new Date().toISOString(),
    };
  });

  // ── Heartbeat ──
  loggedHandle('Heartbeat', (_params) => {
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
        const activeTx = db.getActiveTransactionByConnector(cp.id, connectorDbId, evseId);
        if (activeTx?.charging_state) {
          cnstatus = CHARGING_STATE_TO_CNSTATUS[activeTx.charging_state] || cnstatus;
        }

        // Plug&Charge mode 2 : déclencher RequestStartTransaction automatiquement, mais seulement
        // sur un NOUVEAU branchement. En 2.0.1 « Occupied » couvre aussi le câble resté branché
        // après la fin d'une session (équivalent du Finishing 1.6) : redémarrer là rendrait
        // impossible l'arrêt d'une recharge (arrêt → Occupied → redémarrage).
        if (cp.mode === 2 && evseId > 0 && !activeTx && isNewPlugIn(previousStatus)) {
          const idTag = `MGR-${cp.site_id}`;
          if (!db.getIdTagByTag(idTag)) {
            db.createIdTag(idTag, null, cp.site_id, `Tag manager site ${cp.site_id} auto`, null, 0);
          }
          // Démarrage mémorisé avec son badge et son remoteStartId (voir remoteStarts.js)
          const remoteStartId = Math.floor(Math.random() * 2147483647);
          const pendingKey = registerPendingRemoteStart(
            pendingRemoteStarts,
            identity,
            connectorDbId,
            { source: 'remote', userId: null, idTag, remoteStartId }
          );

          callClient201(identity, 'RequestStartTransaction', {
            remoteStartId,
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

      if (cp.cpstatus === 'Unavailable' || cp.cpstatus === 'Planned' || cp.cpstatus === null) {
        const allConnectors = db.getConnectorsByChargepoint(cp.id);
        const derivedStatus = allConnectors.some((c) => c.cnstatus !== 'Unavailable')
          ? 'Available'
          : 'Unavailable';
        db.updateChargepointStatus(identity, derivedStatus, true);
      }

      // Gestion des réservations
      if (cnstatus === 'Reserved') {
        db.activateReservationByEvse(cp.id, evseId);
        broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
      } else if (cnstatus === 'Charging') {
        const activeTx = db.getActiveTransactionByConnector(cp.id, connectorDbId, evseId);
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

      // Transaction orpheline : borne redevenue Available sans TransactionEvent Ended
      const activeTx = db
        .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
        .find(
          (t) => t.connector_id === connectorDbId && (t.evse_id == null || t.evse_id === evseId)
        );
      if (activeTx && cnstatus === 'Available') {
        // Clôture heuristique (closed_by = server) : un TransactionEvent(Ended) réel arrivant
        // ensuite (ordre non garanti, file hors ligne) corrige la session
        db.stopTransaction(
          cp.id,
          activeTx.transaction_id,
          lastKnownMeterStop(activeTx),
          params.timestamp || new Date().toISOString(),
          'EVDisconnected',
          'server'
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

    if (isGeneratedTag(idTag)) {
      // Borne avec AuthorizeRemoteStart=true : elle fait autoriser le badge d'un démarrage à
      // distance avant de démarrer. Un badge généré (ADMIN / MGR-x / WEB-x) n'est accepté que
      // si un démarrage à distance avec CE badge est en attente sur CETTE borne.
      if (findPendingRemoteStart(pendingRemoteStarts, identity, { idTag })) {
        logger.info(
          `[2.0.1] Authorize ${identity}: generated badge accepted (pending remote start)`
        );
        return { idTokenInfo: { status: 'Accepted' } };
      }
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
    return { idTokenInfo: buildIdTokenInfo(authResult.status, authResult.tag) };
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
      // Démarrage à distance : la spec corrèle le Started à la demande par
      // transactionInfo.remoteStartId ; le triggerReason n'est pas toujours RemoteStart (ex.
      // TxStartPoint=PowerPathClosed → ChargingStateChanged). Un démarrage à distance en attente
      // avec ce badge sur cette borne compte aussi.
      const remoteStartId = transactionInfo.remoteStartId ?? null;
      const pending = findPendingRemoteStart(pendingRemoteStarts, identity, {
        idTag,
        remoteStartId,
      });
      const isRemoteStart = triggerReason === 'RemoteStart' || remoteStartId != null || !!pending;
      const startSource = isRemoteStart
        ? pending?.entry.source || 'remote'
        : TRIGGER_TO_START_SOURCE[triggerReason] || 'rfid';

      let authStatus = 'Accepted';
      let authReason = null;
      let authTag = null;
      if (cp && cp.mode === 1 && startSource === 'rfid') {
        if (isGeneratedTag(idTag)) {
          authStatus = 'Blocked';
          authReason = 'auto_tag_rfid';
        } else {
          const authResult = db.authorizeIdTag(idTag, cp.site_id, idToken?.type || null);
          authStatus = authResult.status;
          authReason = authResult.reason;
          authTag = authResult.tag;
        }
      }

      // Retransmission : sans réponse dans le délai, la borne renvoie le même Started
      // (MessageAttempts). La transaction existe déjà POUR CETTE BORNE (le transactionId 2.0.1
      // n'est unique que par borne) : réponse idempotente, sans la clore comme « orpheline »
      // ni la recréer. Une transaction refusée reste refusée.
      const existing = cp && txId ? db.getTransactionByTransactionId(cp.id, txId) : null;
      if (existing) {
        logger.warn(
          `[2.0.1] TransactionEvent Started: txId=${txId} already known on ${identity} (retransmission) — ignored`
        );
        if (existing.status === 'Rejected') {
          return {
            idTokenInfo: buildIdTokenInfo(
              authStatus !== 'Accepted' ? authStatus : 'Invalid',
              authTag
            ),
          };
        }
        return { idTokenInfo: buildIdTokenInfo('Accepted', null) };
      }

      if (authStatus !== 'Accepted') {
        // La borne a déjà démarré la transaction et continuera à envoyer Updated/Ended avec ce
        // transactionId : on l'enregistre (statut Rejected, jamais facturée) pour que ces
        // messages la retrouvent au lieu de toucher la transaction d'un autre EVSE
        if (cp && txId) {
          db.createTransaction(
            cp.id,
            connectorDbId,
            idTag,
            extractMeterEnergy(meterValue, 'first') ?? 0,
            timestamp,
            startSource,
            {
              transactionId: txId,
              evse_id: evseId,
              id_token_type: idToken?.type || 'ISO14443',
              status: 'Rejected',
            }
          );
          logger.warn(
            `[2.0.1] TransactionEvent Started refused (${authStatus}) on ${identity} EVSE#${evseId}: transaction ${txId} recorded as Rejected`
          );
        }
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
        return { idTokenInfo: buildIdTokenInfo(authStatus, authTag) };
      }

      if (cp) {
        const meterStart = extractMeterEnergy(meterValue, 'first') ?? 0;
        if (pending) pendingRemoteStarts.delete(pending.key);

        // Fermer les transactions orphelines sur le même connecteur DU MÊME EVSE (les
        // connectorId sont numérotés par EVSE : le connecteur 1 de l'EVSE 2 n'est pas celui de l'EVSE 1)
        const orphans = db
          .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
          .filter(
            (t) =>
              t.connector_id === connectorDbId &&
              (evseId == null || t.evse_id == null || t.evse_id === evseId)
          );
        for (const orphan of orphans) {
          // Le compteur au démarrage de la nouvelle session borne la précédente ; sinon dernier relevé connu
          const orphanMeterStop =
            meterStart > 0 && meterStart >= (orphan.meter_start ?? 0)
              ? meterStart
              : lastKnownMeterStop(orphan);
          // Clôture heuristique : un Ended réel arrivant ensuite corrige la session
          db.stopTransaction(
            cp.id,
            orphan.transaction_id,
            orphanMeterStop,
            timestamp,
            'Other',
            'server'
          );
          broadcast(
            'transaction_stop',
            { identity, transactionId: orphan.transaction_id, reason: 'Other' },
            cp.site_id ?? null
          );
          logger.warn(
            `[2.0.1] TransactionEvent Started: closed orphan ${orphan.transaction_id} on ${identity} EVSE#${evseId}`
          );
        }

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

      return { idTokenInfo: buildIdTokenInfo('Accepted', authTag) };
    }

    // ── Updated ──
    if (eventType === 'Updated') {
      if (!cp || !txId) return {};
      let tx = db.getTransactionByTransactionId(cp.id, txId);
      if (!tx) {
        // Repli (ex. base restaurée) seulement si l'EVSE est connu : `evse` est facultatif après
        // le premier événement, et sans lui le connecteur 1 désignerait n'importe quel EVSE
        const activeTx =
          evseId != null ? db.getActiveTransactionByConnector(cp.id, connectorDbId, evseId) : null;
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
      // Session close par une heuristique du serveur : des Updated mis en file pendant une
      // coupure peuvent encore arriver avant l'Ended réel. Leurs relevés sont gardés pour le
      // graphe (et la répartition du coût par tranche quand l'Ended corrigera la session).
      const isActive = tx.status === 'Active';
      const serverClosed = tx.status === 'Completed' && tx.closed_by === 'server';
      if (!isActive && !serverClosed) {
        logger.warn(
          `[2.0.1] TransactionEvent Updated pour transaction clôturée ${txId} depuis ${identity} — ignorés`
        );
        return {};
      }

      // Badge présenté en cours de transaction : contrôle + rattachement, réponse idTokenInfo.
      // Démarrage à distance « câble branché d'abord » (F02) : Updated(RemoteStart,
      // remoteStartId) avec le badge de la demande → accepté sans contrôle.
      let idTokenInfo = null;
      if (isActive && idToken?.idToken) {
        const remoteStartId = transactionInfo.remoteStartId ?? null;
        const pending = findPendingRemoteStart(pendingRemoteStarts, identity, {
          idTag: idToken.idToken,
          remoteStartId,
        });
        const isRemoteStart = triggerReason === 'RemoteStart' || remoteStartId != null || !!pending;
        if (pending) pendingRemoteStarts.delete(pending.key);
        idTokenInfo = evaluateIdTokenOnUpdate({
          cp,
          tx,
          txId,
          idToken,
          identity,
          chargepointId,
          isRemoteStart,
        });
      }

      const chargingState = isActive ? transactionInfo.chargingState || null : null;
      if (chargingState) {
        db.updateTransactionChargingState(cp.id, txId, chargingState);
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

        if (isActive) {
          if (powerW !== null) lastPowerW = powerW;
          if (energyWh !== null) {
            lastEnergyWh = energyWh;
            // `evse` est optionnel après le premier événement : repli sur l'EVSE de la transaction
            const meterEvseId = evseId ?? tx.evse_id ?? null;
            if (meterEvseId !== null) db.updateEvseMeterValue(cp.id, meterEvseId, energyWh);
          }

          db.updateTransactionPowerEnergy(
            cp.id,
            txId,
            powerW !== null ? Math.round(powerW) : null,
            energyWh !== null ? Math.round(energyWh) : null
          );
        }

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
          if (Object.keys(tvData).length > 0) db.upsertTransactionValues(cp.id, txId, tvData);
        }
      }

      if (!isActive) {
        logger.info(
          `[2.0.1] TransactionEvent Updated for transaction ${txId} closed by the server on ${identity} — meter values kept for the chart`
        );
        return {};
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
      return idTokenInfo ? { idTokenInfo } : {};
    }

    // ── Ended ──
    if (eventType === 'Ended') {
      logger.info(`[2.0.1] TransactionEvent Ended from ${identity} txId=${txId}`);
      if (!txId || !cp) return {};

      // Un Ended porte souvent plusieurs relevés (Transaction.Begin … Transaction.End) :
      // le compteur d'arrêt est le dernier / Transaction.End, pas le premier
      let meterStop = extractMeterEnergy(meterValue, 'last');
      const stopReason = resolveStopReason201(transactionInfo, triggerReason);

      // Corriger meterStop si la borne envoie une valeur <= meter_start alors que de l'énergie a été consommée
      const preTx = db.getTransactionByTransactionId(cp.id, txId);
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

      // Transaction refusée au Started : on garde l'énergie délivrée, sans facturation ni
      // notification
      if (preTx?.status === 'Rejected') {
        db.stopRejectedTransaction(cp.id, txId, meterStop, timestamp, stopReason);
        logger.info(
          `[2.0.1] TransactionEvent Ended for rejected transaction ${txId} on ${identity}`
        );
        return {};
      }

      // Déjà close : retransmission (rien à faire) ou clôture heuristique du serveur que l'Ended
      // réel corrige (compteur, heure, raison, coût) — sans nouvelle notification
      if (preTx?.status === 'Completed') {
        const corrected =
          preTx.closed_by === 'server'
            ? db.correctServerClosedTransaction(cp.id, txId, meterStop, timestamp, stopReason)
            : null;
        if (corrected) {
          logger.warn(
            `[2.0.1] TransactionEvent Ended ${txId} on ${identity}: transaction closed by the server ` +
              `corrected with the real stop (meter ${preTx.meter_stop} → ${corrected.meter_stop})`
          );
          if (corrected.meter_stop != null && corrected.evse_id != null) {
            db.updateEvseMeterValue(cp.id, corrected.evse_id, corrected.meter_stop);
          }
          broadcast(
            'transaction_stop',
            {
              identity,
              transactionId: corrected.transaction_id,
              meterStop: corrected.meter_stop,
              reason: corrected.stop_reason,
            },
            cp.site_id ?? null
          );
        } else {
          logger.info(
            `[2.0.1] TransactionEvent Ended ${txId} on ${identity}: transaction already closed — ignored`
          );
        }
        return {};
      }

      let stoppedTx = null;
      let closed = false;
      if (preTx) {
        ({ tx: stoppedTx, closed } = db.stopTransaction(
          cp.id,
          txId,
          meterStop,
          timestamp,
          stopReason
        ));
      } else if (evseId != null) {
        // Fallback : transactionId inconnu (ex. base restaurée) → on ne ferme une transaction
        // active que sans ambiguïté : une seule candidate SUR LE MÊME EVSE. Sans `evse` (facultatif
        // après le premier événement), aucun repli : on couperait la recharge d'un autre EVSE.
        const activeTxs = db.getTransactions({ chargepoint_id: cp.id, status: 'Active' });
        const activeTx = pickRecoveryCandidate(activeTxs, { evseId });
        if (activeTx) {
          ({ tx: stoppedTx, closed } = db.stopTransaction(
            cp.id,
            activeTx.transaction_id,
            meterStop,
            timestamp,
            stopReason || 'Other'
          ));
          logger.warn(
            `[2.0.1] [Recovery] TransactionEvent Ended txId inconnu ${txId} sur ${identity}, ` +
              `tx ${activeTx.transaction_id} fermée (seule transaction active compatible)`
          );
        } else {
          logger.warn(
            `[2.0.1] [Recovery] TransactionEvent Ended txId inconnu ${txId} sur ${identity} ignoré ` +
              `(${activeTxs.length} tx active(s), pas de repli sans ambiguïté)`
          );
        }
      }

      // Notifications et diffusion uniquement si une transaction active vient réellement d'être
      // close (un Ended retransmis ne renotifie pas)
      if (!stoppedTx || !closed) {
        logger.warn(
          `[2.0.1] TransactionEvent Ended txId=${txId} sur ${identity} ignoré : aucune transaction active trouvée`
        );
        return {};
      }
      const resolvedTransactionId = stoppedTx.transaction_id;
      broadcast(
        'transaction_stop',
        { identity, transactionId: resolvedTransactionId, meterStop, reason: stopReason },
        cp.site_id ?? null
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
      const instance = reportData.variable?.instance || '';
      const evseId = reportData.component?.evse?.id ?? 0;
      const connectorId = reportData.component?.evse?.connectorId ?? 0;
      for (const attrProp of reportData.variableAttribute || []) {
        const attribute = attrProp.type || 'Actual';
        const value = attrProp.value ?? null;
        const readonly = attrProp.mutability === 'ReadOnly' ? 1 : 0;
        db.upsertChargepointVariable(
          cp.id,
          component,
          variable,
          attribute,
          value,
          readonly,
          instance,
          evseId,
          connectorId
        );
      }
    }

    if (!params.tbc) {
      db.updateChargepointFeatures201(cp.id);
      broadcast('config_refreshed', { chargepointId: cp.id, identity }, cp.site_id ?? null);
      logger.info(`[2.0.1] NotifyReport complete for ${identity}`);
      const waiterKey = `${identity}_${params.requestId}`;
      const resolve = pendingNotifyReportWaiters.get(waiterKey);
      if (resolve) {
        pendingNotifyReportWaiters.delete(waiterKey);
        resolve();
      }
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
  // Aucune extension constructeur n'est implémentée côté CSMS : spec 2.0.1 (P01/P02)
  // → UnknownVendorId quand le vendorId n'est pas reconnu
  loggedHandle('DataTransfer', (_params) => {
    return { status: 'UnknownVendorId' };
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

  // ── Messages non exploités par le CSMS : réponse conforme au schéma plutôt que CALLERROR ──
  // Smart charging : informatifs (le CSMS ne pilote pas ces flux), acquittement simple
  for (const action of ['NotifyChargingLimit', 'ClearedChargingLimit', 'ReportChargingProfiles']) {
    loggedHandle(action, () => ({}));
  }

  // Notifications de rapports que le CSMS ne demande jamais (CustomerInformation, monitoring,
  // affichages, PublishFirmware) : une borne qui les envoie reçoit l'acquittement du schéma
  // plutôt qu'un CALLERROR NotImplemented
  for (const action of [
    'NotifyCustomerInformation',
    'NotifyDisplayMessages',
    'NotifyMonitoringReport',
    'PublishFirmwareStatusNotification',
  ]) {
    loggedHandle(action, () => ({}));
  }

  // ISO 15118 / Plug&Charge et renouvellement de certificat par OCPP : non supportés
  // (la CA est gérée à la main) → refus explicite
  loggedHandle('NotifyEVChargingNeeds', () => ({ status: 'Rejected' }));
  loggedHandle('NotifyEVChargingSchedule', () => ({ status: 'Rejected' }));
  loggedHandle('SignCertificate', () => ({ status: 'Rejected' }));
  loggedHandle('GetCertificateStatus', () => ({ status: 'Failed' }));
  loggedHandle('Get15118EVCertificate', () => ({ status: 'Failed', exiResponse: '' }));

  // Après connexion : vérifier auprès de la borne que les transactions « Active » existent encore
  if (cpRecord) {
    let reconcileCancelled = false;
    const reconcileTimer = setTimeout(() => {
      reconcileActiveTransactions(identity, () => reconcileCancelled).catch((e) =>
        logger.warn(`[TxReconcile201] ${identity}: ${e.message}`)
      );
    }, TX_RECONCILE_DELAY_MS);
    reconcileTimer.unref();

    client.once('close', () => {
      clearTimeout(reconcileTimer);
      reconcileCancelled = true;
    });
  }

  // Après reconnexion sans BootNotification : demander à la borne de renvoyer son état
  if (cpRecord && cpRecord.initialized) {
    let cancelled = false;
    refreshTimer = setTimeout(async () => {
      const current = db.getChargepointByIdentity(identity);
      if (!current || !current.connected || current.cpstatus) return;

      logger.info(
        `[StateRefresh201] ${identity}: reconnecté sans BootNotification, envoi TriggerMessage`
      );
      const waitUnref = (ms) =>
        new Promise((r) => {
          const t = setTimeout(r, ms);
          t.unref();
        });

      // BootNotification : exception = WS cassé → bail out ; Rejected = état transitoire → retry
      let bootResult;
      try {
        bootResult = await callClient201(identity, 'TriggerMessage', {
          requestedMessage: 'BootNotification',
        });
      } catch (e) {
        logger.warn(
          `[StateRefresh201] ${identity}: TriggerMessage(BootNotification) échoué: ${e.message}`
        );
        return;
      }

      if (bootResult?.status !== 'Accepted') {
        logger.info(
          `[StateRefresh201] ${identity}: TriggerMessage(BootNotification) ${bootResult?.status} — retry dans 15s`
        );
        await waitUnref(15000);
        if (cancelled) return;
        if (!db.getChargepointByIdentity(identity)?.connected) return;
        try {
          bootResult = await callClient201(identity, 'TriggerMessage', {
            requestedMessage: 'BootNotification',
          });
        } catch (e) {
          logger.warn(
            `[StateRefresh201] ${identity}: TriggerMessage(BootNotification) retry échoué: ${e.message}`
          );
          return;
        }
      }

      const skipStatusWait = bootResult?.status !== 'Accepted';
      if (skipStatusWait) {
        logger.info(
          `[StateRefresh201] ${identity}: TriggerMessage(BootNotification) ${bootResult?.status} — skip attente StatusNotification`
        );
      }

      if (!skipStatusWait) {
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
      }

      if (!db.getChargepointByIdentity(identity)?.connected) return;

      // StatusNotification : exceptions catchées, retry sur Rejected
      const tryStatus = async () => {
        try {
          return await callClient201(identity, 'TriggerMessage', {
            requestedMessage: 'StatusNotification',
          });
        } catch (e) {
          logger.warn(
            `[StateRefresh201] ${identity}: TriggerMessage(StatusNotification) échoué: ${e.message}`
          );
          return null;
        }
      };

      const statusResult = await tryStatus();
      if (statusResult?.status !== 'Accepted') {
        logger.info(
          `[StateRefresh201] ${identity}: TriggerMessage(StatusNotification) ${statusResult?.status} — retry dans 15s`
        );
        await waitUnref(15000);
        if (cancelled) return;
        if (!db.getChargepointByIdentity(identity)?.connected) return;
        await tryStatus();
      }
    }, 20000);
    refreshTimer.unref();

    client.once('close', () => {
      clearTimeout(refreshTimer);
      cancelled = true;
    });
  }
}

// ── Enregistrement au chargement du module ──
registerHandlersFn('2.0.1', register201Handlers);
registerCallClientImpl('2.0.1', callClient201);

module.exports = { register201Handlers, callClient201 };
