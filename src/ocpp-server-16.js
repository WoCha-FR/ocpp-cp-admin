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

function sanitizeText(value, maxLen) {
  if (value == null) return null;
  const normalized = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
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
  broadcast('ocpp_message', {
    identity,
    origin: 'csms',
    message_type: 'CALL',
    action: method,
    payload: params,
  });
  logger.info(`Calling ${method} on ${identity} with params: ${JSON.stringify(params)}`);

  let result;
  try {
    result = await client.call(method, params);
  } catch (err) {
    if (cpId) db.addOcppMessage(cpId, 'chargepoint', 'CALLERROR', method, { error: err.message });
    broadcast('ocpp_message', {
      identity,
      origin: 'chargepoint',
      message_type: 'CALLERROR',
      action: method,
      payload: { error: err.message },
    });
    logger.warn(`Error response for ${method} from ${identity}: ${err.message}`);
    throw err;
  }

  if (cpId) db.addOcppMessage(cpId, 'chargepoint', 'CALLRESULT', method, result);
  broadcast('ocpp_message', {
    identity,
    origin: 'chargepoint',
    message_type: 'CALLRESULT',
    action: method,
    payload: result,
  });
  logger.debug(`Received response for ${method} from ${identity}: ${JSON.stringify(result)}`);

  if (method === 'GetConfiguration' && result && result.configurationKey) {
    if (cp) {
      db.bulkUpsertChargepointConfig(cp.id, result.configurationKey);
      broadcast('chargepoint_config_update', { identity, chargepointId: cp.id });
    }
  }

  return result;
}

// ── Handlers entrants (borne → CSMS) OCPP 1.6 ──
function register16Handlers(client, loggedHandle) {
  const identity = client.identity;
  const cpRecord = db.getChargepointByIdentity(identity);
  const chargepointId = cpRecord ? cpRecord.id : null;

  // ── BootNotification ──
  loggedHandle('BootNotification', (params) => {
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
    broadcast('chargepoint_update', cp);

    setImmediate(async (cp) => {
      if (!cp || cp.initialized) return;
      try {
        logger.debug(`[InitSeq] Calling ClearCache on ${identity} to clear authorization cache`);
        await callClient16(identity, 'ClearCache', {});
      } catch (e) {
        logger.warn(`[InitSeq] ${identity} ClearCache: ${e.message}`);
      }

      try {
        const existingProfiles = db.getChargingProfiles(cp.id);
        if (existingProfiles.length === 0) {
          logger.debug(
            `[InitSeq] Calling ClearChargingProfile on ${identity} to clear charging profiles`
          );
          await callClient16(identity, 'ClearChargingProfile', {});
        } else {
          logger.debug(
            `[InitSeq] ${identity} has ${existingProfiles.length} managed profile(s) — skipping ClearChargingProfile`
          );
        }
      } catch (e) {
        logger.warn(`[InitSeq] ${identity} ClearChargingProfile: ${e.message}`);
      }

      try {
        logger.debug(`[InitSeq] ${identity} GetConfiguration (all keys)`);
        await callClient16(identity, 'GetConfiguration', {});
      } catch (e) {
        logger.warn(
          `[InitSeq] ${identity} GetConfiguration (all keys): ${e.message} — falling back to paginated`
        );

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
        }

        logger.debug(
          `[InitSeq] ${identity} GetConfiguration paginated (maxKeys=${maxKeys}, total=${OCPP16_STANDARD_KEYS.length})`
        );
        for (let i = 0; i < OCPP16_STANDARD_KEYS.length; i += maxKeys) {
          const chunk = OCPP16_STANDARD_KEYS.slice(i, i + maxKeys);
          try {
            await callClient16(identity, 'GetConfiguration', { key: chunk });
          } catch (e2) {
            logger.warn(
              `[InitSeq] ${identity} GetConfiguration chunk [${i}..${i + maxKeys - 1}]: ${e2.message}`
            );
          }
        }
      }

      const globals = db.getEnabledInitialChargepointConfig();
      const rebootKeys = [];
      const rejectedKeys = [];
      const notSupportedKeys = [];
      for (const cfg of globals) {
        const current = db.getChargepointConfigByKey(cp.id, cfg.key);
        if (current?.is_override) continue;
        if (current?.value === cfg.value) continue;
        try {
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
        }
      }
      const overrideConfigs = db.getChargepointOverrideConfigs(cp.id);
      for (const cfg of overrideConfigs) {
        const current = db.getChargepointConfigByKey(cp.id, cfg.key);
        if (current?.value === cfg.value) continue;
        try {
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
          logger.warn(`[InitSeq] ${identity} Locked ChangeConfiguration ${cfg.key}: ${e.message}`);
        }
      }

      if (rebootKeys.length > 0 || rejectedKeys.length > 0 || notSupportedKeys.length > 0) {
        notifications
          .emit('init_config_result', { identity, rebootKeys, rejectedKeys, notSupportedKeys })
          .catch(() => {});
      }

      db.markChargepointInitialized(cp.id);
      logger.debug(`[InitSeq] ${identity} initialization sequence completed`);
    }, cp);

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
    broadcast('chargepoint_heartbeat', { identity, last_heartbeat: cp?.last_heartbeat });
    return { currentTime: new Date().toISOString() };
  });

  // ── StatusNotification ──
  loggedHandle('StatusNotification', (params) => {
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
        safeVendorErrorCode
      );
      if (params.connectorId !== 0) {
        if (cp.feat_reservation) {
          if (safeStatus === 'Reserved') {
            db.activateReservationByConnector(cp.id, params.connectorId);
          } else if (['Available', 'Faulted', 'Unavailable', 'Finishing'].includes(safeStatus)) {
            db.expireReservationByConnector(cp.id, params.connectorId);
          }
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
      }
      const updatedCp = db.getChargepointByIdentity(identity);
      const connectors = db.getConnectorsByChargepoint(cp.id);
      broadcast('status_update', { chargepoint: updatedCp, connectors });
      if (
        safeStatus === 'Available' &&
        (previousStatus === 'Unavailable' || previousStatus === 'Faulted')
      ) {
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
      }
      if (safeStatus === 'Unavailable') {
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
      }
      if (safeStatus === 'Faulted' || safeErrorCode !== 'NoError') {
        logger.warn(
          `Connector error on ${identity} #${params.connectorId}: status=${safeStatus} errorCode=${safeErrorCode}`
        );
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
    logger.info(`Authorize result for ${identity}: ${authResult.status}`);

    if (cp && cp.mode === 3) {
      return { idTagInfo: { status: 'Accepted' } };
    }
    if (authResult.status !== 'Accepted' && chargepointId) {
      db.addIdTagEvent(
        chargepointId,
        null,
        params.idTag,
        authResult.status,
        authResult.reason,
        'authorize'
      );
      broadcast('auth_rejected', {
        identity,
        id_tag: params.idTag,
        status: authResult.status,
        reason: authResult.reason,
        source: 'authorize',
        cp_name: cp ? cp.cpname : null,
      });
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
      broadcast('auth_rejected', {
        identity,
        id_tag: params.idTag,
        status: authStatus,
        reason: authReason,
        source: 'authorize',
        cp_name: cp ? cp.cpname : null,
      });
      trackRepeatedAuthReject(params.idTag, identity, cp);
    }

    let transactionId = 0;
    if (cp && authStatus === 'Accepted') {
      const tx = db.createTransaction(
        cp.id,
        params.connectorId,
        params.idTag,
        params.meterStart,
        params.timestamp,
        startSource
      );
      transactionId = parseInt(tx.transaction_id, 10);
      broadcast('transaction_start', {
        identity,
        connectorId: params.connectorId,
        transactionId,
        idTag: params.idTag,
      });
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
    }

    return {
      transactionId,
      idTagInfo: { status: authStatus },
    };
  });

  // ── StopTransaction ──
  loggedHandle('StopTransaction', (params) => {
    logger.info(`StopTransaction from ${identity} #${params.connectorId}`);
    db.stopTransaction(params.transactionId, params.meterStop, params.timestamp, params.reason);

    broadcast('transaction_stop', {
      identity,
      transactionId: params.transactionId,
      meterStop: params.meterStop,
      reason: params.reason,
    });

    const stoppedTx = db.getTransactionByTransactionId(params.transactionId);
    if (stoppedTx) {
      const cpForTx = db.getChargepointById(stoppedTx.chargepoint_id);
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
              transaction_id: params.transactionId,
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
        }
      }

      if (params.transactionId) {
        // Transaction connue ?
        const tx = db.getTransactionByTransactionId(params.transactionId);
        if (!tx) {
          logger.warn(
            `Received MeterValues for unknown transaction ${params.transactionId} from ${identity}`
          );
          return {};
        }
        // Oui, on traite le meter value
        db.updateTransactionPowerEnergy(
          params.transactionId,
          powerW !== null ? Math.round(powerW) : null,
          energyWh !== null ? Math.round(energyWh) : null
        );

        if (timestamp) {
          const unixTs = Math.floor(new Date(timestamp).getTime() / 1000);
          const tvData = {};
          if (powerOffered !== null || powerW !== null || energyWh !== null) {
            let relativeEnergy = null;
            if (energyWh !== null) {
              const tx = db.getTransactionByTransactionId(params.transactionId);
              const meterStart = tx && tx.meter_start != null ? tx.meter_start : 0;
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
          if (Object.keys(tvData).length > 0) {
            db.upsertTransactionValues(params.transactionId, tvData);
          }
        }
      }

      broadcast('meter_values', {
        identity,
        connectorId: params.connectorId,
        meterValue: params.meterValue,
      });
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
      broadcast('diagnostics_upload', { identity, status: params.status });
      const updatedCp = db.getChargepointByIdentity(identity);
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
}

// ── Enregistrement au chargement du module ──
registerHandlersFn('1.6', register16Handlers);
registerCallClientImpl('1.6', callClient16);

module.exports = { register16Handlers, callClient16, OCPP16_STANDARD_KEYS };
