-- Tarifs datés et journal des corrections de session.
--
-- La grille actuelle d'un site (sites.default_price_per_kwh + site_tariff_periods) devient la
-- grille « depuis l'origine ». Des grilles datées s'y ajoutent : chacune s'applique à partir de
-- son jour (minuit, heure du site) jusqu'à la grille suivante. Une hausse connue à l'avance se
-- saisit donc avant son entrée en vigueur ; saisie en retard, elle recalcule (après aperçu et
-- confirmation) les sessions déjà clôturées, et chaque écart est tracé.
CREATE TABLE IF NOT EXISTS site_tariff_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  valid_from TEXT NOT NULL, -- AAAA-MM-JJ, jour local du site
  default_price_per_kwh REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  UNIQUE (site_id, valid_from)
);

-- NULL = tranche de la grille « depuis l'origine »
ALTER TABLE site_tariff_periods ADD COLUMN version_id INTEGER REFERENCES site_tariff_versions(id) ON DELETE CASCADE;

-- Journal des corrections d'une session : badge corrigé (motif obligatoire, coût inchangé) ou
-- coût recalculé après un tarif saisi en retard. Les index de la borne ne sont jamais corrigés.
-- Instantané avant / après (salarié, catégorie, coût, énergie) : l'export remboursement en tire
-- la section « Régularisations » des sessions antérieures à la période exportée.
CREATE TABLE IF NOT EXISTS transaction_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL, -- transactions.id
  site_id INTEGER, -- site de la session (figé au démarrage)
  kind TEXT NOT NULL CHECK (kind IN ('badge', 'tariff')),
  reason TEXT,
  author_id INTEGER,
  author_name TEXT,
  old_id_tag TEXT,
  new_id_tag TEXT,
  old_user_id INTEGER,
  new_user_id INTEGER,
  old_user_name TEXT,
  new_user_name TEXT,
  old_category TEXT,
  new_category TEXT,
  old_cost REAL,
  new_cost REAL,
  old_currency TEXT,
  new_currency TEXT,
  energy_wh INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tx_corrections_tx ON transaction_corrections(transaction_id);
CREATE INDEX IF NOT EXISTS idx_tx_corrections_site ON transaction_corrections(site_id, created_at);
