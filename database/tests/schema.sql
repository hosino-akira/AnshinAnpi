-- Uses synthetic bytes only. All fixture data and temporary helpers are rolled back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = public, pg_catalog;

CREATE FUNCTION pg_temp.expect_error(label text, statement text, expected_state text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
    BEGIN
        EXECUTE statement;
        SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
        IF actual_state <> expected_state THEN
            RAISE EXCEPTION '%: expected SQLSTATE %, got % (%)', label, expected_state, actual_state, SQLERRM;
        END IF;
        RAISE NOTICE 'PASS: %', label;
        RETURN;
    END;
    RAISE EXCEPTION '%: invalid data was accepted', label;
END;
$$;

DO $$
DECLARE
    facility uuid;
    terminal uuid;
    person uuid;
    other_person uuid;
    recipient_one uuid;
    recipient_two uuid;
    other_recipient uuid;
    template uuid;
    registration_consent uuid;
    send_consent uuid;
    denied_consent uuid;
    face_check uuid;
    send_face_check uuid;
    registration_event uuid;
    send_event uuid;
    first_delivery uuid;
    second_delivery uuid;
    entry bigint;
    old_version bigint;
    policy text := 'test-' || gen_random_uuid()::text;
    cipher bytea := decode('aabbccdd', 'hex');
    digest_one bytea := decode(repeat('01', 32), 'hex');
    digest_two bytea := decode(repeat('02', 32), 'hex');
    current_time_value timestamptz := current_timestamp;
BEGIN
    INSERT INTO facilities(facility_code, name) VALUES ('test-' || gen_random_uuid(), 'Database test facility') RETURNING facility_id INTO facility;
    INSERT INTO terminals(facility_id, terminal_code, name, status)
        VALUES (facility, 'test-' || gen_random_uuid(), 'Test terminal', 'active') RETURNING terminal_id INTO terminal;
    INSERT INTO consent_policies(policy_version, consent_type, title, body, content_sha256, status, published_at)
        VALUES (policy, 'registration', 'Test registration policy', 'Synthetic test content', digest_one, 'published', current_time_value),
               (policy, 'safety', 'Test send policy', 'Synthetic test content', digest_one, 'published', current_time_value);
    INSERT INTO users(facility_id, encrypted_display_name, display_name_lookup_hmac, encryption_key_id, lookup_key_id)
        VALUES (facility, cipher, digest_one, 'test-encryption', 'test-lookup') RETURNING user_id INTO person;
    INSERT INTO users(facility_id, encrypted_display_name, display_name_lookup_hmac, encryption_key_id, lookup_key_id)
        VALUES (facility, cipher, digest_two, 'test-encryption', 'test-lookup') RETURNING user_id INTO other_person;

    PERFORM pg_temp.expect_error('active user requires a recipient',
        format('UPDATE users SET status = %L, registered_at = current_timestamp WHERE user_id = %L', 'active', person), '23514');
    INSERT INTO recipients(user_id, encrypted_name, encrypted_email, email_lookup_hmac, encryption_key_id, lookup_key_id, order_no)
        VALUES (person, cipher, cipher, digest_one, 'test-encryption', 'test-lookup', 1) RETURNING recipient_id INTO recipient_one;
    UPDATE users SET status = 'active', registered_at = current_time_value WHERE user_id = person;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    PERFORM pg_temp.expect_error('cannot delete the last active-user contact',
        format('DELETE FROM recipients WHERE recipient_id = %L', recipient_one), '23514');
    PERFORM pg_temp.expect_error('cannot logically delete the last active-user contact',
        format('UPDATE recipients SET status = %L, deleted_at = current_timestamp, purge_after = current_timestamp + interval ''30 days'' WHERE recipient_id = %L', 'deleted', recipient_one), '23514');
    INSERT INTO recipients(user_id, encrypted_name, encrypted_email, email_lookup_hmac, encryption_key_id, lookup_key_id, order_no)
        VALUES (person, cipher, cipher, digest_two, 'test-encryption', 'test-lookup', 2) RETURNING recipient_id INTO recipient_two;
    INSERT INTO recipients(user_id, encrypted_name, encrypted_email, email_lookup_hmac, encryption_key_id, lookup_key_id, order_no)
        VALUES (other_person, cipher, cipher, digest_one, 'test-encryption', 'test-lookup', 1) RETURNING recipient_id INTO other_recipient;
    PERFORM pg_temp.expect_error('only two contact slots', format('UPDATE recipients SET order_no = 3 WHERE recipient_id = %L', recipient_two), '23514');
    PERFORM pg_temp.expect_error('contact slot is unique per user', format('UPDATE recipients SET order_no = 1 WHERE recipient_id = %L', recipient_two), '23505');
    PERFORM pg_temp.expect_error('duplicate normalized email is rejected',
        format('UPDATE recipients SET email_lookup_hmac = %L WHERE recipient_id = %L', digest_one, recipient_two), '23505');
    PERFORM pg_temp.expect_error('contact cannot move between users',
        format('UPDATE recipients SET user_id = %L WHERE recipient_id = %L', other_person, recipient_two), '23514');
    RAISE NOTICE 'PASS: one and two contacts accepted; same email allowed for different users';

    INSERT INTO consents(user_id, consent_type, policy_version, terminal_id, result)
        VALUES (person, 'registration', policy, terminal, 'granted') RETURNING consent_id INTO registration_consent;
    INSERT INTO consents(user_id, consent_type, policy_version, terminal_id, result)
        VALUES (person, 'safety', policy, terminal, 'granted') RETURNING consent_id INTO send_consent;
    INSERT INTO consents(user_id, consent_type, policy_version, terminal_id, result)
        VALUES (person, 'safety', policy, terminal, 'denied') RETURNING consent_id INTO denied_consent;
    PERFORM pg_temp.expect_error('published policy text is immutable',
        format('UPDATE consent_policies SET body = %L WHERE policy_version = %L', 'Changed', policy), '23514');
    PERFORM pg_temp.expect_error('consent decisions are immutable',
        format('UPDATE consents SET result = %L WHERE consent_id = %L', 'denied', send_consent), '23514');
    PERFORM pg_temp.expect_error('consent cannot change to another user',
        format('UPDATE consents SET user_id = %L WHERE consent_id = %L', other_person, send_consent), '23514');

    INSERT INTO face_templates(user_id, encrypted_template, encryption_key_id, provider, model_version, threshold_version)
        VALUES (person, cipher, 'test-encryption', 'test-face-provider', 'v1', 'v1') RETURNING template_id INTO template;
    PERFORM pg_temp.expect_error('only one active face template',
        format('INSERT INTO face_templates(user_id, encrypted_template, encryption_key_id, provider, model_version, threshold_version) VALUES (%L, %L, %L, %L, %L, %L)',
            person, cipher, 'test-encryption', 'test-face-provider', 'v2', 'v1'), '23505');
    INSERT INTO face_verifications(user_id, template_id, terminal_id, purpose, result, match_score, threshold,
            required_margin, model_version, threshold_version, quality_passed, liveness_passed)
        VALUES (person, template, terminal, 'registration', 'matched', 0.95, 0.85, 0.1, 'v1', 'v1', true, true)
        RETURNING verification_id INTO face_check;
    INSERT INTO face_verifications(user_id, template_id, terminal_id, purpose, result, match_score, runner_up_score,
            threshold, required_margin, model_version, threshold_version, quality_passed, liveness_passed)
        VALUES (person, template, terminal, 'safety', 'matched', 0.95, 0.5, 0.85, 0.1, 'v1', 'v1', true, true)
        RETURNING verification_id INTO send_face_check;
    PERFORM pg_temp.expect_error('liveness failure cannot be a match',
        format('UPDATE face_verifications SET liveness_passed = false WHERE verification_id = %L', face_check), '23514');
    PERFORM pg_temp.expect_error('ambiguous face margin cannot be a match',
        format('UPDATE face_verifications SET runner_up_score = 0.94 WHERE verification_id = %L', send_face_check), '23514');

    INSERT INTO safety_checks(user_id, terminal_id, check_type, verification_id, verified_at, consent_id,
            idempotency_key, request_sha256, expires_at)
        VALUES (person, terminal, 'registration', face_check, current_time_value, registration_consent,
            'test-registration', digest_one, current_time_value + interval '5 minutes') RETURNING check_id INTO registration_event;
    PERFORM pg_temp.expect_error('denied consent cannot authorize sending',
        format('INSERT INTO safety_checks(user_id, terminal_id, verification_id, verified_at, consent_id, idempotency_key, request_sha256, expires_at) VALUES (%L, %L, %L, %L, %L, %L, %L, current_timestamp + interval ''5 minutes'')',
            person, terminal, send_face_check, current_time_value, denied_consent, 'denied-send', digest_one), '23514');
    PERFORM pg_temp.expect_error('a user cannot use another user''s evidence',
        format('INSERT INTO safety_checks(user_id, terminal_id, check_type, verification_id, verified_at, consent_id, idempotency_key, request_sha256, expires_at) VALUES (%L, %L, %L, %L, %L, %L, %L, %L, current_timestamp + interval ''5 minutes'')',
            other_person, terminal, 'registration', send_face_check, current_time_value, send_consent, 'foreign-send', digest_one), '23503');
    INSERT INTO safety_checks(user_id, terminal_id, verification_id, verified_at, consent_id,
            idempotency_key, request_sha256, expires_at)
        VALUES (person, terminal, send_face_check, current_time_value, send_consent,
            'test-safety', digest_one, current_time_value + interval '5 minutes') RETURNING check_id INTO send_event;
    PERFORM pg_temp.expect_error('idempotency key cannot be reused',
        format('UPDATE safety_checks SET idempotency_key = %L WHERE check_id = %L', 'test-registration', send_event), '23505');
    PERFORM pg_temp.expect_error('one consent cannot authorize a second event',
        format('INSERT INTO safety_checks(user_id, terminal_id, verification_id, verified_at, consent_id, idempotency_key, request_sha256, expires_at) VALUES (%L, %L, %L, %L, %L, %L, %L, current_timestamp + interval ''5 minutes'')',
            person, terminal, send_face_check, current_time_value, send_consent, 'test-replay', digest_one), '23505');

    INSERT INTO mail_deliveries(check_id, user_id, recipient_id, recipient_order_no, encrypted_email_snapshot, encryption_key_id, provider)
        VALUES (send_event, person, recipient_one, 1, cipher, 'test-encryption', 'test-mail-provider') RETURNING delivery_id INTO first_delivery;
    INSERT INTO mail_deliveries(check_id, user_id, recipient_id, recipient_order_no, encrypted_email_snapshot, encryption_key_id, provider)
        VALUES (send_event, person, recipient_two, 2, cipher, 'test-encryption', 'test-mail-provider') RETURNING delivery_id INTO second_delivery;
    PERFORM pg_temp.expect_error('one mail per event and recipient',
        format('INSERT INTO mail_deliveries(check_id, user_id, recipient_id, recipient_order_no, encrypted_email_snapshot, encryption_key_id, provider) VALUES (%L, %L, %L, 1, %L, %L, %L)',
            send_event, person, recipient_one, cipher, 'test-encryption', 'test-mail-provider'), '23505');
    PERFORM pg_temp.expect_error('cannot send to another user''s contact',
        format('INSERT INTO mail_deliveries(check_id, user_id, recipient_id, recipient_order_no, encrypted_email_snapshot, encryption_key_id, provider) VALUES (%L, %L, %L, 1, %L, %L, %L)',
            send_event, person, other_recipient, cipher, 'test-encryption', 'test-mail-provider'), '23514');
    PERFORM pg_temp.expect_error('accepted mail needs provider acceptance evidence',
        format('UPDATE mail_deliveries SET status = %L WHERE delivery_id = %L', 'accepted', first_delivery), '23514');
    PERFORM pg_temp.expect_error('no fourth sending attempt',
        format('UPDATE mail_deliveries SET attempt_count = 4 WHERE delivery_id = %L', first_delivery), '23514');
    UPDATE mail_deliveries SET status = 'accepted', attempt_count = 1, accepted_at = current_time_value,
        provider_message_id = 'test-message-' || first_delivery WHERE delivery_id = first_delivery;
    UPDATE mail_deliveries SET status = 'failed', attempt_count = 3, error_code = 'MAIL-001' WHERE delivery_id = second_delivery;
    UPDATE safety_checks SET status = 'partially_accepted', completed_at = current_time_value WHERE check_id = send_event;
    RAISE NOTICE 'PASS: partial acceptance and independent recipient results';

    INSERT INTO mail_delivery_events(delivery_id, provider, provider_event_id, provider_message_id, event_type, occurred_at)
        VALUES (first_delivery, 'test-mail-provider', 'test-event-' || first_delivery, 'test-message-' || first_delivery, 'delivered', current_time_value);
    PERFORM pg_temp.expect_error('duplicate webhook event is rejected',
        format('INSERT INTO mail_delivery_events(provider, provider_event_id, provider_message_id, event_type, occurred_at) VALUES (%L, %L, %L, %L, current_timestamp)',
            'test-mail-provider', 'test-event-' || first_delivery, 'test-message-' || first_delivery, 'delivered'), '23505');
    UPDATE mail_deliveries SET status = 'delivered', delivered_at = current_time_value WHERE delivery_id = first_delivery;
    SELECT row_version INTO old_version FROM users WHERE user_id = person;
    UPDATE users SET encrypted_display_name = cipher WHERE user_id = person;
    IF (SELECT row_version FROM users WHERE user_id = person) <> old_version + 1 THEN
        RAISE EXCEPTION 'row_version did not advance';
    END IF;
    RAISE NOTICE 'PASS: update timestamp and optimistic version trigger';

    INSERT INTO audit_logs(actor_type, action, target_type, target_id, result, entry_hmac, signing_key_id)
        VALUES ('system', 'schema.test', 'user', person::text, 'success', digest_one, 'test-signing') RETURNING log_id INTO entry;
    PERFORM pg_temp.expect_error('audit log cannot be edited',
        format('UPDATE audit_logs SET result = %L WHERE log_id = %s', 'failure', entry), '23514');
    PERFORM pg_temp.expect_error('audit log cannot be removed before retention deadline',
        format('DELETE FROM audit_logs WHERE log_id = %s', entry), '23514');
    PERFORM pg_temp.expect_error('audit log cannot be truncated', 'TRUNCATE audit_logs', '23514');

    DELETE FROM recipients WHERE recipient_id = recipient_one;
    IF NOT EXISTS (SELECT 1 FROM mail_deliveries WHERE delivery_id = first_delivery
        AND recipient_id IS NULL AND encrypted_email_snapshot IS NULL AND snapshot_erased_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Recipient erase did not remove its retained email snapshot';
    END IF;
    RAISE NOTICE 'PASS: contact removal erases the historical email snapshot';
    DELETE FROM users WHERE user_id = person;
    SET CONSTRAINTS ALL IMMEDIATE;
    IF EXISTS (SELECT 1 FROM recipients WHERE user_id = person)
        OR EXISTS (SELECT 1 FROM face_templates WHERE user_id = person)
        OR EXISTS (SELECT 1 FROM consents WHERE user_id = person)
        OR EXISTS (SELECT 1 FROM mail_deliveries WHERE user_id = person OR (delivery_id IN (first_delivery, second_delivery) AND encrypted_email_snapshot IS NOT NULL)) THEN
        RAISE EXCEPTION 'User erasure left personal records behind';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM consents WHERE consent_id = send_consent AND user_id IS NULL AND subject_erased_at IS NOT NULL)
        OR NOT EXISTS (SELECT 1 FROM safety_checks WHERE check_id = send_event AND user_id IS NULL)
        OR NOT EXISTS (SELECT 1 FROM audit_logs WHERE log_id = entry) THEN
        RAISE EXCEPTION 'User erasure removed retained evidence';
    END IF;
    RAISE NOTICE 'PASS: user erasure cascades to biometrics and contacts while retaining de-identified evidence';
END;
$$;
ROLLBACK;
\echo 'All database constraint tests passed. Fixture data rolled back.'
