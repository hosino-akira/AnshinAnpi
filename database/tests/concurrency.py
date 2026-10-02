"""Check the last-recipient invariant using two real PostgreSQL sessions.

Run only against a disposable migrated database. Uses Python's standard library.
"""

import argparse
import concurrent.futures
import pathlib
import re
import subprocess
import time
import uuid


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--database", required=True)
args = parser.parse_args()
if not re.fullmatch(r"anshin_schema_verify_[a-zA-Z0-9_]+", args.database):
    parser.error("Use a disposable database named anshin_schema_verify_<unique suffix>.")

root = pathlib.Path(__file__).resolve().parents[2]
command = [
    "docker", "compose", "--project-directory", str(root), "exec", "-T",
    "-e", f"TARGET_DATABASE={args.database}", "postgres", "sh", "-c",
    'exec psql -X -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose '
    '-U "$POSTGRES_USER" -d "$TARGET_DATABASE"',
]


def sql(statement):
    return subprocess.run(command, input=statement, encoding="utf-8", capture_output=True, timeout=20)


def checked(statement):
    result = sql(statement)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


for isolation, expected_state in [("READ COMMITTED", "23514"), ("REPEATABLE READ", "40001")]:
    facility, person, first, second = [str(uuid.uuid4()) for _ in range(4)]
    try:
        checked(f"""
            BEGIN;
            INSERT INTO facilities(facility_id, facility_code, name)
              VALUES ('{facility}', '{facility}', 'Concurrency test');
            INSERT INTO users(user_id, facility_id, encrypted_display_name, display_name_lookup_hmac,
                encryption_key_id, lookup_key_id, status, registered_at)
              VALUES ('{person}', '{facility}', decode('aabb', 'hex'), decode(repeat('01', 32), 'hex'),
                'test-encryption', 'test-lookup', 'active', current_timestamp);
            INSERT INTO recipients(recipient_id, user_id, encrypted_name, encrypted_email, email_lookup_hmac,
                encryption_key_id, lookup_key_id, order_no)
              VALUES ('{first}', '{person}', decode('aabb', 'hex'), decode('aabb', 'hex'),
                  decode(repeat('01', 32), 'hex'), 'test-encryption', 'test-lookup', 1),
                ('{second}', '{person}', decode('aabb', 'hex'), decode('aabb', 'hex'),
                  decode(repeat('02', 32), 'hex'), 'test-encryption', 'test-lookup', 2);
            COMMIT;
        """)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            first_session = executor.submit(sql, f"""
                BEGIN ISOLATION LEVEL {isolation};
                DELETE FROM recipients WHERE recipient_id = '{first}';
                SELECT pg_sleep(2);
                COMMIT;
            """)
            # The first transaction holds the parent write lock while the second
            # session takes its snapshot and tries to remove the other contact.
            time.sleep(0.35)
            second_session = executor.submit(sql, f"""
                BEGIN ISOLATION LEVEL {isolation};
                SELECT count(*) FROM recipients WHERE user_id = '{person}';
                DELETE FROM recipients WHERE recipient_id = '{second}';
                COMMIT;
            """)
            results = [first_session.result(), second_session.result()]
        failures = [result for result in results if result.returncode]
        if len(failures) != 1 or expected_state not in failures[0].stderr:
            raise AssertionError(f"Unexpected {isolation} outcomes: {[r.stderr for r in results]}")
        if checked(f"SELECT count(*) FROM recipients WHERE user_id = '{person}';") != "1":
            raise AssertionError("Concurrent removals left an active user without a contact")
        print(f"PASS: {isolation}: one deletion committed, the other rejected ({expected_state}); one contact remains")
    finally:
        checked(f"BEGIN; DELETE FROM users WHERE user_id = '{person}'; DELETE FROM facilities WHERE facility_id = '{facility}'; COMMIT;")

print("All concurrency checks passed; fixtures removed.")
