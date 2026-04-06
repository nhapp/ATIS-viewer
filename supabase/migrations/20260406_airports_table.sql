-- Airport lookup table (populated from FAA DCS XML)
-- Supports full-text search by name, city, ICAO, and IATA

CREATE TABLE IF NOT EXISTS airports (
  icao       text PRIMARY KEY,
  faa_id     text,
  name       text NOT NULL,
  city       text,
  state      text,
  iata       text,
  updated_at timestamptz DEFAULT now()
);

-- Trigram indexes for fast ILIKE search on name and city
-- Requires pg_trgm extension (enabled by default in Supabase)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS airports_name_trgm ON airports USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS airports_city_trgm ON airports USING GIN (city gin_trgm_ops);
CREATE INDEX IF NOT EXISTS airports_iata      ON airports (iata) WHERE iata IS NOT NULL;

-- Allow anonymous read (same pattern as other tables)
ALTER TABLE airports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "airports_read" ON airports FOR SELECT USING (true);
