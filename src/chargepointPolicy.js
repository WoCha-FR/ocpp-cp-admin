'use strict';

// ── Borne autorisée à démarrer une recharge ──
// Une borne sans site est inactive : sa connexion reste acceptée (configuration, affectation à
// un site), mais aucun démarrage n'est possible, quel que soit son mode (badge contrôlé, Plug &
// Charge ou libre). Sans site, une session n'a ni tarif, ni gestionnaire, ni titulaire de
// contrat à rembourser.

/**
 * @param {{site_id?: number|null}|null|undefined} cp
 * @returns {string|null} motif du refus (id_tags_events.reason), null si le démarrage est permis
 */
function startBlockReason(cp) {
  if (cp && !cp.site_id) return 'chargepoint_no_site';
  return null;
}

module.exports = { startBlockReason };
