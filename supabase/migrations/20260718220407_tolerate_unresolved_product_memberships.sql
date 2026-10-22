-- D1 retains the complete immutable Workflow projection. Postgres memberships
-- require a real source_listings foreign key, so unresolved operational
-- candidates are filtered here rather than represented by fabricated rows or
-- allowed to roll back every confirmed membership in the same projection.
ALTER FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  RENAME TO ingest_product_identity_projection_resolved;

CREATE FUNCTION radar_analytics.ingest_product_identity_projection(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  v_filtered_payload jsonb;
BEGIN
  v_filtered_payload := jsonb_set(
    p_payload,
    '{memberships}',
    COALESCE((
      SELECT jsonb_agg(membership.value ORDER BY membership.ordinality)
      FROM jsonb_array_elements(COALESCE(p_payload -> 'memberships', '[]'::jsonb))
        WITH ORDINALITY AS membership(value, ordinality)
      JOIN radar_analytics.source_listings AS listing
        ON listing.source_id = membership.value ->> 'sourceId'
       AND listing.source_item_id = membership.value ->> 'sourceItemId'
    ), '[]'::jsonb),
    false
  );
  PERFORM radar_analytics.ingest_product_identity_projection_resolved(v_filtered_payload);
END
$$;

REVOKE ALL ON FUNCTION radar_analytics.ingest_product_identity_projection_resolved(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_product_identity_projection_resolved(jsonb)
  TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  TO radar_analytics_runtime;

COMMENT ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb) IS
  'Ingests only memberships backed by real source_listings; the complete projection remains retained in D1.';
