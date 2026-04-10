-- User profiles (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS user_profiles (
  id             uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  phone          text,
  balance_cents  int NOT NULL DEFAULT 0,
  is_premium     bool NOT NULL DEFAULT false,
  created_at     timestamptz DEFAULT now()
);

-- Auto-create profile row on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.user_profiles (id) VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Full balance ledger
CREATE TABLE IF NOT EXISTS balance_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  amount_cents  int NOT NULL,
  type          text NOT NULL CHECK (type IN ('topup', 'atis_fetch', 'sms_send')),
  description   text,
  created_at    timestamptz DEFAULT now()
);

-- Prevents double-charging same airport same calendar day
CREATE TABLE IF NOT EXISTS daily_atis_fetches (
  user_id     uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  icao        text NOT NULL,
  fetch_date  date NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (user_id, icao, fetch_date)
);

-- RLS
ALTER TABLE user_profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_atis_fetches  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profile_owner"       ON user_profiles       FOR ALL     USING (auth.uid() = id);
CREATE POLICY "transactions_select" ON balance_transactions FOR SELECT  USING (auth.uid() = user_id);
CREATE POLICY "fetches_owner"       ON daily_atis_fetches  FOR ALL     USING (auth.uid() = user_id);

-- Atomic credit (called by stripe-webhook via service role)
CREATE OR REPLACE FUNCTION public.credit_balance(p_user_id uuid, p_amount_cents int)
RETURNS int AS $$
DECLARE new_bal int;
BEGIN
  UPDATE public.user_profiles
    SET balance_cents = balance_cents + p_amount_cents,
        is_premium    = true
  WHERE id = p_user_id
  RETURNING balance_cents INTO new_bal;
  RETURN new_bal;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomic deduct — returns new balance, or NULL if insufficient funds
CREATE OR REPLACE FUNCTION public.deduct_balance(p_user_id uuid, p_amount_cents int)
RETURNS int AS $$
DECLARE new_bal int;
BEGIN
  UPDATE public.user_profiles
    SET balance_cents = balance_cents - p_amount_cents
  WHERE id = p_user_id AND balance_cents >= p_amount_cents
  RETURNING balance_cents INTO new_bal;
  RETURN new_bal;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
