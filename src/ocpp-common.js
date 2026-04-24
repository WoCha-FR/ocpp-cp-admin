const { RPCServer, createRPCError } = require('ocpp-rpc');
const bcrypt = require('bcryptjs');
const { getConfig } = require('./config');
const db = require('./database');
const notifications = require('./notifications');
const logger = require('./logger').scope('OCPP');

// ── État partagé ──
let wsBroadcast = null;
const connectedClients = new Map();
const pendingRemoteStarts = new Map();
const pendingChargepoints = new Map();
const authRejectTracker = new Map();
const reconnectTracker = new Map();
const refusedNotifCooldown = new Map();

const wsRateTracker = new Map();
const WS_RATE_MAX = 10;
const WS_RATE_WINDOW_MS = 60 * 1000;

// ── Utilitaires ──
function checkWsRateLimit(ip) {
  const now = Date.now();
  let attempts = wsRateTracker.get(ip) || [];
  attempts = attempts.filter((t) => now - t < WS_RATE_WINDOW_MS);
  if (attempts.length >= WS_RATE_MAX) {
    wsRateTracker.set(ip, attempts);
    return false;
  }
  attempts.push(now);
  wsRateTracker.set(ip, attempts);
  return true;
}

function checkRefusedNotifCooldown(identity) {
  const config = getConfig();
  const cooldownMs = ((config.notifs && config.notifs.refusedCooldownMinutes) || 60) * 60 * 1000;
  const now = Date.now();
  const last = refusedNotifCooldown.get(identity);
  if (!last || now - last > cooldownMs) {
    refusedNotifCooldown.set(identity, now);
    return true;
  }
  return false;
}

function setBroadcast(fn) {
  wsBroadcast = fn;
}

function broadcast(type, data) {
  if (wsBroadcast) wsBroadcast(JSON.stringify({ type, data }));
}

function getConnectedClients() {
  return connectedClients;
}

// ── Pattern registration — handlers et callClient (évite les dépendances circulaires) ──
let _register16Handlers = null;
let _register201Handlers = null;
let _callClient16 = null;
let _callClient201 = null;

function registerHandlersFn(version, fn) {
  if (version === '1.6') _register16Handlers = fn;
  else _register201Handlers = fn;
}

function registerCallClientImpl(version, fn) {
  if (version === '1.6') _callClient16 = fn;
  else _callClient201 = fn;
}

async function callClient(identity, method, params) {
  const cp = db.getChargepointByIdentity(identity);
  if (cp?.ocpp_version === '2.0.1') {
    if (!_callClient201) throw new Error('OCPP 2.0.1 callClient not registered');
    return _callClient201(identity, method, params);
  }
  if (!_callClient16) throw new Error('OCPP 1.6 callClient not registered');
  return _callClient16(identity, method, params);
}

// ── Factory loggedHandle ──
function makeLoggedHandle(client, identity, chargepointId) {
  return function loggedHandle(action, handler) {
    client.handle(action, (msg) => {
      const params = msg.params;
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
  };
}

// ── Factory serveur OCPP ──
function createOCPPServerBase(options = {}) {
  const isWSS = options.isWSS || false;
  const config = getConfig();
  const protocols = options.protocols || ['ocpp1.6'];
  let withStrictMode = config.ocpp.strictMode ?? true;
  if (protocols.length === 0) {
    withStrictMode = false;
  }

  const server = new RPCServer({
    protocols,
    strictMode: withStrictMode,
    deferPingsOnActivity: true,
    callTimeoutMs: (config.ocpp.callTimeoutSeconds || 60) * 1000,
    maxBadMessages: 10,
  });

  server.auth((accept, reject, handshake) => {
    if (protocols.length === 0) {
      return reject(503, 'No OCPP version enabled on this server');
    }
    const clientIp = handshake.remoteAddress || 'unknown';
    if (!checkWsRateLimit(clientIp)) {
      logger.warn(`OCPP WS rate limit exceeded for IP: ${clientIp}`);
      return reject(429, 'Too many connection attempts');
    }

    logger.debug(`Connection attempt: ${handshake.identity} on ${isWSS ? 'WSS' : 'WS'}`);

    if (!handshake.identity) {
      return reject(400, 'Missing identity');
    }

    let cp = db.getChargepointByIdentity(handshake.identity);
    const providedPassword = handshake.password ? handshake.password.toString('utf8') : null;

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
        if (checkRefusedNotifCooldown(handshake.identity)) {
          notifications
            .emit('chargepoint_refused', {
              identity: handshake.identity,
              reason: 'wss_no_auth',
            })
            .catch(() => {});
        }
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

    if (cp && !cp.authorized) {
      logger.warn(`Connection refused: charge ${handshake.identity} point not authorized`);
      if (checkRefusedNotifCooldown(handshake.identity)) {
        notifications
          .emit('chargepoint_refused', {
            identity: handshake.identity,
            reason: 'not_authorized',
          })
          .catch(() => {});
      }
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
        if (!alreadyPending) {
          notifications
            .emit('pending_chargepoint', { identity: handshake.identity })
            .catch(() => {});
        }
        return reject(401, 'Charge point pending approval');
      } else {
        logger.info(`Connection refused: unknown charge point ${handshake.identity}`);
        if (checkRefusedNotifCooldown(handshake.identity)) {
          notifications
            .emit('chargepoint_refused', {
              identity: handshake.identity,
              reason: 'unknown',
            })
            .catch(() => {});
        }
        return reject(401, 'Unknown charge point');
      }
    }

    const dbPassword = cp.password || null;
    if (!providedPassword && dbPassword) {
      logger.warn(`Connection refused: ${handshake.identity} password required but missing`);
      if (checkRefusedNotifCooldown(handshake.identity)) {
        notifications
          .emit('chargepoint_refused', {
            identity: handshake.identity,
            reason: 'password_required',
          })
          .catch(() => {});
      }
      return reject(401, 'Password required');
    }
    if (providedPassword && !dbPassword) {
      logger.warn(`Connection refused: ${handshake.identity} password provided but not expected`);
      if (checkRefusedNotifCooldown(handshake.identity)) {
        notifications
          .emit('chargepoint_refused', {
            identity: handshake.identity,
            reason: 'password_unexpected',
          })
          .catch(() => {});
      }
      return reject(401, 'Password not expected');
    }
    if (providedPassword && dbPassword && !bcrypt.compareSync(providedPassword, dbPassword)) {
      logger.warn(`Connection refused: ${handshake.identity} invalid password`);
      if (checkRefusedNotifCooldown(handshake.identity)) {
        notifications
          .emit('chargepoint_refused', {
            identity: handshake.identity,
            reason: 'invalid_password',
          })
          .catch(() => {});
      }
      return reject(401, 'Invalid password');
    }

    accept({ identity: handshake.identity, remoteAddress: handshake.remoteAddress });
  });

  server.on('client', (client) => {
    const identity = client.identity;

    const existingClient = connectedClients.get(identity);
    if (existingClient) {
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
      if (trackFlapping(identity)) {
        try {
          client.close();
          // eslint-disable-next-line no-unused-vars
        } catch (e) {
          /* empty */
        }
        return;
      }
      logger.debug(`Reconnection detected, closing existing connection: ${identity}`);
      try {
        existingClient.close();
        // eslint-disable-next-line no-unused-vars
      } catch (e) {
        // ignorer les erreurs de fermeture
      }
    }

    logger.info(`Chargepoint connected: ${identity}`);
    connectedClients.set(identity, client);
    db.upsertChargepoint(identity, {
      connected: 1,
      connected_wss: isWSS ? 1 : 0,
      endpoint_address: client.session.remoteAddress || null,
    });
    broadcast('chargepoint_connected', { identity });

    client.on('strictValidationFailure', ({ method, error, outbound, isCall }) => {
      if (!outbound && !isCall) {
        logger.warn(
          `[${identity}] Strict mode violation on ${method}.conf: ${error?.message} — this chargepoint is not OCPP strict-mode compliant. Set ocpp.strictMode to false in the configuration to avoid errors.`
        );
        broadcast('strict_mode_violation', { identity, method });
      }
    });

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

    const cpRecord = db.getChargepointByIdentity(identity);
    const chargepointId = cpRecord ? cpRecord.id : null;
    const loggedHandle = makeLoggedHandle(client, identity, chargepointId);

    if (client.protocol === 'ocpp2.0.1' && _register201Handlers) {
      _register201Handlers(client, loggedHandle);
    } else if (_register16Handlers) {
      _register16Handlers(client, loggedHandle);
    } else {
      logger.error(`No OCPP handler registered for protocol: ${client.protocol || 'ocpp1.6'}`);
    }

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
        db.addOcppMessage(chargepointId, 'csms', 'CALLERROR', method, {
          error: 'NotImplemented',
        });
      broadcast('ocpp_message', {
        identity,
        origin: 'csms',
        message_type: 'CALLERROR',
        action: method,
        payload: { error: 'NotImplemented' },
      });
      throw err;
    });

    client.once('close', () => {
      if (connectedClients.get(identity) !== client) {
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

// ── Déconnexion forcée ──
function disconnectChargepoint(identity) {
  const client = connectedClients.get(identity);
  if (client) {
    logger.info(`Forced disconnection (de-authorisation) for ${identity}`);
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
    tracker.count++;
    tracker.lastIdentity = identity;
    tracker.lastCpName = cp ? cp.cpname : null;
    tracker.lastSiteId = cp ? cp.site_id : null;

    if (tracker.count === AUTH_REJECT_THRESHOLD) {
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
    authRejectTracker.set(idTag, {
      count: 1,
      firstTime: now,
      lastIdentity: identity,
      lastCpName: cp ? cp.cpname : null,
      lastSiteId: cp ? cp.site_id : null,
    });
  }
  if (authRejectTracker.size > 50) {
    for (const [tag, data] of authRejectTracker) {
      if (now - data.firstTime > AUTH_REJECT_WINDOW_MS) authRejectTracker.delete(tag);
    }
  }
}

// ── Détection flapping ──
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
  if (reconnectTracker.size > 50) {
    for (const [id, data] of reconnectTracker) {
      if (now - data.firstTime > FLAP_WINDOW_MS) reconnectTracker.delete(id);
    }
  }
  return false;
}

// ── Heartbeat Watchdog ──
const WATCHDOG_CHECK_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_MISS_FACTOR = 2;
let heartbeatWatchdogTimer = null;

function startHeartbeatWatchdog() {
  heartbeatWatchdogTimer = setInterval(() => {
    const hbConfig = db.getInitialChargepointConfigByKey('HeartbeatInterval');
    const heartbeatInterval = hbConfig ? parseInt(hbConfig.value, 10) : 300;
    const timeoutMs = heartbeatInterval * HEARTBEAT_MISS_FACTOR * 1000;

    const now = Date.now();
    for (const [identity] of connectedClients) {
      const cp = db.getChargepointByIdentity(identity);
      if (!cp || !cp.last_heartbeat) continue;

      const lastHb = new Date(cp.last_heartbeat).getTime();
      if (now - lastHb > timeoutMs) {
        logger.warn(
          `Heartbeat timeout for ${identity}: last heartbeat ${Math.round((now - lastHb) / 1000)}s ago (limit: ${heartbeatInterval * HEARTBEAT_MISS_FACTOR}s)`
        );
        disconnectChargepoint(identity);
      }
    }
    for (const [ip, attempts] of wsRateTracker) {
      if (attempts.every((t) => now - t >= WS_RATE_WINDOW_MS)) wsRateTracker.delete(ip);
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
}

function stopHeartbeatWatchdog() {
  if (heartbeatWatchdogTimer) {
    clearInterval(heartbeatWatchdogTimer);
    heartbeatWatchdogTimer = null;
  }
}

module.exports = {
  createOCPPServerBase,
  setBroadcast,
  broadcast,
  getConnectedClients,
  callClient,
  registerCallClientImpl,
  registerHandlersFn,
  disconnectChargepoint,
  trackRepeatedAuthReject,
  startHeartbeatWatchdog,
  stopHeartbeatWatchdog,
  pendingRemoteStarts,
  pendingChargepoints,
};
