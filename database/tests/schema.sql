\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE tables text[]; person uuid; cipher bytea:=decode('010203','hex');
BEGIN
 SELECT array_agg(tablename::text ORDER BY tablename) INTO tables FROM pg_tables WHERE schemaname='public';
 IF tables <> ARRAY['audit_logs','consents','face_templates','mail_deliveries','recipients','safety_checks','terminals','users'] THEN
  RAISE EXCEPTION 'Expected exactly the eight specification tables, got %',tables;
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND column_name IN ('encrypted_display_name','encrypted_name','display_name_lookup_hmac','email_lookup_hmac','row_version')) THEN
  RAISE EXCEPTION 'Unexpected legacy field';
 END IF;
 INSERT INTO users(display_name) VALUES(cipher) RETURNING user_id INTO person;
 INSERT INTO recipients(user_id,name,encrypted_email,order_no) VALUES(person,cipher,cipher,1),(person,cipher,cipher,2);
 BEGIN
  INSERT INTO recipients(user_id,name,encrypted_email,order_no) VALUES(person,cipher,cipher,3);
  RAISE EXCEPTION 'A third contact must be rejected';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO recipients(user_id,name,encrypted_email,order_no) VALUES(person,cipher,cipher,1);
  RAISE EXCEPTION 'Duplicate contact slot must be rejected';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 DELETE FROM users WHERE user_id=person;
 IF EXISTS(SELECT 1 FROM recipients WHERE user_id=person) THEN RAISE EXCEPTION 'User contacts were not deleted'; END IF;
END; $$;
ROLLBACK;
