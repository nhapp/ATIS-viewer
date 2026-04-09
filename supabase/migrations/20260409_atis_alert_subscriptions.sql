-- ATIS arrival alert subscriptions
-- Stores SMS notification requests for when the arrival ATIS updates.
-- twilio-webhook checks this table after each completed ATIS and dispatches
-- pending alerts whose notify_after time has passed.

CREATE TABLE IF NOT EXISTS atis_alert_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  icao        text NOT NULL,
  phone       text NOT NULL,
  notify_after timestamptz NOT NULL,
  sent_at     timestamptz,
  atis_code   text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS atis_alerts_icao ON atis_alert_subscriptions (icao, sent_at, notify_after);

ALTER TABLE atis_alert_subscriptions ENABLE ROW LEVEL SECURITY;

-- Allow anonymous inserts (client creates subscriptions)
CREATE POLICY "alerts_insert" ON atis_alert_subscriptions
  FOR INSERT WITH CHECK (true);

-- No client reads — service role only
