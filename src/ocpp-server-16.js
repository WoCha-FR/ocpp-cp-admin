const db = require('./database');
const notifications = require('./notifications');
const logger = require('./logger').scope('OCPP');
const {
  broadcast,
  getConnectedClients,
  pendingRemoteStarts,
  trackRepeatedAuthReject,
  registerCallClientImpl,
  registerHandlersFn,
  checkConnectorErrorCooldown,
  debounceAvailabilityNotif,
} = require('./ocpp-common');

const OCPP16_STANDARD_KEYS = [
  'AllowOfflineTxForUnknownId',
  'AuthorizationCacheEnabled',
  'AuthorizeRemoteTxRequests',
  'BlinkRepeat',
  'ClockAlignedDataInterval',
  'ConnectionTimeOut',
  'ConnectorPhaseRotation',
  'ConnectorPhaseRotationMaxLength',
  'HeartbeatInterval',
  'LightIntensity',
  'LocalAuthorizeOffline',
  'LocalPreAuthorize',
  'MaxEnergyOnInvalidId',
  'MeterValuesAlignedData',
  'MeterValuesAlignedDataMaxLength',
  'MeterValuesSampledData',
  'MeterValuesSampledDataMaxLength',
  'MeterValueSampleInterval',
  'MinimumStatusDuration',
  'NumberOfConnectors',
  'ResetRetries',
  'StopTransactionOnEVSideDisconnect',
  'StopTransactionOnInvalidId',
  'StopTxnAlignedData',
  'StopTxnAlignedDataMaxLength',
  'StopTxnSampledData',
  'StopTxnSampledDataMaxLength',
  'SupportedFeatureProfiles',
  'TransactionMessageAttempts',
  'TransactionMessageRetryInterval',
  'UnlockConnectorOnEVSideDisconnect',
  'WebSocketPingInterval',
  'ChargeProfileMaxStackLevel',
  'ChargingScheduleAllowedChargingRateUnit',
  'ChargingScheduleMaxPeriods',
  'ConnectorSwitch3to1PhaseSupported',
  'MaxChargingProfilesInstalled',
  'LocalAuthListEnabled',
  'LocalAuthListMaxLength',
  'SendLocalListMaxLength',
  'ReserveConnectorZeroSupported',
];

const OCPP16_CONNECTOR_STATUSES = new Set([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);

const OCPP16_ERROR_CODES = new Set([
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'StrongRiderFailure',
  'UnderVoltage',
  'WeakSignal',
]);

const initSeqVersions = new Map();

function ocppStatusToChargingState(status) {
  const map = {
    Charging: 'Charging',
    SuspendedEV: 'SuspendedEV',
    SuspendedEVSE: 'SuspendedEVSE',
    Finishing: 'EVConnected',
    Preparing: 'EVConnected',
  };
  return map[status] ?? null;
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

function sanitizeEnum(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback;
  return allowed.has(value) ? value : fallback;
}

// ── Commandes CSMS → borne (OCPP 1.6) ──
async function callClient16(identity, method, params) {
  const client = getConnectedClients().get(identity);
  if (!client) throw new Error(`Chargepoint ${identity} not connected`);

  const cp = db.getChargepointByIdentity(identity);
  const cpId = cp ? cp.id : null;

  if (cpId) db.addOcppMessage(cpId, 'csms', 'CALL', method, params);
  broadcast(
    'ocpp_message',
    {
      identity,
      origin: 'csms',
      message_type: 'CALL',
      action: method,
      payload: params,
    },
    cp?.site_id ?? null
  );
  logger.info(`Calling ${method} on ${identity} with params: ${JSON.stringify(params)}`);

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
    logger.warn(`Error response for ${method} from ${identity}: ${err.message}`);
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
  logger.debug(`Received response for ${method} from ${identity}: ${JSON.stringify(result)}`);

  if (method === 'GetConfiguration' && result && result.configurationKey) {
    if (cp) {
      db.bulkUpsertChargepointConfig(cp.id, result.configurationKey);
      broadcast(
        'chargepoint_config_update',
        { identity, chargepointId: cp.id },
        cp.site_id ?? null
      );
    }
  }

  return result;
}

function isDisconnectionError(e) {
  const msg = e.message || '';
  return (
    msg.includes('not connected') ||
    msg.toLowerCase().includes('disconnected') ||
    msg.includes('going away') ||
    msg.includes('socket not open')
  );
}

// ── Handlers entrants (borne → CSMS) OCPP 1.6 ──
function register16Handlers(client, loggedHandle) {
  const identity = client.identity;
  const cpRecord = db.getChargepointByIdentity(identity);
  const chargepointId = cpRecord ? cpRecord.id : null;
  let pendingStatusAfterBootCallback = null;
  let refreshTimer = null;

  // ── BootNotification ──
  loggedHandle('BootNotification', (params) => {
    clearTimeout(refreshTimer);
    const safeVendor = sanitizeText(params.chargePointVendor, 25);
    const safeModel = sanitizeText(params.chargePointModel, 20);
    const safeSerial = sanitizeText(params.chargePointSerialNumber, 25);
    const safeFirmware = sanitizeText(params.firmwareVersion, 50);
    const safeIccid = sanitizeText(params.iccid, 20);
    const safeImsi = sanitizeText(params.imsi, 20);
    const safeMeterSn = sanitizeText(params.meterSerialNumber, 25);
    const safeMeterType = sanitizeText(params.meterType, 25);

    db.upsertChargepoint(identity, {
      vendor: safeVendor,
      model: safeModel,
      serial_number: safeSerial,
      firmware_version: safeFirmware,
      iccid: safeIccid,
      imsi: safeImsi,
      meter_sn: safeMeterSn,
      meter_type: safeMeterType,
      cpstatus: 'Available',
      connected: 1,
    });

    const cp = db.getChargepointByIdentity(identity);
    broadcast('chargepoint_update', cp, cp?.site_id ?? null);

    const seqVersion = (initSeqVersions.get(identity) || 0) + 1;
    initSeqVersions.set(identity, seqVersion);

    setImmediate(
      async (cp, seqVersion) => {
        if (!cp || cp.initialized) return;

        const isSuperseded = () => initSeqVersions.get(identity) !== seqVersion;

        let disconnectedDuringInit = false;
        let lastFailedStep = null;

        // Step 1/5 — ClearCache
        if (isSuperseded()) return;
        try {
          logger.debug(`[InitSeq] ${identity} step 1/5 — ClearCache`);
          await callClient16(identity, 'ClearCache', {});
        } catch (e) {
          logger.warn(`[InitSeq] ${identity} ClearCache: ${e.message}`);
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'ClearCache';
          }
        }

        // Step 2/5 — ClearChargingProfile
        if (isSuperseded()) return;
        try {
          const existingProfiles = db.getChargingProfiles(cp.id);
          if (existingProfiles.length === 0) {
            logger.debug(`[InitSeq] ${identity} step 2/5 — ClearChargingProfile`);
            await callClient16(identity, 'ClearChargingProfile', {});
          } else {
            logger.debug(
              `[InitSeq] ${identity} step 2/5 — skipped (${existingProfiles.length} managed profile(s))`
            );
          }
        } catch (e) {
          logger.warn(`[InitSeq] ${identity} ClearChargingProfile: ${e.message}`);
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'ClearChargingProfile';
          }
        }

        // Step 3/5 — GetConfiguration
        if (isSuperseded()) return;
        try {
          logger.debug(`[InitSeq] ${identity} step 3/5 — GetConfiguration (all keys)`);
          await callClient16(identity, 'GetConfiguration', {});
        } catch (e) {
          logger.warn(
            `[InitSeq] ${identity} GetConfiguration (all keys): ${e.message} — falling back to paginated`
          );
          if (isDisconnectionError(e)) {
            disconnectedDuringInit = true;
            lastFailedStep = 'GetConfiguration';
          }

          if (!isSuperseded()) {
            let maxKeys = 20;
            try {
              const res = await callClient16(identity, 'GetConfiguration', {
                key: ['GetConfigurationMaxKeys'],
              });
              const parsed = parseInt(res?.configurationKey?.[0]?.value, 10);
              if (parsed > 0) maxKeys = parsed;
            } catch (e2) {
              logger.warn(
                `[InitSeq] ${identity} GetConfigurationMaxKeys: ${e2.message} — using default ${maxKeys}`
              );
              if (isDisconnectionError(e2)) {
                disconnectedDuringInit = true;
                lastFailedStep = lastFailedStep ?? 'GetConfiguration';
              }
            }

            logger.debug(
              `[InitSeq] ${identity} GetConfiguration paginated (maxKeys=${maxKeys}, total=${OCPP16_STANDARD_KEYS.length})`
            );
            for (let i = 0; i < OCPP16_STANDARD_KEYS.length; i += maxKeys) {
              if (isSuperseded()) break;
              const chunk = OCPP16_STANDARD_KEYS.slice(i, i + maxKeys);
              try {
                await callClient16(identity, 'GetConfiguration', { key: chunk });
              } catch (e2) {
                logger.warn(
                  `[InitSeq] ${identity} GetConfiguration chunk [${i}..${i + maxKeys - 1}]: ${e2.message}`
                );
                if (isDisconnectionError(e2)) {
                  disconnectedDuringInit = true;
                  lastFailedStep = lastFailedStep ?? 'GetConfiguration';
                }
              }
            }
          }
        }

        // Step 4/5 — ChangeConfiguration (global defaults)
        if (isSuperseded()) return;
        const globals = db.getEnabledInitialChargepointConfig();
        const rebootKeys = [];
        const rejectedKeys = [];
        const notSupportedKeys = [];
        for (const cfg of globals) {
          if (isSuperseded()) break;
          const current = db.getChargepointConfigByKey(cp.id, cfg.key);
          if (current?.is_override) continue;
          if (current?.value === cfg.value) continue;
          try {
            logger.debug(`[InitSeq] ${identity} step 4/5 — ChangeConfiguration ${cfg.key}`);
            const result = await callClient16(identity, 'ChangeConfiguration', {
              key: cfg.key,
              value: cfg.value,
            });
            if (result?.status === 'Accepted' || result?.status === 'RebootRequired') {
              db.upsertChargepointConfig(cp.id, cfg.key, cfg.value, false);
              if (result.status === 'RebootRequired') {
                logger.warn(`[InitSeq] ${identity} ChangeConfiguration ${cfg.key}: RebootRequired`);
                rebootKeys.push(cfg.key);
              }
            } else if (result.status === 'Rejected') {
              logger.warn(`[InitSeq] ${identity} ChangeConfiguration ${cfg.key}: Rejected`);
              rejectedKeys.push(cfg.key);
            } else {
              logger.warn(`[InitSeq] ${identity} ChangeConfiguration ${cfg.key}: NotSupported`);
              notSupportedKeys.push(cfg.key);
            }
          } catch (e) {
            logger.warn(`[InitSeq] ${identity} ChangeConfiguration ${cfg.key}: ${e.message}`);
            if (isDisconnectionError(e)) {
              disconnectedDuringInit = true;
              lastFailedStep = lastFailedStep ?? `ChangeConfiguration(${cfg.key})`;
            }
          }
        }

        // Step 5/5 — ChangeConfiguration (override configs)
        if (isSuperseded()) return;
        const overrideConfigs = db.getChargepointOverrideConfigs(cp.id);
        for (const cfg of overrideConfigs) {
          if (isSuperseded()) break;
          const current = db.getChargepointConfigByKey(cp.id, cfg.key);
          if (current?.value === cfg.value) continue;
          try {
            logger.debug(
              `[InitSeq] ${identity} step 5/5 — ChangeConfiguration override ${cfg.key}`
            );
            const result = await callClient16(identity, 'ChangeConfiguration', {
              key: cfg.key,
              value: cfg.value,
            });
            if (result?.status === 'RebootRequired') {
              rebootKeys.push(cfg.key);
            } else if (result?.status !== 'Accepted') {
              logger.warn(
                `[InitSeq] ${identity} Locked ChangeConfiguration ${cfg.key}: ${result?.status}`
              );
            }
          } catch (e) {
            logger.warn(
              `[InitSeq] ${identity} Locked ChangeConfiguration ${cfg.key}: ${e.message}`
            );
            if (isDisconnectionError(e)) {
              disconnectedDuringInit = true;
              lastFailedStep = lastFailedStep ?? `ChangeConfiguration(${cfg.key})`;
            }
          }
        }

        if (isSuperseded()) return;

        if (disconnectedDuringInit) {
          logger.warn(
            `[InitSeq] ${identity} initialization interrupted at step "${lastFailedStep}" — will retry on reconnect`
          );
          return;
        }

        if (rebootKeys.length > 0 || rejectedKeys.length > 0 || notSupportedKeys.length > 0) {
          notifications
            .emit('init_config_result', { identity, rebootKeys, rejectedKeys, notSupportedKeys })
            .catch(() => {});
        }

        db.markChargepointInitialized(cp.id);
        logger.debug(`[InitSeq] ${identity} initialization sequence completed`);
      },
      cp,
      seqVersion
    );

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
  loggedHandle('StatusNotification', (params) => {
    if (pendingStatusAfterBootCallback) {
      pendingStatusAfterBootCallback();
      pendingStatusAfterBootCallback = null;
    }
    const cp = db.getChargepointByIdentity(identity);
    if (cp) {
      const safeStatus = sanitizeEnum(params.status, OCPP16_CONNECTOR_STATUSES, 'Unavailable');
      const safeErrorCode = sanitizeEnum(params.errorCode, OCPP16_ERROR_CODES, 'OtherError');
      const safeInfo = sanitizeText(params.info, 255);
      const safeVendorId = sanitizeText(params.vendorId, 255);
      const safeVendorErrorCode = sanitizeText(params.vendorErrorCode, 255);

      if (params.connectorId === 0) {
        db.updateChargepointStatus(identity, safeStatus, true, {
          error_code: safeErrorCode,
          error_info: safeInfo,
          vendor_id: safeVendorId,
          vendor_error_code: safeVendorErrorCode,
        });
        db.upsertChargepoint(identity, { has_connector0: 1 });
      }
      const existingConnector = db.getConnectorByChargepointAndId(cp.id, params.connectorId);
      const previousStatus = existingConnector?.cnstatus || null;
      db.upsertConnector(
        cp.id,
        params.connectorId,
        safeStatus,
        safeErrorCode,
        safeInfo,
        safeVendorId,
        safeVendorErrorCode,
        null,
        safeStatus
      );
      if (params.connectorId !== 0) {
        if (safeStatus === 'Reserved') {
          db.activateReservationByConnector(cp.id, params.connectorId);
          broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
        } else if (['Charging', 'SuspendedEV', 'SuspendedEVSE'].includes(safeStatus)) {
          const activeTx = db.getActiveTransactionByConnector(cp.id, params.connectorId);
          if (activeTx) {
            const changed = db.startUsingReservationByConnectorAndIdTag(
              cp.id,
              params.connectorId,
              activeTx.id_tag
            );
            if (changed > 0)
              broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
          }
        } else if (['Available', 'Faulted', 'Unavailable'].includes(safeStatus)) {
          db.expireActiveReservationByConnector(cp.id, params.connectorId);
          db.fulfillInUseReservationByConnector(cp.id, params.connectorId);
          broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
        }
        if (cp.cpstatus === 'Unavailable') {
          const allConnectors = db.getConnectorsByChargepoint(cp.id);
          const derivedStatus = allConnectors.some((c) => c.cnstatus !== 'Unavailable')
            ? 'Available'
            : 'Unavailable';
          db.updateChargepointStatus(identity, derivedStatus, true);
        } else {
          db.updateChargepointStatus(identity, undefined, true);
        }
        const activeTx = db
          .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
          .find((t) => t.connector_id === params.connectorId);
        if (activeTx) {
          if (safeStatus === 'Available') {
            // Borne revenue Available sans StopTransaction — fermer la transaction orpheline
            db.stopTransaction(
              activeTx.transaction_id,
              activeTx.meter_start || 0,
              params.timestamp || new Date().toISOString(),
              'EVDisconnected'
            );
            broadcast(
              'transaction_stop',
              {
                identity,
                transactionId: activeTx.transaction_id,
                reason: 'EVDisconnected',
              },
              cp.site_id ?? null
            );
            logger.warn(
              `StatusNotification: closed orphan transaction ${activeTx.transaction_id} on ${identity} #${params.connectorId} (no StopTransaction received)`
            );
          } else {
            const chargingState = ocppStatusToChargingState(safeStatus);
            if (chargingState !== null) {
              db.updateTransactionChargingState(activeTx.transaction_id, chargingState);
              broadcast(
                'transaction_updated',
                {
                  identity,
                  connectorId: params.connectorId,
                  transactionId: activeTx.transaction_id,
                  charging_state: chargingState,
                },
                cp.site_id ?? null
              );
            }
          }
        }
      }
      const updatedCp = db.getChargepointByIdentity(identity);
      const connectors = db.getConnectorsByChargepoint(cp.id);
      broadcast('status_update', { chargepoint: updatedCp, connectors }, cp.site_id ?? null);
      if (
        safeStatus === 'Available' &&
        (previousStatus === 'Unavailable' || previousStatus === 'Faulted')
      ) {
        debounceAvailabilityNotif(identity, params.connectorId, () => {
          notifications
            .emit(
              'connector_available',
              {
                identity,
                connector_id: params.connectorId,
                cp_name: updatedCp ? updatedCp.cpname : null,
                cn_name:
                  connectors.find((c) => c.connector_id === params.connectorId)?.connector_name ||
                  null,
                site_name: updatedCp ? updatedCp.site_name : null,
              },
              { siteId: updatedCp ? updatedCp.site_id : null }
            )
            .catch(() => {});
        });
      }
      if (safeStatus === 'Unavailable') {
        debounceAvailabilityNotif(identity, params.connectorId, () => {
          notifications
            .emit(
              'connector_unavailable',
              {
                identity,
                connector_id: params.connectorId,
                cp_name: updatedCp ? updatedCp.cpname : null,
                cn_name:
                  connectors.find((c) => c.connector_id === params.connectorId)?.connector_name ||
                  null,
                site_name: updatedCp ? updatedCp.site_name : null,
              },
              { siteId: updatedCp ? updatedCp.site_id : null }
            )
            .catch(() => {});
        });
      }
      if (safeStatus === 'Faulted' || safeErrorCode !== 'NoError') {
        logger.warn(
          `Connector error on ${identity} #${params.connectorId}: status=${safeStatus} errorCode=${safeErrorCode}`
        );
        db.insertErrorEvent(cp.id, 'status_error', {
          ocpp_version: '1.6',
          connector_id: params.connectorId,
          status: safeStatus,
          error_code: safeErrorCode,
          vendor_id: safeVendorId,
          vendor_error_code: safeVendorErrorCode,
          info: safeInfo,
        });
        broadcast('error_event', { chargepoint_id: cp.id }, cp.site_id ?? null);
        if (checkConnectorErrorCooldown(identity, params.connectorId, safeErrorCode)) {
          notifications
            .emit(
              'connector_error',
              {
                identity,
                connector_id: params.connectorId,
                status: safeStatus,
                error_code: safeErrorCode,
                info: safeInfo || null,
                cp_name: updatedCp ? updatedCp.cpname : null,
                cn_name:
                  connectors.find((c) => c.connector_id === params.connectorId)?.connector_name ||
                  null,
                site_name: updatedCp ? updatedCp.site_name : null,
              },
              { siteId: updatedCp ? updatedCp.site_id : null }
            )
            .catch(() => {});
        }
      }
      if (params.connectorId > 0 && safeStatus === 'SuspendedEV') {
        const activeTx = db
          .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
          .find((t) => t.connector_id === params.connectorId);
        if (activeTx && activeTx.tag_user_id && activeTx.energy > 0) {
          notifications
            .emit(
              'charge_suspended_ev',
              {
                identity,
                connector_id: params.connectorId,
                energy_kwh: (activeTx.energy / 1000).toFixed(2),
                cp_name: updatedCp ? updatedCp.cpname : null,
                cn_name:
                  connectors.find((c) => c.connector_id === params.connectorId)?.connector_name ||
                  null,
                site_name: updatedCp ? updatedCp.site_name : null,
              },
              { userId: activeTx.tag_user_id }
            )
            .catch(() => {});
        }
      }
      if (cp.mode === 2 && params.connectorId > 0 && safeStatus === 'Preparing') {
        const idTag = `MGR-${cp.site_id}`;
        const existingTag = db.getIdTagByTag(idTag);
        if (!existingTag) {
          db.createIdTag(idTag, null, cp.site_id, `Tag manager site ${cp.site_id} auto`, null, 0);
        }
        const pendingKey = `${identity}_${params.connectorId}`;
        pendingRemoteStarts.set(pendingKey, { source: 'remote', userId: null });
        setTimeout(() => pendingRemoteStarts.delete(pendingKey), 60000);

        callClient16(identity, 'RemoteStartTransaction', {
          idTag,
          connectorId: params.connectorId,
        })
          .then((result) => {
            logger.info(
              `RemoteStartTransaction Plug&Charge executed for ${identity} #${params.connectorId}: ${result.status}`
            );
            if (result.status !== 'Accepted') {
              pendingRemoteStarts.delete(pendingKey);
            }
          })
          .catch((err) => {
            logger.error(
              `RemoteStartTransaction Plug&Charge mode error for ${identity} #${params.connectorId}: ${err.message}`
            );
            pendingRemoteStarts.delete(pendingKey);
          });
      }
    }
    return {};
  });

  // ── Authorize ──
  loggedHandle('Authorize', (params) => {
    const AUTO_TAG_PREFIXES = ['WEB-', 'ADMIN', 'MGR-'];
    if (AUTO_TAG_PREFIXES.some((p) => params.idTag.startsWith(p))) {
      if (chargepointId) {
        db.addIdTagEvent(
          chargepointId,
          null,
          params.idTag,
          'Blocked',
          'auto_tag_rfid',
          'authorize'
        );
      }
      return { idTagInfo: { status: 'Blocked' } };
    }

    const cp = db.getChargepointByIdentity(identity);
    const siteId = cp ? cp.site_id : null;
    const authResult = db.authorizeIdTag(params.idTag, siteId);

    if (cp && cp.mode === 3) {
      logger.info(
        `Authorize result for ${identity}: Accepted (free mode, raw DB: ${authResult.status})`
      );
      return { idTagInfo: { status: 'Accepted' } };
    }

    logger.info(`Authorize result for ${identity}: ${authResult.status}`);
    if (authResult.status !== 'Accepted' && chargepointId) {
      db.addIdTagEvent(
        chargepointId,
        null,
        params.idTag,
        authResult.status,
        authResult.reason,
        'authorize'
      );
      broadcast(
        'auth_rejected',
        {
          identity,
          id_tag: params.idTag,
          status: authResult.status,
          reason: authResult.reason,
          source: 'authorize',
          cp_name: cp ? cp.cpname : null,
        },
        cp?.site_id ?? null
      );
      trackRepeatedAuthReject(params.idTag, identity, cp);
    }

    return {
      idTagInfo: {
        status: authResult.status,
        ...(authResult.tag && authResult.tag.expiry_date
          ? { expiryDate: authResult.tag.expiry_date }
          : {}),
      },
    };
  });

  // ── StartTransaction ──
  loggedHandle('StartTransaction', (params) => {
    logger.info(`StartTransaction from ${identity} #${params.connectorId}`);
    const cp = db.getChargepointByIdentity(identity);
    let startSource = 'rfid';
    const pendingKey = `${identity}_${params.connectorId}`;
    if (pendingRemoteStarts.has(pendingKey)) {
      const pending = pendingRemoteStarts.get(pendingKey);
      startSource = pending.source || 'remote';
      pendingRemoteStarts.delete(pendingKey);
    } else if (pendingRemoteStarts.has(identity)) {
      const pending = pendingRemoteStarts.get(identity);
      startSource = pending.source || 'remote';
      pendingRemoteStarts.delete(identity);
    } else if (cp && cp.mode === 3) {
      startSource = 'local';
    }

    let authStatus = 'Accepted';
    let authReason = null;
    if (cp && cp.mode === 1 && startSource === 'rfid') {
      const AUTO_TAG_PREFIXES = ['WEB-', 'ADMIN', 'MGR-'];
      if (AUTO_TAG_PREFIXES.some((p) => params.idTag.startsWith(p))) {
        authStatus = 'Blocked';
        authReason = 'auto_tag_rfid';
      } else {
        const siteId = cp ? cp.site_id : null;
        const authResult = db.authorizeIdTag(params.idTag, siteId);
        authStatus = authResult.status;
        authReason = authResult.reason;
      }
    }
    if (authStatus !== 'Accepted' && chargepointId) {
      db.addIdTagEvent(chargepointId, null, params.idTag, authStatus, authReason, 'authorize');
      broadcast(
        'auth_rejected',
        {
          identity,
          id_tag: params.idTag,
          status: authStatus,
          reason: authReason,
          source: 'authorize',
          cp_name: cp ? cp.cpname : null,
        },
        cp?.site_id ?? null
      );
      trackRepeatedAuthReject(params.idTag, identity, cp);
    }

    let transactionId = 0;
    if (cp && authStatus === 'Accepted') {
      const orphans = db
        .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
        .filter((t) => t.connector_id === params.connectorId);
      for (const orphan of orphans) {
        db.stopTransaction(orphan.transaction_id, params.meterStart, params.timestamp, 'Other');
        broadcast(
          'transaction_stop',
          {
            identity,
            transactionId: orphan.transaction_id,
            reason: 'Other',
          },
          cp?.site_id ?? null
        );
        logger.warn(
          `StartTransaction: closed orphan transaction ${orphan.transaction_id} on ${identity} #${params.connectorId}`
        );
      }
      const connectorRecord = db.getConnectorByChargepointAndId(cp.id, params.connectorId);
      const initialChargingState =
        (connectorRecord && ocppStatusToChargingState(connectorRecord.cnstatus)) || 'Charging';
      const tx = db.createTransaction(
        cp.id,
        params.connectorId,
        params.idTag,
        params.meterStart,
        params.timestamp,
        startSource,
        { evse_id: null, charging_state: initialChargingState, id_token_type: 'ISO14443' }
      );
      transactionId = tx.transaction_id;
      if (params.meterStart > 0) {
        db.updateConnectorMeterValue(cp.id, params.connectorId, params.meterStart);
      }
      broadcast(
        'transaction_start',
        {
          identity,
          connectorId: params.connectorId,
          transactionId,
          idTag: params.idTag,
        },
        cp?.site_id ?? null
      );
      const siteId = cp ? cp.site_id : null;
      const connectors = db.getConnectorsByChargepoint(cp.id);
      notifications
        .emit(
          'site_transaction_started',
          {
            identity,
            connector_id: params.connectorId,
            cp_name: cp ? cp.cpname : null,
            cn_name:
              connectors.find((c) => c.connector_id === params.connectorId)?.connector_name || null,
            site_name: cp ? cp.site_name : null,
          },
          { siteId }
        )
        .catch(() => {});
      if (params.idTag) {
        const tag = db.getIdTagByTag(params.idTag, siteId);
        if (tag && tag.user_id) {
          notifications
            .emit(
              'transaction_started',
              {
                identity,
                connector_id: params.connectorId,
                transaction_id: transactionId,
                cp_name: cp ? cp.cpname : null,
                cn_name:
                  connectors.find((c) => c.connector_id === params.connectorId)?.connector_name ||
                  null,
                site_name: cp ? cp.site_name : null,
              },
              { userId: tag.user_id }
            )
            .catch(() => {});
        }
      }
      if (params.reservationId != null) {
        const reservation = db.getReservationByOcppId(cp.id, params.reservationId);
        if (reservation && reservation.status === 'Active' && reservation.id_tag === params.idTag) {
          db.updateReservationStatus(reservation.id, 'InUse');
          broadcast('reservation_updated', { chargepoint_id: cp.id }, cp.site_id ?? null);
        }
      }
    }

    return {
      transactionId: parseInt(transactionId, 10),
      idTagInfo: { status: authStatus },
    };
  });

  // ── StopTransaction ──
  loggedHandle('StopTransaction', (params) => {
    // Valider meterStop : si la borne envoie meterStop <= meter_start alors que de l'énergie
    // a été consommée (firmware en Suspended EV), corriger avec meter_start + energy
    let meterStop = params.meterStop;
    const preTx = db.getTransactionByTransactionId(String(params.transactionId));
    const txWasActive = preTx?.status === 'Active';
    if (
      preTx &&
      preTx.status === 'Active' &&
      preTx.energy != null &&
      preTx.energy > 0 &&
      (meterStop == null || meterStop <= preTx.meter_start)
    ) {
      const corrected = preTx.meter_start + preTx.energy;
      logger.warn(
        `StopTransaction meterStop incohérent (${meterStop}) sur ${identity} tx ${params.transactionId}, corrigé à ${corrected}`
      );
      meterStop = corrected;
    }

    db.stopTransaction(params.transactionId, meterStop, params.timestamp, params.reason);

    let stoppedTx = db.getTransactionByTransactionId(params.transactionId);
    // Fallback : si le transactionId est inconnu, chercher une tx active sur ce chargeur
    if (!stoppedTx) {
      const cp = db.getChargepointByIdentity(identity);
      if (cp) {
        const activeTxs = db.getTransactions({ chargepoint_id: cp.id, status: 'Active' });
        if (activeTxs.length >= 1) {
          const activeTx = activeTxs.sort(
            (a, b) => new Date(b.start_time) - new Date(a.start_time)
          )[0];
          db.stopTransaction(
            activeTx.transaction_id,
            meterStop,
            params.timestamp,
            params.reason || 'Other'
          );
          stoppedTx = db.getTransactionByTransactionId(activeTx.transaction_id);
          logger.warn(
            `[Recovery] StopTransaction txId inconnu ${params.transactionId} sur ${identity}, ` +
              `${activeTxs.length > 1 ? `${activeTxs.length} tx actives — ` : ''}tx ${activeTx.transaction_id} fermée`
          );
        } else {
          logger.warn(
            `[Recovery] StopTransaction txId inconnu ${params.transactionId} sur ${identity}, aucune tx active`
          );
        }
      }
    }

    const resolvedTransactionId = stoppedTx?.transaction_id ?? params.transactionId;
    if (txWasActive || !preTx) {
      broadcast(
        'transaction_stop',
        { identity, transactionId: resolvedTransactionId, meterStop, reason: params.reason },
        db.getChargepointByIdentity(identity)?.site_id ?? null
      );
    }

    logger.info(`StopTransaction from ${identity} #${stoppedTx?.connector_id ?? '?'}`);
    if (stoppedTx) {
      const cpForTx = db.getChargepointById(stoppedTx.chargepoint_id);
      if (cpForTx && meterStop != null) {
        db.updateConnectorMeterValue(cpForTx.id, stoppedTx.connector_id, meterStop);
      }
      const siteId = cpForTx ? cpForTx.site_id : null;
      const tag = stoppedTx.id_tag ? db.getIdTagByTag(stoppedTx.id_tag, siteId) : null;
      const connectors = cpForTx ? db.getConnectorsByChargepoint(cpForTx.id) : [];
      let energyKwh = null;
      let duration = null;
      if (stoppedTx.meter_stop != null && stoppedTx.meter_start != null) {
        energyKwh = ((stoppedTx.meter_stop - stoppedTx.meter_start) / 1000).toFixed(2);
      }
      if (stoppedTx.start_time && stoppedTx.stop_time) {
        const diffMs = new Date(stoppedTx.stop_time) - new Date(stoppedTx.start_time);
        const mins = Math.floor(diffMs / 60000);
        duration =
          mins >= 60
            ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`
            : `${mins} min`;
      }
      notifications
        .emit(
          'site_transaction_stopped',
          {
            identity,
            connector_id: stoppedTx.connector_id,
            energy_kwh: energyKwh,
            duration,
            stop_reason: params.reason || 'Local',
            cp_name: cpForTx ? cpForTx.cpname : null,
            cn_name:
              connectors.find((c) => c.connector_id === stoppedTx.connector_id)?.connector_name ||
              null,
            site_name: cpForTx ? cpForTx.site_name : null,
          },
          { siteId }
        )
        .catch(() => {});
      if (tag && tag.user_id) {
        notifications
          .emit(
            'transaction_stopped',
            {
              identity,
              connector_id: stoppedTx.connector_id,
              energy_kwh: energyKwh,
              duration,
              transaction_id: resolvedTransactionId,
              stop_reason: params.reason || 'Local',
              cp_name: cpForTx ? cpForTx.cpname : null,
              cn_name:
                connectors.find((c) => c.connector_id === stoppedTx.connector_id)?.connector_name ||
                null,
              site_name: cpForTx ? cpForTx.site_name : null,
            },
            { userId: tag.user_id }
          )
          .catch(() => {});
      }
      if (cpForTx && stoppedTx.id_tag) {
        const changed = db.fulfillReservationByConnectorAndIdTag(
          cpForTx.id,
          stoppedTx.connector_id,
          stoppedTx.id_tag
        );
        if (changed > 0)
          broadcast('reservation_updated', { chargepoint_id: cpForTx.id }, cpForTx.site_id ?? null);
      }
    }

    return { idTagInfo: { status: 'Accepted' } };
  });

  // ── MeterValues ──
  loggedHandle('MeterValues', (params) => {
    const cp = db.getChargepointByIdentity(identity);
    if (cp && params.meterValue) {
      logger.info(`MeterValues from ${identity} #${params.connectorId}`);
      let powerW = null;
      let powerOffered = null;
      let energyWh = null;
      let socValue = null;
      let currentOffered = null;
      let currentL1 = null;
      let currentL2 = null;
      let currentL3 = null;
      let tempValue = null;
      let voltageL1 = null;
      let voltageL2 = null;
      let voltageL3 = null;
      let freqValue = null;
      let timestamp = null;

      for (const mv of params.meterValue) {
        timestamp = mv.timestamp || null;
        for (const sv of mv.sampledValue || []) {
          if (sv.measurand === 'Energy.Active.Import.Register') {
            const value = parseFloat(sv.value);
            energyWh = sv.unit === 'kWh' ? value * 1000 : value;
            if (params.connectorId === 0) {
              db.updateChargepointMeterValue(cp.id, energyWh);
            } else {
              db.updateConnectorMeterValue(cp.id, params.connectorId, energyWh);
            }
          }
          if (sv.measurand === 'Power.Active.Import') {
            const value = parseFloat(sv.value);
            powerW = sv.unit === 'kW' ? value * 1000 : value;
          }
          if (sv.measurand === 'Power.Offered') {
            const value = parseFloat(sv.value);
            powerOffered = sv.unit === 'kW' ? value * 1000 : value;
          }
          if (sv.measurand === 'SoC') {
            socValue = parseFloat(sv.value);
          }
          if (sv.measurand === 'Current.Offered') {
            currentOffered = parseFloat(sv.value);
          }
          if (sv.measurand === 'Current.Import') {
            const phase = sv.phase || 'L1';
            const val = parseFloat(sv.value);
            if (phase === 'L1') currentL1 = val;
            else if (phase === 'L2') currentL2 = val;
            else if (phase === 'L3') currentL3 = val;
          }
          if (sv.measurand === 'Temperature') {
            tempValue = parseFloat(sv.value);
          }
          if (sv.measurand === 'Voltage') {
            const phase = sv.phase || 'L1';
            const val = parseFloat(sv.value);
            if (phase === 'L1' || phase === 'L1-N') voltageL1 = val;
            else if (phase === 'L2' || phase === 'L2-N') voltageL2 = val;
            else if (phase === 'L3' || phase === 'L3-N') voltageL3 = val;
            else voltageL1 = val;
          }
          if (sv.measurand === 'Frequency') {
            freqValue = parseFloat(sv.value);
          }
        }
      }

      if (energyWh !== null) {
        const updatedCp = db.getChargepointByIdentity(identity);
        broadcast(
          'chargepoint_meter_update',
          { identity, meter_value: updatedCp.meter_value },
          cp?.site_id ?? null
        );
      }

      let txId = params.transactionId || null;
      if (!txId && cp) {
        const activeTx = db.getActiveTransactionByConnector(cp.id, params.connectorId);
        if (activeTx) txId = activeTx.transaction_id;
      }

      if (txId) {
        let tx = db.getTransactionByTransactionId(txId);
        if (!tx) {
          const activeTx = db.getActiveTransactionByConnector(cp.id, params.connectorId);
          if (activeTx) {
            logger.warn(
              `MeterValues txId inconnu ${txId} depuis ${identity}, redirigé vers tx active ${activeTx.transaction_id}`
            );
            txId = activeTx.transaction_id;
            tx = activeTx;
          } else {
            logger.warn(`Received MeterValues for unknown transaction ${txId} from ${identity}`);
            return {};
          }
        }
        if (tx.status !== 'Active') {
          logger.warn(
            `MeterValues pour transaction clôturée ${txId} depuis ${identity} — ignorés` +
              (energyWh !== null ? ` (énergie reçue: ${Math.round(energyWh)} Wh)` : '')
          );
          return {};
        }
        // Oui, on traite le meter value
        db.updateTransactionPowerEnergy(
          txId,
          powerW !== null ? Math.round(powerW) : null,
          energyWh !== null ? Math.round(energyWh) : null
        );

        if (timestamp) {
          const unixTs = Math.floor(new Date(timestamp).getTime() / 1000);
          const tvData = {};
          if (powerOffered !== null || powerW !== null || energyWh !== null) {
            let relativeEnergy = null;
            if (energyWh !== null) {
              const meterStart = tx.meter_start != null ? tx.meter_start : 0;
              relativeEnergy = Math.round(energyWh - meterStart);
            }
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
          ) {
            tvData.courantEntry = {
              x: unixTs,
              offer: currentOffered,
              l1: currentL1,
              l2: currentL2,
              l3: currentL3,
            };
          }
          if (socValue !== null) tvData.socEntry = { x: unixTs, y: socValue };
          if (tempValue !== null) tvData.tempEntry = { x: unixTs, y: tempValue };
          if (voltageL1 !== null || voltageL2 !== null || voltageL3 !== null)
            tvData.tensionEntry = { x: unixTs, l1: voltageL1, l2: voltageL2, l3: voltageL3 };
          if (freqValue !== null) tvData.freqEntry = { x: unixTs, y: freqValue };
          if (Object.keys(tvData).length > 0) {
            db.upsertTransactionValues(txId, tvData);
          }
        }
        broadcast(
          'transaction_updated',
          {
            identity,
            connectorId: params.connectorId,
            transactionId: txId,
            power: powerW !== null ? Math.round(powerW) : null,
            energy: energyWh !== null ? Math.round(energyWh) : null,
          },
          cp?.site_id ?? null
        );
      }

      broadcast(
        'meter_values',
        {
          identity,
          connectorId: params.connectorId,
          meterValue: params.meterValue,
        },
        cp?.site_id ?? null
      );
    }
    return {};
  });

  // ── DataTransfer ──
  loggedHandle('DataTransfer', (_params) => {
    return { status: 'Accepted' };
  });

  // ── DiagnosticsStatusNotification ──
  loggedHandle('DiagnosticsStatusNotification', (params) => {
    if (params.status === 'Uploaded' || params.status === 'UploadFailed') {
      const updatedCp = db.getChargepointByIdentity(identity);
      broadcast(
        'diagnostics_upload',
        { identity, status: params.status },
        updatedCp?.site_id ?? null
      );
      notifications
        .emit('diagnostics_upload', {
          identity,
          status: params.status,
          cp_name: updatedCp ? updatedCp.cpname : null,
          site_name: updatedCp ? updatedCp.site_name : null,
        })
        .catch(() => {});
    }
    return {};
  });

  // ── FirmwareStatusNotification ──
  loggedHandle('FirmwareStatusNotification', (params) => {
    const updatedCp = db.getChargepointByIdentity(identity);
    broadcast('firmware_status', { identity, status: params.status }, updatedCp?.site_id ?? null);
    if (
      params.status === 'Installed' ||
      params.status === 'InstallationFailed' ||
      params.status === 'DownloadFailed'
    ) {
      notifications
        .emit('firmware_status', {
          identity,
          status: params.status,
          cp_name: updatedCp ? updatedCp.cpname : null,
          site_name: updatedCp ? updatedCp.site_name : null,
        })
        .catch(() => {});
    }
    return {};
  });

  // Après reconnexion sans BootNotification : demander à la borne de renvoyer son état
  if (cpRecord && cpRecord.initialized) {
    refreshTimer = setTimeout(async () => {
      const current = db.getChargepointByIdentity(identity);
      if (!current || !current.connected || current.cpstatus) return;

      logger.info(
        `[StateRefresh] ${identity}: reconnecté sans BootNotification, envoi TriggerMessage`
      );
      try {
        await callClient16(identity, 'TriggerMessage', { requestedMessage: 'BootNotification' });
      } catch (e) {
        logger.warn(
          `[StateRefresh] ${identity}: TriggerMessage(BootNotification) échoué: ${e.message}`
        );
        return;
      }

      // Attendre que la borne complète sa séquence de boot (certaines envoient
      // StatusNotification automatiquement en réponse au trigger BootNotification)
      const statusReceived = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingStatusAfterBootCallback = null;
          resolve(false);
        }, 10000);
        pendingStatusAfterBootCallback = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });

      if (!db.getChargepointByIdentity(identity)?.connected) return;

      if (statusReceived) {
        logger.info(
          `[StateRefresh] ${identity}: StatusNotification auto-reçu, skip TriggerMessage(StatusNotification)`
        );
        return;
      }

      try {
        await callClient16(identity, 'TriggerMessage', { requestedMessage: 'StatusNotification' });
      } catch (e) {
        logger.warn(
          `[StateRefresh] ${identity}: TriggerMessage(StatusNotification) échoué: ${e.message}`
        );
      }
    }, 20000);

    client.once('close', () => clearTimeout(refreshTimer));
  }
}

// ── Enregistrement au chargement du module ──
registerHandlersFn('1.6', register16Handlers);
registerCallClientImpl('1.6', callClient16);

module.exports = { register16Handlers, callClient16, OCPP16_STANDARD_KEYS };
