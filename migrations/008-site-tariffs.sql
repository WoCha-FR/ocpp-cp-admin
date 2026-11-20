-- Tarification du kWh par site (tranches horaires + jours de semaine)
ALTER TABLE sites ADD COLUMN currency TEXT DEFAULT 'EUR';
ALTER TABLE sites ADD COLUMN timezone TEXT DEFAULT 'Europe/Paris';
ALTER TABLE sites ADD COLUMN default_price_per_kwh REAL;

CREATE TABLE IF NOT EXISTS site_tariff_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  label TEXT,
  days TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  price_per_kwh REAL NOT NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_site_tariff_periods_site ON site_tariff_periods(site_id);

-- Coût figé à la clôture de la session (NULL = pas de tarif / session antérieure)
ALTER TABLE transactions ADD COLUMN cost REAL;
ALTER TABLE transactions ADD COLUMN cost_currency TEXT;
ALTER TABLE transactions ADD COLUMN cost_details TEXT;
