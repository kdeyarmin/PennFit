-- Commit a patient signature, document acknowledgements, and completion as
-- one transaction. Previously a later write failure left a signature on an
-- open packet, and two callers could insert signatures before either one
-- reached the final optimistic status guard.
CREATE OR REPLACE FUNCTION resupply.finalize_patient_packet(
  p_org_id uuid,
  p_packet_id uuid,
  p_link_version integer,
  p_document_keys text[],
  p_signature jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, resupply
AS $$
DECLARE
  v_packet resupply.patient_packets%ROWTYPE;
  v_keys text[];
  v_signed_at timestamptz;
BEGIN
  SELECT * INTO v_packet
    FROM resupply.patient_packets
   WHERE id = p_packet_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  -- Revocation always wins, even when a packet has since been completed.
  IF v_packet.link_version IS DISTINCT FROM p_link_version THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF v_packet.status = 'voided' THEN RETURN jsonb_build_object('status', 'voided'); END IF;
  IF v_packet.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed', 'completed_at', v_packet.completed_at);
  END IF;
  -- Use the clock after acquiring the lock, not the transaction start: a
  -- queued request must not outlive the packet's signing deadline.
  v_signed_at := clock_timestamp();
  IF v_packet.status = 'expired' OR v_packet.expires_at <= v_signed_at THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;
  IF v_packet.status NOT IN ('draft', 'sent', 'viewed') THEN
    RETURN jsonb_build_object('status', 'concurrent_modification');
  END IF;

  SELECT coalesce(array_agg(document_key ORDER BY document_key), '{}'::text[])
    INTO v_keys FROM (
      SELECT document_key FROM resupply.patient_packet_documents
       WHERE packet_id = p_packet_id AND org_id = p_org_id
       ORDER BY document_key FOR UPDATE
    ) AS locked_documents;
  -- Clinical choices were validated against precisely this set by the
  -- route. If staff changed the packet during that read, require a refresh.
  IF cardinality(v_keys) = 0 THEN RETURN jsonb_build_object('status', 'documents_required'); END IF;
  IF v_keys IS DISTINCT FROM ARRAY(SELECT unnest(p_document_keys) ORDER BY 1) THEN
    RETURN jsonb_build_object('status', 'concurrent_modification');
  END IF;

  -- Do not overwrite or add to an incomplete signature left by the old
  -- multi-request writer. Staff must review that existing signed artifact.
  IF EXISTS (SELECT 1 FROM resupply.patient_packet_signatures
              WHERE packet_id = p_packet_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('status', 'concurrent_modification');
  END IF;

  INSERT INTO resupply.patient_packet_signatures (
    org_id, packet_id, signer_name, signer_relationship, signature_image,
    consent_esign, acknowledged_document_keys, signed_at, signer_ip,
    signer_user_agent, signer_reason, date_received, document_choices
  ) VALUES (
    p_org_id, p_packet_id, p_signature->>'signer_name',
    p_signature->>'signer_relationship', p_signature->>'signature_image',
    true, v_keys, v_signed_at, p_signature->>'signer_ip',
    p_signature->>'signer_user_agent', p_signature->>'signer_reason',
    (p_signature->>'date_received')::date, nullif(p_signature->'document_choices', 'null'::jsonb)
  );

  UPDATE resupply.patient_packet_documents
     SET acknowledged = true, acknowledged_at = v_signed_at
   WHERE packet_id = p_packet_id AND org_id = p_org_id;

  -- Completion closes writes. Keep the current version so the same valid
  -- link can display generic completion and safely recover a lost reply.
  -- Resend/void remain responsible for revoking old versions.
  UPDATE resupply.patient_packets
     SET status = 'completed', completed_at = v_signed_at, updated_at = v_signed_at
   WHERE id = p_packet_id AND org_id = p_org_id;

  RETURN jsonb_build_object('status', 'completed', 'completed_at', v_signed_at);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.finalize_patient_packet(uuid, uuid, integer, text[], jsonb)
  FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.finalize_patient_packet(uuid, uuid, integer, text[], jsonb)
  TO service_role;
--> statement-breakpoint

-- The editor shares the signing lock. An edit either commits an entirely
-- new revision first, or observes a completed packet and changes nothing.
CREATE OR REPLACE FUNCTION resupply.update_patient_packet(
  p_org_id uuid, p_packet_id uuid, p_link_version integer,
  p_document_keys text[], p_documents jsonb, p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, resupply
AS $$
DECLARE
  v_packet resupply.patient_packets%ROWTYPE;
  v_existing text[];
  v_keys text[];
BEGIN
  SELECT * INTO v_packet FROM resupply.patient_packets
   WHERE id = p_packet_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_packet.status IN ('completed', 'voided') THEN
    RETURN jsonb_build_object('status', 'packet_closed');
  END IF;
  IF v_packet.link_version IS DISTINCT FROM p_link_version THEN
    RETURN jsonb_build_object('status', 'concurrent_modification');
  END IF;
  IF EXISTS (SELECT 1 FROM resupply.patient_packet_signatures
              WHERE packet_id = p_packet_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('status', 'packet_closed');
  END IF;

  SELECT coalesce(array_agg(document_key ORDER BY sort_order, document_key), '{}'::text[])
    INTO v_existing FROM (
      SELECT document_key, sort_order FROM resupply.patient_packet_documents
       WHERE packet_id = p_packet_id AND org_id = p_org_id
       ORDER BY document_key FOR UPDATE
    ) AS locked_documents;
  v_keys := coalesce(p_document_keys, v_existing);
  IF cardinality(v_keys) = 0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_documents) d
     WHERE NOT ((d->>'document_key') = ANY(v_keys))
  ) THEN
    RETURN jsonb_build_object('status', 'invalid_document_overrides');
  END IF;

  DELETE FROM resupply.patient_packet_documents
   WHERE packet_id = p_packet_id AND org_id = p_org_id
     AND NOT (document_key = ANY(v_keys));

  INSERT INTO resupply.patient_packet_documents AS existing (
    org_id, packet_id, document_key, title, content_version, content_sections,
    sort_order, requires_signature
  ) SELECT p_org_id, p_packet_id, d->>'document_key', d->>'title',
           d->>'content_version', d->'content_sections',
           (d->>'sort_order')::integer, (d->>'requires_signature')::boolean
      FROM jsonb_array_elements(p_documents) d
  ON CONFLICT (packet_id, document_key) DO UPDATE SET
    title = EXCLUDED.title, content_version = EXCLUDED.content_version,
    content_sections = EXCLUDED.content_sections,
    requires_signature = EXCLUDED.requires_signature,
    acknowledged = false, acknowledged_at = NULL
  WHERE existing.org_id = p_org_id;

  UPDATE resupply.patient_packet_documents
     SET sort_order = array_position(v_keys, document_key) - 1
   WHERE packet_id = p_packet_id AND org_id = p_org_id;
  -- Missing new snapshots are a programming error. Raising rolls back
  -- all edits instead of persisting an incomplete requested document set.
  IF (SELECT count(*) FROM resupply.patient_packet_documents
       WHERE packet_id = p_packet_id AND org_id = p_org_id) <> cardinality(v_keys) THEN
    RAISE EXCEPTION 'incomplete_packet_documents';
  END IF;

  UPDATE resupply.patient_packets SET
    title = CASE WHEN p_patch ? 'title' THEN p_patch->>'title' ELSE title END,
    delivery_details = CASE WHEN p_patch ? 'delivery_details'
      THEN nullif(p_patch->'delivery_details', 'null'::jsonb) ELSE delivery_details END,
    link_version = link_version + 1, updated_at = clock_timestamp()
   WHERE id = p_packet_id AND org_id = p_org_id;
  RETURN jsonb_build_object('status', 'updated');
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.update_patient_packet(uuid, uuid, integer, text[], jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.update_patient_packet(uuid, uuid, integer, text[], jsonb, jsonb)
  TO service_role;
--> statement-breakpoint

-- Never expose a sent envelope before its document snapshots exist.
CREATE OR REPLACE FUNCTION resupply.create_patient_packet(
  p_org_id uuid, p_packet jsonb, p_documents jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, resupply
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_documents IS NULL OR jsonb_typeof(p_documents) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'packet_documents_required';
  END IF;
  IF jsonb_array_length(p_documents) = 0 THEN
    RAISE EXCEPTION 'packet_documents_required';
  END IF;
  INSERT INTO resupply.patient_packets (
    org_id, patient_id, title, status, recipient_name, recipient_email,
    recipient_phone, link_version, sent_at, expires_at, created_by_email, delivery_details
  ) VALUES (
    p_org_id, (p_packet->>'patient_id')::uuid, p_packet->>'title', 'sent',
    p_packet->>'recipient_name', p_packet->>'recipient_email', p_packet->>'recipient_phone',
    1, (p_packet->>'sent_at')::timestamptz, (p_packet->>'expires_at')::timestamptz,
    p_packet->>'created_by_email', nullif(p_packet->'delivery_details', 'null'::jsonb)
  ) RETURNING id INTO v_id;
  INSERT INTO resupply.patient_packet_documents (
    org_id, packet_id, document_key, title, content_version, content_sections, sort_order, requires_signature
  ) SELECT p_org_id, v_id, d->>'document_key', d->>'title', d->>'content_version',
           d->'content_sections', (d->>'sort_order')::integer, (d->>'requires_signature')::boolean
      FROM jsonb_array_elements(p_documents) d;
  RETURN jsonb_build_object('id', v_id, 'link_version', 1);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.create_patient_packet(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.create_patient_packet(uuid, jsonb, jsonb)
  TO service_role;
