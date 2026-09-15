-- Created with the Supabase CLI and placed in the ordered migration directory.
-- Correct the stock snapshot to match catalog projectProduct: tracked items
-- default to a reorder threshold of five; an explicit zero remains zero.
-- Replace the canonical report without rewriting published migration 0557.
-- Owner business analytics: operational events and current cohorts, never a
-- cash ledger. Windows are UTC [from,to); snapshots are current recorded state.
-- The app supplies one as-of instant to both business and financial reports.
-- Only the bounded top-ten lists are previews; their population totals remain
-- exact in period/snapshot aggregates. No patient or staff identifiers return.
CREATE OR REPLACE FUNCTION resupply.owner_business_analytics(
  p_org_id uuid, p_from timestamptz, p_to timestamptz, p_as_of timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = '' SET timezone = 'UTC'
AS $$
BEGIN
  IF p_org_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_as_of IS NULL
     OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR NOT isfinite(p_as_of)
     OR p_to <= p_from OR p_to - p_from > interval '366 days' OR p_to > p_as_of THEN
    RAISE EXCEPTION 'invalid_analytics_window' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM resupply.organizations WHERE id = p_org_id) THEN
    RAISE EXCEPTION 'analytics_organization_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN (
    WITH windows(label, starts_at, ends_at) AS (
      VALUES ('current', p_from, p_to), ('previous', p_from - (p_to - p_from), p_from)
    ), patient_period AS MATERIALIZED (
      SELECT p.created_at FROM resupply.patients p
      WHERE p.org_id = p_org_id AND p.created_at >= p_from - (p_to - p_from) AND p.created_at < p_to
    ), order_period AS MATERIALIZED (
      SELECT o.created_at, o.signed_at, o.status FROM resupply.csr_order_requests o
      WHERE o.org_id = p_org_id AND o.created_at <= p_as_of AND
        ((o.created_at >= p_from - (p_to - p_from) AND o.created_at < p_to)
         OR (o.signed_at >= p_from - (p_to - p_from) AND o.signed_at < p_to))
    ), episode_period AS MATERIALIZED (
      SELECT e.id, e.created_at, e.status, e.closed_reason,
        EXISTS (SELECT 1 FROM resupply.fulfillments f
          WHERE f.org_id = p_org_id AND f.episode_id = e.id
            AND coalesce(f.shipped_at, f.delivered_at) <= p_as_of) AS shipment_evidence
      FROM resupply.episodes e
      WHERE e.org_id = p_org_id AND e.created_at >= p_from - (p_to - p_from) AND e.created_at < p_to
    ), fulfillment_period AS MATERIALIZED (
      SELECT f.id, f.patient_id, f.item_sku, f.quantity, f.status, f.created_at,
        coalesce(f.shipped_at, f.delivered_at) AS shipment_at
      FROM resupply.fulfillments f
      WHERE f.org_id = p_org_id AND f.created_at <= p_as_of AND
        ((f.created_at >= p_from - (p_to - p_from) AND f.created_at < p_to)
         OR (coalesce(f.shipped_at, f.delivered_at) >= p_from - (p_to - p_from)
             AND coalesce(f.shipped_at, f.delivered_at) < p_to))
    ), claim_period AS MATERIALIZED (
      SELECT c.created_at, c.status, c.payer_name, c.total_billed_cents, c.total_paid_cents
      FROM resupply.insurance_claims c
      WHERE c.org_id = p_org_id AND c.created_at >= p_from - (p_to - p_from) AND c.created_at < p_to
    ), fit_period AS MATERIALIZED (
      SELECT f.created_at, f.closed_at, f.closed_outcome FROM resupply.fitter_fit_requests f
      WHERE f.org_id = p_org_id AND f.created_at <= p_as_of AND
        ((f.created_at >= p_from - (p_to - p_from) AND f.created_at < p_to)
         OR (f.closed_at >= p_from - (p_to - p_from) AND f.closed_at < p_to))
    ), message_period AS MATERIALIZED (
      SELECT m.created_at, m.direction, left(lower(c.channel), 64) AS channel,
        m.direction = 'outbound' AND
          (m.delivered_at <= p_as_of OR (m.delivered_at IS NULL AND lower(m.delivery_status) IN ('delivered','read'))) AS delivered,
        m.direction = 'outbound' AND lower(m.delivery_status) IN ('failed','bounced','dropped','undelivered') AS failed
      FROM resupply.messages m
      JOIN resupply.conversations c ON c.id = m.conversation_id AND c.org_id = p_org_id
      WHERE m.org_id = p_org_id AND m.created_at >= p_from - (p_to - p_from) AND m.created_at < p_to
    ), event_values(ts, metric, value) AS (
      SELECT created_at, 'patientsAdded', 1::numeric FROM patient_period
      UNION ALL SELECT created_at, 'orderRequestsCreated', 1 FROM order_period
      UNION ALL SELECT signed_at, 'orderRequestsSigned', 1 FROM order_period WHERE signed_at IS NOT NULL
      UNION ALL SELECT e.created_at, v.metric, v.value FROM episode_period e
        CROSS JOIN LATERAL (VALUES
          ('episodesOpened', 1),
          ('episodesConfirmed', (e.status IN ('confirmed','fulfilled'))::int),
          ('episodesFulfilled', (e.status = 'fulfilled' AND (e.closed_reason IS DISTINCT FROM 'assumed_shipped' OR e.shipment_evidence))::int),
          ('episodesAssumedShipped', (e.status = 'fulfilled' AND e.closed_reason = 'assumed_shipped' AND NOT e.shipment_evidence)::int)
        ) v(metric,value)
      UNION ALL SELECT f.created_at, v.metric, v.value FROM fulfillment_period f
        CROSS JOIN LATERAL (VALUES ('fulfillmentLinesQueued', 1), ('unitsQueued', f.quantity)) v(metric,value)
        WHERE f.status NOT IN ('canceled','cancelled')
      UNION ALL SELECT shipment_at, 'shipmentLinesRecorded', 1 FROM fulfillment_period WHERE shipment_at IS NOT NULL
      UNION ALL SELECT c.created_at, v.metric, v.value FROM claim_period c
        CROSS JOIN LATERAL (VALUES ('claimsCreated', 1::numeric), ('claimBilledCents', c.total_billed_cents::numeric),
          ('claimPaidToDateCents', c.total_paid_cents::numeric)) v(metric,value)
      UNION ALL SELECT created_at, 'fitRequestsCreated', 1 FROM fit_period
      UNION ALL SELECT closed_at, 'fitRequestsFulfilled', 1 FROM fit_period WHERE closed_outcome = 'fulfilled' AND closed_at IS NOT NULL
      UNION ALL SELECT m.created_at, v.metric, v.value FROM message_period m
        CROSS JOIN LATERAL (VALUES ('outboundMessages', (m.direction = 'outbound')::int),
          ('inboundMessages', (m.direction = 'inbound')::int), ('deliveredMessages', m.delivered::int),
          ('failedMessages', m.failed::int)) v(metric,value)
    ), metric_names(metric) AS (
      SELECT unnest(ARRAY['patientsAdded','orderRequestsCreated','orderRequestsSigned','episodesOpened',
        'episodesConfirmed','episodesFulfilled','episodesAssumedShipped','fulfillmentLinesQueued','unitsQueued',
        'shipmentLinesRecorded','claimsCreated','claimBilledCents','claimPaidToDateCents','fitRequestsCreated',
        'fitRequestsFulfilled','outboundMessages','inboundMessages','deliveredMessages','failedMessages'])
    ), period_sums AS (
      SELECT w.label, e.metric, sum(e.value) AS value FROM windows w
      JOIN event_values e ON e.ts >= w.starts_at AND e.ts < w.ends_at GROUP BY w.label,e.metric
    ), served AS MATERIALIZED (
      SELECT DISTINCT w.label, w.starts_at, f.patient_id
      FROM windows w JOIN fulfillment_period f ON f.shipment_at >= w.starts_at AND f.shipment_at < w.ends_at
      JOIN resupply.patients p ON p.id = f.patient_id AND p.org_id = p_org_id
    ), served_totals AS (
      SELECT s.label, count(*) AS patients,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM resupply.fulfillments prior
          WHERE prior.org_id = p_org_id AND prior.patient_id = s.patient_id
            AND coalesce(prior.shipped_at, prior.delivered_at) < s.starts_at)) AS returning
      FROM served s GROUP BY s.label
    ), period_json AS (
      SELECT w.label, jsonb_object_agg(m.metric, coalesce(p.value,0)) ||
        jsonb_build_object('patientsServed', coalesce(s.patients,0), 'returningPatientsServed', coalesce(s.returning,0)) AS data
      FROM windows w CROSS JOIN metric_names m
      LEFT JOIN period_sums p ON p.label = w.label AND p.metric = m.metric
      LEFT JOIN served_totals s ON s.label = w.label GROUP BY w.label,s.patients,s.returning
    ), open_claims AS MATERIALIZED (
      SELECT c.status, c.total_billed_cents, c.total_paid_cents, c.submitted_at, c.created_at
      FROM resupply.insurance_claims c
      WHERE c.org_id = p_org_id AND c.status NOT IN ('paid','closed') AND c.created_at <= p_as_of
    ), inventory AS MATERIALIZED (
      SELECT p.sku, p.name, p.stock_count,
        CASE WHEN p.stock_count IS NOT NULL THEN coalesce(p.low_stock_threshold, 5) END AS low_stock_threshold
      FROM resupply.products p WHERE p.org_id = p_org_id AND p.active AND p.created_at <= p_as_of
    ), low_stock AS MATERIALIZED (
      SELECT * FROM inventory WHERE stock_count IS NOT NULL AND low_stock_threshold IS NOT NULL
        AND stock_count <= low_stock_threshold
    ), scheduled_patients AS MATERIALIZED (
      SELECT DISTINCT e.patient_id,
        bool_or(e.due_at <= p_as_of) AS due,
        bool_or(e.due_at > p_as_of AND e.due_at <= p_as_of + interval '30 days') AS soon
      FROM resupply.episodes e
      JOIN resupply.patients p ON p.id = e.patient_id AND p.org_id = p_org_id AND p.status = 'active'
      JOIN resupply.prescriptions rx ON rx.id = e.prescription_id AND rx.org_id = p_org_id
        AND rx.patient_id = p.id AND rx.status = 'active'
        AND rx.valid_from <= p_as_of::date AND (rx.valid_until IS NULL OR rx.valid_until >= p_as_of::date)
      WHERE e.org_id = p_org_id AND e.status IN ('outreach_pending','awaiting_response')
        AND e.created_at <= p_as_of AND (e.expires_at IS NULL OR e.expires_at > p_as_of)
        AND e.due_at <= p_as_of + interval '30 days'
      GROUP BY e.patient_id
    ), snapshot AS (
      SELECT jsonb_build_object(
        'activePatients', (SELECT count(*) FROM resupply.patients WHERE org_id=p_org_id AND status='active' AND created_at<=p_as_of),
        'pausedPatients', (SELECT count(*) FROM resupply.patients WHERE org_id=p_org_id AND status='paused' AND created_at<=p_as_of),
        'openConversations', (SELECT count(*) FROM resupply.conversations WHERE org_id=p_org_id AND status IN ('open','awaiting_admin','awaiting_patient') AND created_at<=p_as_of),
        'awaitingStaffConversations', (SELECT count(*) FROM resupply.conversations WHERE org_id=p_org_id AND status='awaiting_admin' AND created_at<=p_as_of),
        'unassignedConversations', (SELECT count(*) FROM resupply.conversations WHERE org_id=p_org_id AND status IN ('open','awaiting_admin','awaiting_patient') AND assigned_admin_user_id IS NULL AND created_at<=p_as_of),
        'overdueSlaConversations', (SELECT count(*) FROM resupply.conversations WHERE org_id=p_org_id AND status IN ('open','awaiting_admin','awaiting_patient') AND sla_due_at<p_as_of AND created_at<=p_as_of),
        'dueResupplyPatients', (SELECT count(*) FROM scheduled_patients WHERE due),
        'dueSoonResupplyPatients', (SELECT count(*) FROM scheduled_patients WHERE soon),
        'addressHoldEpisodes', (SELECT count(*) FROM resupply.episodes WHERE org_id=p_org_id AND status='address_hold' AND created_at<=p_as_of),
        'pendingSignatures', (SELECT count(*) FROM resupply.csr_order_requests WHERE org_id=p_org_id AND status IN ('sent','viewed') AND signed_at IS NULL AND (expires_at IS NULL OR expires_at>p_as_of) AND created_at<=p_as_of),
        'expiredSignatures', (SELECT count(*) FROM resupply.csr_order_requests WHERE org_id=p_org_id AND status IN ('sent','viewed') AND signed_at IS NULL AND expires_at<=p_as_of AND created_at<=p_as_of),
        'unbilledShipmentLines', (SELECT count(*) FROM resupply.fulfillments f WHERE f.org_id=p_org_id
          AND coalesce(f.shipped_at,f.delivered_at)<=p_as_of
          AND NOT EXISTS (SELECT 1 FROM resupply.insurance_claims c WHERE c.org_id=p_org_id AND c.fulfillment_id=f.id AND c.created_at<=p_as_of)),
        'draftClaims', (SELECT count(*) FROM open_claims WHERE status='draft'),
        'deniedClaims', (SELECT count(*) FROM open_claims WHERE status IN ('denied','appealed')),
        'unacknowledgedClaims', (SELECT count(*) FROM open_claims WHERE status='submitted' AND submitted_at<=p_as_of-interval '48 hours'),
        'openClaims', (SELECT count(*) FROM open_claims),
        'openClaimBilledCents', (SELECT coalesce(sum(total_billed_cents::numeric),0) FROM open_claims),
        'openClaimPaidCents', (SELECT coalesce(sum(total_paid_cents::numeric),0) FROM open_claims),
        'openFitRequests', (SELECT count(*) FROM resupply.fitter_fit_requests WHERE org_id=p_org_id AND status<>'closed' AND created_at<=p_as_of),
        'activeProducts', (SELECT count(*) FROM inventory),
        'trackedProducts', (SELECT count(*) FROM inventory WHERE stock_count IS NOT NULL),
        'untrackedProducts', (SELECT count(*) FROM inventory WHERE stock_count IS NULL),
        'lowStockProducts', (SELECT count(*) FROM low_stock),
        'outOfStockProducts', (SELECT count(*) FROM inventory WHERE stock_count=0)
      ) AS data
    ), days AS (
      SELECT d::date AS day FROM generate_series(date_trunc('day',p_from),date_trunc('day',p_to-interval '1 microsecond'),interval '1 day') d
    ), daily_sums AS (
      SELECT e.ts::date AS day, e.metric, sum(e.value) AS value FROM event_values e
      WHERE e.ts>=p_from AND e.ts<p_to AND e.metric IN ('orderRequestsCreated','orderRequestsSigned','episodesOpened','shipmentLinesRecorded','patientsAdded')
      GROUP BY e.ts::date,e.metric
    ), daily_json AS (
      SELECT d.day, jsonb_build_object('date',to_char(d.day,'YYYY-MM-DD')) || jsonb_object_agg(m.metric,coalesce(s.value,0)) AS data
      FROM days d CROSS JOIN (VALUES ('orderRequestsCreated'),('orderRequestsSigned'),('episodesOpened'),('shipmentLinesRecorded'),('patientsAdded')) m(metric)
      LEFT JOIN daily_sums s ON s.day=d.day AND s.metric=m.metric GROUP BY d.day
    ), claim_aging AS (
      SELECT CASE WHEN p_as_of-coalesce(submitted_at,created_at)<interval '31 days' THEN '0_30'
        WHEN p_as_of-coalesce(submitted_at,created_at)<interval '61 days' THEN '31_60'
        WHEN p_as_of-coalesce(submitted_at,created_at)<interval '91 days' THEN '61_90' ELSE 'over_90' END AS bucket,
        count(*) AS n,sum(total_billed_cents::numeric) AS billed,sum(total_paid_cents::numeric) AS paid
      FROM open_claims GROUP BY 1
    ), current_payers AS (
      SELECT payer_name AS payer,count(*) AS claims,sum(total_billed_cents::numeric) AS billed,
        sum(total_paid_cents::numeric) AS paid,count(*) FILTER(WHERE status IN ('denied','appealed')) AS denied
      FROM claim_period WHERE created_at>=p_from AND created_at<p_to GROUP BY payer_name
      ORDER BY billed DESC,payer_name LIMIT 10
    ), current_products AS (
      SELECT f.item_sku AS sku,sum(f.quantity::numeric) AS units,count(*) AS lines
      FROM fulfillment_period f WHERE f.shipment_at>=p_from AND f.shipment_at<p_to
      GROUP BY f.item_sku ORDER BY units DESC,f.item_sku LIMIT 10
    )
    SELECT jsonb_build_object(
      'current',(SELECT data FROM period_json WHERE label='current'),
      'previous',(SELECT data FROM period_json WHERE label='previous'),
      'snapshot',(SELECT data FROM snapshot),
      'daily',(SELECT coalesce(jsonb_agg(data ORDER BY day),'[]'::jsonb) FROM daily_json),
      'orderRequestStages',(SELECT coalesce(jsonb_agg(jsonb_build_object('status',status,'count',n) ORDER BY status),'[]'::jsonb)
        FROM (SELECT status,count(*) n FROM order_period WHERE created_at>=p_from AND created_at<p_to GROUP BY status) q),
      'resupplyStages',(SELECT coalesce(jsonb_agg(jsonb_build_object('status',status,'count',n) ORDER BY status),'[]'::jsonb)
        FROM (SELECT status,count(*) n FROM episode_period WHERE created_at>=p_from AND created_at<p_to GROUP BY status) q),
      'claimStages',(SELECT coalesce(jsonb_agg(jsonb_build_object('status',status,'count',n,'billedCents',billed,'paidCents',paid) ORDER BY status),'[]'::jsonb)
        FROM (SELECT status,count(*) n,sum(total_billed_cents::numeric) billed,sum(total_paid_cents::numeric) paid FROM claim_period WHERE created_at>=p_from AND created_at<p_to GROUP BY status) q),
      'claimAging',(SELECT jsonb_agg(jsonb_build_object('bucket',b.bucket,'count',coalesce(a.n,0),'billedCents',coalesce(a.billed,0),'paidCents',coalesce(a.paid,0)) ORDER BY b.ordinal)
        FROM (VALUES ('0_30',1),('31_60',2),('61_90',3),('over_90',4)) b(bucket,ordinal) LEFT JOIN claim_aging a ON a.bucket=b.bucket),
      'payers',(SELECT coalesce(jsonb_agg(jsonb_build_object('payer',payer,'claims',claims,'billedCents',billed,'paidCents',paid,'deniedClaims',denied) ORDER BY billed DESC,payer),'[]'::jsonb) FROM current_payers),
      'topProducts',(SELECT coalesce(jsonb_agg(jsonb_build_object('sku',f.sku,'name',p.name,'units',f.units,'fulfillmentLines',f.lines) ORDER BY f.units DESC,f.sku),'[]'::jsonb)
        FROM current_products f LEFT JOIN resupply.products p ON p.org_id=p_org_id AND p.sku=f.sku),
      'lowStock',(SELECT coalesce(jsonb_agg(jsonb_build_object('sku',sku,'name',name,'stockCount',stock_count,'threshold',low_stock_threshold) ORDER BY stock_count,sku),'[]'::jsonb)
        FROM (SELECT * FROM low_stock ORDER BY stock_count,sku LIMIT 10) q),
      'outreachChannels',(SELECT coalesce(jsonb_agg(jsonb_build_object('channel',channel,'inbound',inbound,'outbound',outbound,'delivered',delivered,'failed',failed) ORDER BY outbound DESC,channel),'[]'::jsonb)
        FROM (SELECT channel,count(*) FILTER(WHERE direction='inbound') AS inbound,count(*) FILTER(WHERE direction='outbound') AS outbound,
          count(*) FILTER(WHERE delivered) AS delivered,count(*) FILTER(WHERE failed) AS failed
          FROM message_period WHERE created_at>=p_from AND created_at<p_to GROUP BY channel ORDER BY outbound DESC,channel LIMIT 20) q)
    )
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.owner_business_analytics(uuid,timestamptz,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.owner_business_analytics(uuid,timestamptz,timestamptz,timestamptz) TO service_role;
