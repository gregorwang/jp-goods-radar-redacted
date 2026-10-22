-- Hyperdrive authenticates with the existing Supabase postgres login. Grant
-- only the ability to assume the restricted analytics runtime role used by
-- every application transaction.
GRANT radar_analytics_runtime TO postgres;
