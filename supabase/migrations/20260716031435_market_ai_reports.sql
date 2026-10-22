-- User-triggered market analysis is an immutable derivative of preserved
-- evidence. Scheduled collection never writes to this table.

CREATE TABLE radar_analytics.market_ai_reports (
  id uuid PRIMARY KEY,
  subscription_key text NOT NULL,
  source_id text,
  period_days integer NOT NULL CHECK (period_days BETWEEN 1 AND 365),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  evidence_started_at timestamptz NOT NULL,
  evidence_ended_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  output jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object'),
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (evidence_started_at <= evidence_ended_at),
  UNIQUE NULLS NOT DISTINCT (
    subscription_key,
    source_id,
    period_days,
    evidence_hash,
    provider,
    model,
    prompt_version
  )
);

CREATE INDEX market_ai_reports_selection_time_idx
  ON radar_analytics.market_ai_reports(
    subscription_key,
    source_id,
    period_days,
    generated_at DESC
  );

COMMENT ON TABLE radar_analytics.market_ai_reports IS
  'Immutable, manually requested AI market reports bound to an exact evidence hash; never source truth.';
COMMENT ON COLUMN radar_analytics.market_ai_reports.evidence IS
  'Exact bounded evidence document supplied to the configured AI Gateway route.';
COMMENT ON COLUMN radar_analytics.market_ai_reports.output IS
  'Validated model output. It never overwrites source facts or observations.';

REVOKE ALL ON radar_analytics.market_ai_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON radar_analytics.market_ai_reports TO radar_analytics_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON radar_analytics.market_ai_reports FROM radar_analytics_runtime;
