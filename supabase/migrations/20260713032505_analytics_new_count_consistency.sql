CREATE OR REPLACE FUNCTION radar_analytics.refresh_observation_new_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
BEGIN
  UPDATE radar_analytics.search_run_sources AS source_run
  SET new_count=(
    SELECT count(*)::integer
    FROM radar_analytics.listing_observations AS observation
    WHERE observation.run_id=NEW.run_id
      AND observation.source_id=NEW.source_id
      AND observation.is_new_for_query
  )
  WHERE source_run.run_id=NEW.run_id AND source_run.source_id=NEW.source_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER listing_observations_new_count_insert
AFTER INSERT ON radar_analytics.listing_observations
FOR EACH ROW EXECUTE FUNCTION radar_analytics.refresh_observation_new_count();

CREATE TRIGGER listing_observations_new_count_update
AFTER UPDATE OF is_new_for_query ON radar_analytics.listing_observations
FOR EACH ROW
WHEN (OLD.is_new_for_query IS DISTINCT FROM NEW.is_new_for_query)
EXECUTE FUNCTION radar_analytics.refresh_observation_new_count();

REVOKE ALL ON FUNCTION radar_analytics.refresh_observation_new_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION radar_analytics.refresh_observation_new_count() TO radar_analytics_runtime;
