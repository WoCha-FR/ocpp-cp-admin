-- Catégorie des badges : pro (remboursable) ou perso
ALTER TABLE id_tags ADD COLUMN category TEXT NOT NULL DEFAULT 'perso' CHECK (category IN ('pro', 'perso'));
