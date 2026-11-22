-- Démarrages à distance (RemoteStartTransaction 1.6 / RequestStartTransaction 2.0.1) : la borne ne
-- doit pas faire autoriser le badge par Authorize avant de démarrer. Les démarrages depuis
-- l'interface utilisent des badges générés (ADMIN, MGR-x, WEB-x) qu'Authorize refuse hors démarrage
-- à distance en attente. On impose donc la clé à false dans la configuration initiale appliquée
-- aux bornes (séquence d'initialisation, « Appliquer à toutes les bornes »).
-- Filet de sécurité côté CSMS si la clé est en lecture seule sur la borne : Authorize accepte un
-- badge généré quand un démarrage à distance avec ce badge est en attente sur cette borne.

-- OCPP 1.6 : AuthorizeRemoteTxRequests (clé Core requise, R ou RW selon la borne)
INSERT INTO chargepoint_init_config (key, value, enabled) VALUES ('AuthorizeRemoteTxRequests', 'false', 1)
  ON CONFLICT(key) DO UPDATE SET value = 'false', enabled = 1, updated_at = datetime('now');

-- OCPP 2.0.1 : AuthCtrlr.AuthorizeRemoteStart
INSERT INTO chargepoint_init_variables (component, variable, attribute, value, enabled)
  VALUES ('AuthCtrlr', 'AuthorizeRemoteStart', 'Actual', 'false', 1)
  ON CONFLICT(component, variable, attribute) DO UPDATE
    SET value = 'false', enabled = 1, updated_at = datetime('now');
