'use strict';

// ── Droits sur les badges (admin / gestionnaire de site) ──
// Module pur, sans accès à la base : les routes lui fournissent le badge et son titulaire.
//
// - L'admin gère tous les badges.
// - Un gestionnaire gère les badges limités à un site qu'il gère ; il ne les rattache qu'à un
//   salarié lié à ce site (jamais à un compte admin).
// - Un badge global (valable sur tous les sites) n'est géré par un gestionnaire que s'il est
//   rattaché à un salarié dont TOUS les sites sont gérés par ce gestionnaire (cas d'une
//   entreprise : badge pro d'un salarié, valable au siège et chez ses collègues). Un badge global
//   sans titulaire, ou d'un salarié lié aussi à un site d'un autre gestionnaire, reste à l'admin.
//
// ctx   : { isAdmin: boolean, managedSiteIds: number[] }
// tag   : { site_id: number|null, user_id: number|null }
// owner : { role: string, site_ids: number[] } | null — titulaire du badge (tag.user_id)

function isOwnerLinkedTo(owner, siteId) {
  return !!owner && owner.role !== 'admin' && owner.site_ids.includes(siteId);
}

function isOwnerFullyManaged(owner, managedSiteIds) {
  return (
    !!owner &&
    owner.role !== 'admin' &&
    owner.site_ids.length > 0 &&
    owner.site_ids.every((id) => managedSiteIds.includes(id))
  );
}

/** Le badge existant est-il visible et modifiable par cet utilisateur ? */
function canAccessIdTag(ctx, tag, owner) {
  if (ctx.isAdmin) return true;
  const managed = ctx.managedSiteIds || [];
  if (tag.site_id) return managed.includes(tag.site_id);
  return tag.user_id != null && isOwnerFullyManaged(owner, managed);
}

/**
 * Contrôle d'une création (existing = null) ou d'une modification.
 * @returns {string|null} code d'erreur, null si l'écriture est permise
 */
function idTagWriteError(ctx, next, nextOwner, { existing = null, existingOwner = null } = {}) {
  if (ctx.isAdmin) return null;
  const managed = ctx.managedSiteIds || [];
  if (existing && !canAccessIdTag(ctx, existing, existingOwner)) return 'ERR_SITE_NOT_MANAGED';

  if (next.site_id) {
    if (!managed.includes(next.site_id)) return 'ERR_SITE_NOT_MANAGED';
    const ownerChanged =
      !existing || existing.user_id !== next.user_id || existing.site_id !== next.site_id;
    if (next.user_id != null && ownerChanged && !isOwnerLinkedTo(nextOwner, next.site_id)) {
      return 'ERR_TAG_USER_NOT_IN_SITE';
    }
    return null;
  }

  // Badge global
  if (next.user_id == null) return 'ERR_SITE_REQUIRED';
  if (!isOwnerFullyManaged(nextOwner, managed)) return 'ERR_TAG_GLOBAL_NOT_MANAGED';
  return null;
}

/** Peut-on rattacher un badge GLOBAL à ce titulaire ? (aide de l'interface) */
function canOwnGlobalTag(ctx, owner) {
  if (ctx.isAdmin) return true;
  return isOwnerFullyManaged(owner, ctx.managedSiteIds || []);
}

module.exports = { canAccessIdTag, idTagWriteError, canOwnGlobalTag };
