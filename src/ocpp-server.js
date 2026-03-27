const { RPCServer, createRPCError } = require('ocpp-rpc');
const bcrypt = require('bcryptjs');
const { getConfig } = require('./config');
const db = require('./database');
const notifications = require('./notifications');
const logger = require('./logger').scope('OCPP');

let wsBroadcast = null; // sera défini depuis server.js
const connectedClients = new Map(); // identity → RPCServerClient
const pendingRemoteStarts = new Map(); // identity → { source, userId } pour tracker la source de démarrage
const pendingChargepoints = new Map(); // identity → { identity, remoteAddress, password, timestamp }
const authRejectTracker = new Map(); // idTag → { count, firstTime, lastIdentity, lastCpName, lastSiteId }
const reconnectTracker = new Map(); // identity → { count, firstTime }

function setBroadcast(fn) {
  wsBroadcast = fn;
}

function broadcast(type, data) {
  if (wsBroadcast) wsBroadcast(JSON.stringify({ type, data }));
}

function getConnectedClients() {
  return connectedClients;
}

function createOCPPServer(options = {}) {
  const isWSS = options.isWSS || false;
  const config = getConfig();
  const server = new RPCServer({
    protocols: ['ocpp1.6'],
    strictMode: config.ocpp.strictMode,
  });

  server.auth((accept, reject, handshake) => {
    logger.debug(`Connection attempt: ${handshake.identity} on ${isWSS ? 'WSS' : 'WS'}`);

    if (!handshake.identity) {
      return reject(400, 'Missing identity');
    }

    let cp = db.getChargepointByIdentity(handshake.identity);
    const providedPassword = handshake.password ? handshake.password.toString('utf8') : null;

    // En WSS, vérifier qu'au moins une méthode d'authentification est présente
    // Security Profile 2 : Basic Auth (mot de passe)
    // Security Profile 3 : Certificat client TLS
    if (isWSS) {
      let hasClientCert = false;
      try {
        const peerCert =
          handshake.request &&
          handshake.request.socket &&
          handshake.request.socket.getPeerCertificate();
        hasClientCert = peerCert && peerCert.subject && Object.keys(peerCert.subject).length > 0;
        // eslint-disable-next-line no-unused-vars
      } catch (e) {
        // Pas de certificat client disponible
      }

      if (!providedPassword && !hasClientCert) {
        logger.warn(`WSS connection refused: ${handshake.identity} no authentication method`);
        return reject(
          401,
          'WSS requires Basic Auth (Security Profile 2) or client certificate (Security Profile 3)'
        );
      }

      if (hasClientCert) {
        logger.info(`WSS connection with client certificate: ${handshake.identity}`);
      } else {
        logger.info(`WSS connection with Basic Auth: ${handshake.identity}`);
      }
    }

    // Vérifier si la borne est autorisée
    if (cp && !cp.authorized) {
      logger.warn(`Connection refused: charge ${handshake.identity} point not authorized`);
      return reject(401, 'Charge point not authorized');
    }

    if (!cp) {
      if (config.ocpp.autoAddUnknownChargepoints) {
        logger.info(`Unknown ${handshake.identity} added automatically`);
        cp = db.createChargepoint(
          handshake.identity,
          handshake.identity,
          providedPassword,
          0,
          null
        );
        // Notifier les admins
        notifications
          .emit('autoadd_chargepoint', {
            identity: handshake.identity,
          })
          .catch(() => {});
      } else if (config.ocpp.pendingUnknownChargepoints) {
        logger.info(`Unknown ${handshake.identity} pending approval`);
        const alreadyPending = pendingChargepoints.has(handshake.identity);
        pendingChargepoints.set(handshake.identity, {
          identity: handshake.identity,
          remoteAddress: handshake.remoteAddress,
          password: providedPassword,
          timestamp: new Date().toISOString(),
        });
        broadcast('pending_chargepoint', {
          identity: handshake.identity,
          remoteAddress: handshake.remoteAddress,
          timestamp: new Date().toISOString(),
        });
        // Notifier les admins uniquement à la première tentative de connexion
        if (!alreadyPending) {
          notifications
            .emit('pending_chargepoint', { identity: handshake.identity })
            .catch(() => {});
        }
        return reject(401, 'Charge point pending approval');
      } else {
        return reject(401, 'Unknown charge point');
      }
    }

    const dbPassword = cp.password || null;
    if (!providedPassword && dbPassword) {
      logger.warn(`Connection refused: ${handshake.identity} password required but missing`);
      return reject(401, 'Password required');
    }
    if (providedPassword && !dbPassword) {
      logger.warn(`Connection refused: ${handshake.identity} password provided but not expected`);
      return reject(401, 'Password not expected');
    }
    if (providedPassword && dbPassword && !bcrypt.compareSync(providedPassword, dbPassword)) {
      logger.warn(`Connection refused: ${handshake.identity} invalid password`);
      return reject(401, 'Invalid password');
    }

    accept({ identity: handshake.identity, remoteAddress: handshake.remoteAddress });
  });

  server.on('client', (client) => {
    const identity = client.identity;
    // Si une connexion existe déjà pour cette identité, on vérifie certains points.
    const existingClient = connectedClients.get(identity);
    if (existingClient) {
      // ── Détection IP différente (deux bornes physiques avec le même identity) ──
      const oldAddr = existingClient.session?.remoteAddress;
      const newAddr = client.session?.remoteAddress;
      if (oldAddr && newAddr && oldAddr !== newAddr) {
        logger.warn(`Duplicate identity suspected: ${identity} from ${oldAddr} AND ${newAddr}`);
        const cpDup = db.getChargepointByIdentity(identity);
        notifications
          .emit(
            'duplicate_identity',
            {
              identity,
              old_address: oldAddr,
              new_address: newAddr,
              site_name: cpDup ? cpDup.site_name : null,
            },
            { siteId: cpDup ? cpDup.site_id : null }
          )
          .catch(() => {});
      }
      // ── Détection flapping (reconnexions en boucle) ──
      if (trackFlapping(identity)) {
        try {
          client.close();
          // eslint-disable-next-line no-unused-vars
        } catch (e) {
          /* empty */
        }
        return; // ← arrêter complètement le traitement de cette connexion
      }
      // ── on continue ──
      logger.debug(`Reconnection detected, closing existing connection: ${identity}`);
      try {
        existingClient.close();
        // eslint-disable-next-line no-unused-vars
      } catch (e) {
        // ignorer les erreurs de fermeture
      }
    }
    logger.info(`Chargepoint connected: ${identity}`);
    // Enregistrer dans la map et la DB
    connectedClients.set(identity, client);
    db.upsertChargepoint(identity, {
      connected: 1,
      connected_wss: isWSS ? 1 : 0,
      endpoint_address: client.session.remoteAddress || null,
    });
    broadcast('chargepoint_connected', { identity });

    // Détecter les bornes non conformes au mode strict OCPP (champs supplémentaires dans les réponses)
    client.on('strictValidationFailure', ({ method, error, outbound, isCall }) => {
      if (!outbound && !isCall) {
        // La borne a répondu avec des champs non autorisés par le schéma OCPP 1.6
        logger.warn(
          `[${identity}] Strict mode violation on ${method}.conf: ${error?.message} — this chargepoint is not OCPP strict-mode compliant. Set ocpp.strictMode to false in the configuration to avoid errors.`
        );
        broadcast('strict_mode_violation', { identity, method });
      }
    });

    // Notifier borne en ligne
    const cpForNotif = db.getChargepointByIdentity(identity);
    notifications
      .emit(
        'chargepoint_online',
        {
          identity,
          cp_name: cpForNotif ? cpForNotif.cpname : null,
          site_name: cpForNotif ? cpForNotif.site_name : null,
        },
        { siteId: cpForNotif ? cpForNotif.site_id : null }
      )
      .catch(() => {});
    // Récupérer l'ID de la borne pour les FK
    const cpRecord = db.getChargepointByIdentity(identity);
    const chargepointId = cpRecord ? cpRecord.id : null;
    // Helper pour logger un message OCPP et construire la réponse
    function loggedHandle(action, handler) {
      client.handle(action, (msg) => {
        const params = msg.params;
        // Log CALL entrant (depuis la borne)
        if (chargepointId) db.addOcppMessage(chargepointId, 'chargepoint', 'CALL', action, params);
        logger.debug(`Received ${action} from ${identity}: ${JSON.stringify(params)}`);
        broadcast('ocpp_message', {
          identity,
          origin: 'chargepoint',
          message_type: 'CALL',
          action,
          payload: params,
        });
        try {
          const result = handler(params);
          // Log CALLRESULT sortant (depuis le CSMS)
          if (chargepointId) db.addOcppMessage(chargepointId, 'csms', 'CALLRESULT', action, result);
          logger.debug(`Responding to ${action} from ${identity}: ${JSON.stringify(result)}`);
          broadcast('ocpp_message', {
            identity,
            origin: 'csms',
            message_type: 'CALLRESULT',
            action,
            payload: result,
          });
          return result;
        } catch (err) {
          // Log CALLERROR sortant
          if (chargepointId)
            db.addOcppMessage(chargepointId, 'csms', 'CALLERROR', action, { error: err.message });
          logger.error(`Error handling ${action} from csms to ${identity}: ${err.message}`);
          broadcast('ocpp_message', {
            identity,
            origin: 'csms',
            message_type: 'CALLERROR',
            action,
            payload: { error: err.message },
          });
          throw err;
        }
      });
    }

    // ── BootNotification ──
    loggedHandle('BootNotification', (params) => {
      logger.debug(`BootNotification from ${identity}`);
      db.upsertChargepoint(identity, {
        vendor: params.chargePointVendor || null,
        model: params.chargePointModel || null,
        serial_number: params.chargePointSerialNumber || null,
        firmware_version: params.firmwareVersion || null,
        iccid: params.iccid || null,
        imsi: params.imsi || null,
        meter_sn: params.meterSerialNumber || null,
        meter_type: params.meterType || null,
        cpstatus: 'Available',
        connected: 1,
      });

      const cp = db.getChargepointByIdentity(identity);
      broadcast('chargepoint_update', cp);

      // Initialiser la borne si besoin
      setImmediate(async (cp) => {
        if (!cp || cp.initialized) return;
        // Étape 1 — GetConfiguration : peuple automatiquement chargepoint_config via bulkUpsertChargepointConfig
        try {
          await callClient(client, identity, 'GetConfiguration', {});
        } catch (e) {
          logger.warn(`[InitSeq] ${identity} GetConfiguration: ${e.message}`);
        }

        // Étape 2 — Vider le cache d'autorisation
        try {
          await callClient(client, identity, 'ClearCache', {});
        } catch (e) {
          logger.warn(`[InitSeq] ${identity} ClearCache: ${e.message}`);
        }

        // Étape 3 — Supprimer les profils de charge résiduels
        try {
          await callClient(client, identity, 'ClearChargingProfile', {});
        } catch (e) {
          logger.warn(`[InitSeq] ${identity} ClearChargingProfile: ${e.message}`);
        }

        // Étape 4 — Marquer la borne comme initialisée pour éviter de refaire l'init à chaque reboot
        db.markChargepointInitialized(cp.id);
      }, cp);

      return {
        status: 'Accepted',
        interval: config.ocpp.heartbeatInterval,
        currentTime: new Date().toISOString(),
      };
    });

    // ── Heartbeat ──
    loggedHandle('Heartbeat', (_params) => {
      db.updateChargepointStatus(identity, undefined, true);
      const cp = db.getChargepointByIdentity(identity);
      broadcast('chargepoint_heartbeat', { identity, last_heartbeat: cp?.last_heartbeat });

      return {
        currentTime: new Date().toISOString(),
      };
    });

    // ── StatusNotification ──
    loggedHandle('StatusNotification', (params) => {
      logger.debug(`StatusNotification from ${identity} #${params.connectorId}`);
      const cp = db.getChargepointByIdentity(identity);
      if (cp) {
        // Connector 0 = le CP lui-même : stocker les infos directement sur la borne
        if (params.connectorId === 0) {
          db.updateChargepointStatus(identity, params.status, true, {
            error_code: params.errorCode,
            error_info: params.info,
            vendor_id: params.vendorId || null,
            vendor_error_code: params.vendorErrorCode || null,
          });
          db.upsertChargepoint(identity, { has_connector0: 1 });
        }
        // Stocker le status actuel du connecteur
        const existingConnector = db.getConnectorByChargepointAndId(cp.id, params.connectorId);
        const previousStatus = existingConnector?.cnstatus || null;
        // Mettre à jour le connecteur en base
        db.upsertConnector(
          cp.id,
          params.connectorId,
          params.status,
          params.errorCode,
          params.info,
          params.vendorId || null,
          params.vendorErrorCode || null
        );
        // Si la borne n'envoie pas de connecteur 0, dériver cpstatus depuis les connecteurs :
        // Available si au moins 1 connecteur != Unavailable, Unavailable si tous sont Unavailable
        if (params.connectorId !== 0 && !cp.has_connector0 && cp.cpstatus === 'Unavailable') {
          const allConnectors = db.getConnectorsByChargepoint(cp.id);
          const derivedStatus = allConnectors.some((c) => c.cnstatus !== 'Unavailable')
            ? 'Available'
            : 'Unavailable';
          db.updateChargepointStatus(identity, derivedStatus, true);
        }
        const updatedCp = db.getChargepointByIdentity(identity);
        const connectors = db.getConnectorsByChargepoint(cp.id);
        broadcast('status_update', { chargepoint: updatedCp, connectors });
        // Notifier connecteur Available uniquement après un Unavailable ou Faulted pour éviter les notifications redondantes
        if (
          params.status === 'Available' &&
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
        // Notifier connecteur Unavailable
        if (params.status === 'Unavailable') {
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
        // Notifier connecteur en erreur (Faulted ou errorCode != NoError)
        if (params.status === 'Faulted' || (params.errorCode && params.errorCode !== 'NoError')) {
          logger.warn(
            `Connector error on ${identity} #${params.connectorId}: status=${params.status} errorCode=${params.errorCode}`
          );
          notifications
            .emit(
              'connector_error',
              {
                identity,
                connector_id: params.connectorId,
                status: params.status,
                error_code: params.errorCode,
                info: params.info || null,
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
        // Notifier SuspendedEVSE pour l'utilisateur de la transaction active
        if (params.connectorId > 0 && params.status === 'SuspendedEVSE') {
          const activeTx = db
            .getTransactions({ chargepoint_id: cp.id, status: 'Active' })
            .find((t) => t.connector_id === params.connectorId);
          if (activeTx && activeTx.tag_user_id && activeTx.energy > 0) {
            notifications
              .emit(
                'charge_suspended_evse',
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
        // Mode 2 (Plug & Charge) : envoi automatique de RemoteStartTransaction quand un connecteur passe en Preparing
        if (cp.mode === 2 && params.connectorId > 0 && params.status === 'Preparing') {
          const idTag = `MGR-${cp.site_id}`;
          const existingTag = db.getIdTagByTag(idTag);
          if (!existingTag) {
            db.createIdTag(idTag, null, cp.site_id, `Tag manager site ${cp.site_id} auto`, null);
          }
          const pendingKey = `${identity}_${params.connectorId}`;
          pendingRemoteStarts.set(pendingKey, { source: 'remote', userId: null });
          setTimeout(() => pendingRemoteStarts.delete(pendingKey), 60000);

          callClient(client, identity, 'RemoteStartTransaction', {
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
      logger.debug(`Authorize request from ${identity}`);
      const cp = db.getChargepointByIdentity(identity);
      const siteId = cp ? cp.site_id : null;
      const authResult = db.authorizeIdTag(params.idTag, siteId);
      logger.info(`Authorize result for ${identity}: ${authResult.status}`);

      // En mode Autonome (mode 3), on accepte toujours
      if (cp && cp.mode === 3) {
        return { idTagInfo: { status: 'Accepted' } };
      }
      // Stocker et diffuser les rejets d'autorisation
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
      // Déterminer la source de démarrage
      let startSource = 'rfid'; // par défaut, démarrage par badge RFID
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
        // Mode Autonome : la borne démarre d'elle-même, source locale
        startSource = 'local';
      }

      // Vérifier l'idTag
      let authStatus = 'Accepted';
      let authReason = null;
      if (cp && cp.mode === 1 && startSource === 'rfid') {
        // Mode RFID : vérifier l'idTag seulement si démarrage par badge
        const siteId = cp ? cp.site_id : null;
        const authResult = db.authorizeIdTag(params.idTag, siteId);
        authStatus = authResult.status;
        authReason = authResult.reason;
      }
      // Stocker et diffuser les rejets d'autorisation
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
        transactionId = tx.transaction_id;
        broadcast('transaction_start', {
          identity,
          connectorId: params.connectorId,
          transactionId,
          idTag: params.idTag,
        });
        // Notifier le démarrage de transaction
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
                connectors.find((c) => c.connector_id === params.connectorId)?.connector_name ||
                null,
              site_name: cp ? cp.site_name : null,
            },
            { siteId }
          )
          .catch(() => {});
        // Notifier l'utilisateur du début de transaction
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

      // Notifications
      const stoppedTx = db.getTransactionByTransactionId(params.transactionId);
      if (stoppedTx) {
        const cpForTx = db.getChargepointById(stoppedTx.chargepoint_id);
        const siteId = cpForTx ? cpForTx.site_id : null;
        const tag = stoppedTx.id_tag ? db.getIdTagByTag(stoppedTx.id_tag, siteId) : null;
        const connectors = cpForTx ? db.getConnectorsByChargepoint(cpForTx.id) : [];
        // Calculs pour les notifications (convertir Wh en kWh, calculer durée, etc.)
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
        // Notifier la fin de recharge sur site
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
        // Notifier l'utilisateur de la fin de transaction
        if (tag && tag.user_id) {
          notifications
            .emit(
              'transaction_stopped',
              {
                identity,
                energy_kwh: energyKwh,
                duration,
                transaction_id: params.transactionId,
                stop_reason: params.reason || 'Local',
                cp_name: cpForTx ? cpForTx.cpname : null,
                cn_name:
                  connectors.find((c) => c.connector_id === stoppedTx.connector_id)
                    ?.connector_name || null,
                site_name: cpForTx ? cpForTx.site_name : null,
              },
              { userId: tag.user_id }
            )
            .catch(() => {});
        }
      }

      return {
        idTagInfo: { status: 'Accepted' },
      };
    });

    // ── MeterValues ──
    loggedHandle('MeterValues', (params) => {
      const cp = db.getChargepointByIdentity(identity);
      if (cp && params.meterValue) {
        logger.debug(`MeterValues from ${identity} #${params.connectorId}`);
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
            // Stocker le total sur le connecteur
            if (sv.measurand === 'Energy.Active.Import.Register') {
              // Convertir kWh en Wh
              const value = parseFloat(sv.value);
              energyWh = sv.unit === 'kWh' ? value * 1000 : value;
              // Connector 0 = la borne elle-même : stocker sur chargepoints
              if (params.connectorId === 0) {
                db.updateChargepointMeterValue(cp.id, energyWh);
              } else {
                db.updateConnectorMeterValue(cp.id, params.connectorId, energyWh);
              }
            }
            // Puissance active import en Watts
            if (sv.measurand === 'Power.Active.Import') {
              const value = parseFloat(sv.value);
              powerW = sv.unit === 'kW' ? value * 1000 : value;
            }
            // Puissance offerte en Watts
            if (sv.measurand === 'Power.Offered') {
              const value = parseFloat(sv.value);
              powerOffered = sv.unit === 'kW' ? value * 1000 : value;
            }
            // State of Charge (%)
            if (sv.measurand === 'SoC') {
              socValue = parseFloat(sv.value);
            }
            // Courant offert
            if (sv.measurand === 'Current.Offered') {
              currentOffered = parseFloat(sv.value);
            }
            // Courant import par phase
            if (sv.measurand === 'Current.Import') {
              const phase = sv.phase || 'L1';
              const val = parseFloat(sv.value);
              if (phase === 'L1') currentL1 = val;
              else if (phase === 'L2') currentL2 = val;
              else if (phase === 'L3') currentL3 = val;
            }
          }
        }

        // Mettre à jour power/energy et transactions_values si lié à une transaction
        if (params.transactionId) {
          db.updateTransactionPowerEnergy(
            params.transactionId,
            powerW !== null ? Math.round(powerW) : null,
            energyWh !== null ? Math.round(energyWh) : null
          );

          if (timestamp) {
            const unixTs = Math.floor(new Date(timestamp).getTime() / 1000);
            const tvData = {};
            if (powerOffered !== null || powerW !== null || energyWh !== null) {
              // Calculer l'énergie relative (consommée depuis le début de la transaction)
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
      logger.debug(`DataTransfer from ${identity}`);
      return { status: 'Accepted' };
    });

    // ── DiagnosticsStatusNotification ──
    loggedHandle('DiagnosticsStatusNotification', (params) => {
      logger.debug(`DiagnosticsStatusNotification from ${identity}: ${params.status}`);
      if (params.status === 'Uploaded' || params.status === 'UploadFailed') {
        broadcast('diagnostics_upload', { identity, status: params.status });
        // Notifier l'admin du résultat de l'upload de diagnostics
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

    // ── Wildcard ──
    client.handle(({ method, params }) => {
      logger.warn(`OCPP method not managed ${method} from ${identity}`);
      if (chargepointId) db.addOcppMessage(chargepointId, 'chargepoint', 'CALL', method, params);
      broadcast('ocpp_message', {
        identity,
        origin: 'chargepoint',
        message_type: 'CALL',
        action: method,
        payload: params,
      });
      const err = createRPCError('NotImplemented');
      if (chargepointId)
        db.addOcppMessage(chargepointId, 'csms', 'CALLERROR', method, { error: 'NotImplemented' });
      broadcast('ocpp_message', {
        identity,
        origin: 'csms',
        message_type: 'CALLERROR',
        action: method,
        payload: { error: 'NotImplemented' },
      });
      throw err;
    });

    // ── Déconnexion ──
    client.once('close', () => {
      // Ne traiter la déconnexion que si c'est bien le client actuel
      // (pas une ancienne connexion remplacée par une reconnexion)
      if (connectedClients.get(identity) !== client) {
        // console.log(`[OCPP] Old connection closed for ${identity} (ignored, already reconnected))`);
        return;
      }
      logger.info(`Chargepoint ${identity} disconnected`);
      connectedClients.delete(identity);
      db.upsertChargepoint(identity, {
        connected: 0,
        connected_wss: 0,
        endpoint_address: null,
        cpstatus: 'Unavailable',
        has_connector0: 0,
      });
      broadcast('chargepoint_disconnected', { identity });
      // Notifier borne hors ligne
      const cpDisc = db.getChargepointByIdentity(identity);
      notifications
        .emit(
          'chargepoint_offline',
          {
            identity,
            cpname: cpDisc ? cpDisc.cpname : null,
            site_name: cpDisc ? cpDisc.site_name : null,
          },
          { siteId: cpDisc ? cpDisc.site_id : null }
        )
        .catch(() => {});
    });
  });
  return server;
}

// ── Commandes vers borne avec interception des réponses ──
async function callClient(client, identity, method, params) {
  const cp = db.getChargepointByIdentity(identity);
  const cpId = cp ? cp.id : null;

  // Log CALL sortant
  if (cpId) db.addOcppMessage(cpId, 'csms', 'CALL', method, params);
  broadcast('ocpp_message', {
    identity,
    origin: 'csms',
    message_type: 'CALL',
    action: method,
    payload: params,
  });

  const result = await client.call(method, params);

  // Log CALLRESULT entrant
  if (cpId) db.addOcppMessage(cpId, 'chargepoint', 'CALLRESULT', method, result);
  broadcast('ocpp_message', {
    identity,
    origin: 'chargepoint',
    message_type: 'CALLRESULT',
    action: method,
    payload: result,
  });

  // Intercepter GetConfiguration pour stocker la config en BDD
  if (method === 'GetConfiguration' && result && result.configurationKey) {
    if (cp) {
      db.bulkUpsertChargepointConfig(cp.id, result.configurationKey);
      broadcast('chargepoint_config_update', { identity, chargepointId: cp.id });
    }
  }

  return result;
}

/**
 * Déconnecte une borne immédiatement.
 * Les transactions actives sont terminées en base avec stop_reason 'DeAuthorized'.
 */
function disconnectChargepoint(identity) {
  const client = connectedClients.get(identity);
  if (client) {
    logger.info(`Forced disconnection (de-authorisation) for ${identity}`);
    // Terminer les transactions actives en base
    const cp = db.getChargepointByIdentity(identity);
    if (cp) {
      const activeTxs = db.getTransactions({ chargepoint_id: cp.id, status: 'Active' });
      for (const tx of activeTxs) {
        db.stopTransaction(
          tx.transaction_id,
          tx.meter_start || 0,
          new Date().toISOString(),
          'DeAuthorized'
        );
      }
    }
    try {
      client.close();
      // eslint-disable-next-line no-unused-vars
    } catch (e) {
      // ignorer les erreurs de fermeture
    }
  }
}

// ── Suivi des rejets d'autorisation répétés ──
function trackRepeatedAuthReject(idTag, identity, cp) {
  const config = getConfig();
  const AUTH_REJECT_THRESHOLD = (config.notifs && config.notifs.authRejectThreshold) || 3;
  const AUTH_REJECT_WINDOW_MS =
    ((config.notifs && config.notifs.authRejectWindowMinutes) || 5) * 60 * 1000;
  const now = Date.now();
  const tracker = authRejectTracker.get(idTag);

  if (tracker && now - tracker.firstTime < AUTH_REJECT_WINDOW_MS) {
    // Toujours dans la fenêtre, incrémenter
    tracker.count++;
    tracker.lastIdentity = identity;
    tracker.lastCpName = cp ? cp.cpname : null;
    tracker.lastSiteId = cp ? cp.site_id : null;

    if (tracker.count === AUTH_REJECT_THRESHOLD) {
      // Seuil atteint : envoyer la notification
      logger.warn(
        `Repeated auth rejections for tag ${idTag}: ${tracker.count} in ${AUTH_REJECT_WINDOW_MS / 1000}s`
      );
      notifications
        .emit(
          'repeated_auth_rejected',
          {
            identity,
            id_tag: idTag,
            count: tracker.count,
            window_minutes: Math.round(AUTH_REJECT_WINDOW_MS / 60000),
            cp_name: cp ? cp.cpname : null,
            site_name: cp ? cp.site_name : null,
          },
          { siteId: cp ? cp.site_id : null }
        )
        .catch(() => {});
    }
  } else {
    // Nouvelle fenêtre
    authRejectTracker.set(idTag, {
      count: 1,
      firstTime: now,
      lastIdentity: identity,
      lastCpName: cp ? cp.cpname : null,
      lastSiteId: cp ? cp.site_id : null,
    });
  }
  // Nettoyage périodique des entrées expirées (toutes les 50 insertions)
  if (authRejectTracker.size > 50) {
    for (const [tag, data] of authRejectTracker) {
      if (now - data.firstTime > AUTH_REJECT_WINDOW_MS) authRejectTracker.delete(tag);
    }
  }
}

// ── Détection flapping (reconnexions en boucle) ──
function trackFlapping(identity) {
  const config = getConfig();
  const FLAP_WINDOW_MS = ((config.notifs && config.notifs.flapWindowMinutes) || 2) * 60 * 1000;
  const FLAP_THRESHOLD = (config.notifs && config.notifs.flapThreshold) || 4;
  const now = Date.now();
  const flap = reconnectTracker.get(identity);
  if (flap && now - flap.firstTime < FLAP_WINDOW_MS) {
    flap.count++;
    if (flap.count === FLAP_THRESHOLD) {
      logger.error(
        `Identity flapping: ${identity} (${flap.count} reconnections in ${FLAP_WINDOW_MS / 1000}s)`
      );
      const cpFlap = db.getChargepointByIdentity(identity);
      notifications
        .emit(
          'identity_flapping',
          {
            identity,
            count: flap.count,
            seconds: Math.round((now - flap.firstTime) / 1000),
            site_name: cpFlap ? cpFlap.site_name : null,
          },
          { siteId: cpFlap ? cpFlap.site_id : null }
        )
        .catch(() => {});
      return true;
    }
  } else {
    reconnectTracker.set(identity, { count: 1, firstTime: now });
  }
  // Nettoyage périodique des entrées expirées (toutes les 50 insertions)
  if (reconnectTracker.size > 50) {
    for (const [id, data] of reconnectTracker) {
      if (now - data.firstTime > FLAP_WINDOW_MS) reconnectTracker.delete(id);
    }
  }
  return false;
}

module.exports = {
  createOCPPServer,
  setBroadcast,
  getConnectedClients,
  callClient,
  disconnectChargepoint,
  pendingRemoteStarts,
  pendingChargepoints,
};
