-- Runway headings table (populated from OurAirports runways.csv)
-- Stores physical heading of each runway end so the app can draw runway diagrams

CREATE TABLE IF NOT EXISTS runways (
  airport_ident  text NOT NULL,
  le_ident       text NOT NULL,
  he_ident       text NOT NULL,
  le_heading     numeric,
  he_heading     numeric,
  PRIMARY KEY (airport_ident, le_ident)
);

CREATE INDEX IF NOT EXISTS runways_airport ON runways (airport_ident);

-- Allow anonymous read
ALTER TABLE runways ENABLE ROW LEVEL SECURITY;
CREATE POLICY "runways_read" ON runways FOR SELECT USING (true);
