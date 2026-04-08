-- Add logging columns to atis_jobs

ALTER TABLE atis_jobs
  ADD COLUMN IF NOT EXISTS ip_address          text,
  ADD COLUMN IF NOT EXISTS recording_duration_sec integer;

-- Index for admin queries (filter by date, airport, status)
CREATE INDEX IF NOT EXISTS atis_jobs_created_at ON atis_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS atis_jobs_ip         ON atis_jobs (ip_address) WHERE ip_address IS NOT NULL;
