-- Historique figé des sessions et colonnes du cycle de vie des données.
--
-- Une session fige à son démarrage le site de la borne, le salarié (titulaire du badge) et la
-- catégorie pro/perso du badge. Jusqu'ici ces informations étaient relues à chaque affichage
-- depuis l'état actuel des badges et des bornes : modifier, supprimer ou réattribuer un badge,
-- ou déplacer une borne, réécrivait le passé (remboursements compris).
-- Pas de clé étrangère sur ces colonnes : elles doivent survivre aux suppressions.
ALTER TABLE transactions ADD COLUMN site_id INTEGER;
ALTER TABLE transactions ADD COLUMN user_id INTEGER;
ALTER TABLE transactions ADD COLUMN user_name TEXT;
ALTER TABLE transactions ADD COLUMN tag_category TEXT CHECK (tag_category IN ('pro', 'perso'));

-- Rattrapage des sessions existantes avec la résolution utilisée jusqu'ici à l'affichage :
-- site actuel de la borne, puis badge du site, badge global, badge d'un autre site.
UPDATE transactions SET site_id = (
  SELECT cp.site_id FROM chargepoints cp WHERE cp.id = transactions.chargepoint_id
);

UPDATE transactions AS t SET
  user_id = r.user_id,
  user_name = r.user_name,
  tag_category = r.category
FROM (
  SELECT t2.id AS tx_id, it.user_id, it.category,
    COALESCE(u.shortname, u.useremail) AS user_name
  FROM transactions t2
  JOIN id_tags it ON it.id = (
    SELECT it2.id FROM id_tags it2
    WHERE it2.id_tag = t2.id_tag
    ORDER BY CASE WHEN it2.site_id = t2.site_id THEN 0 WHEN it2.site_id IS NULL THEN 1 ELSE 2 END,
      it2.id
    LIMIT 1
  )
  LEFT JOIN users u ON u.id = it.user_id
) AS r
WHERE r.tx_id = t.id;

CREATE INDEX IF NOT EXISTS idx_transactions_site ON transactions(site_id, start_time);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, start_time);

-- Cycle de vie (utilisées par les lots suivants) : archivage des sites et des bornes,
-- désactivation des comptes, badge web automatique autorisé ou non par site.
ALTER TABLE sites ADD COLUMN archived_at TEXT;
ALTER TABLE sites ADD COLUMN auto_web_badge INTEGER NOT NULL DEFAULT 1 CHECK (auto_web_badge IN (0, 1));
ALTER TABLE chargepoints ADD COLUMN archived_at TEXT;
ALTER TABLE users ADD COLUMN disabled_at TEXT;
