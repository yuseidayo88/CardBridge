#!/usr/bin/env bash
#
# Exercise the job queue's concurrency guarantees against a real Postgres.
#
# These properties cannot be tested with a mock — SKIP LOCKED, partial unique
# indexes and lease expiry are database behaviour, and a test double would only
# assert that the double behaves as written.
#
# Usage: scripts/db/verify-queue.sh
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PGDATA=${PGDATA_DIR:-/tmp/pgdata_cardbridge_queue}
PORT=${PGPORT:-55434}
SOCK=/tmp
DB=cardbridge_queue
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cleanup() {
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA stop -m immediate" >/dev/null 2>&1 || true
  rm -rf "$PGDATA"
}
trap cleanup EXIT

echo "==> starting throwaway postgres on port $PORT"
rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PORT -k $SOCK' -l /tmp/pg_queue.log start" >/dev/null
sleep 2

psql -h $SOCK -p $PORT -U postgres -q -c "CREATE DATABASE $DB;"
psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
SQL

for f in "$ROOT"/supabase/migrations/*.sql; do
  psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

run() { psql -h $SOCK -p $PORT -U postgres -d $DB -tA -c "$1"; }

echo "==> duplicate work is refused"
run "INSERT INTO sync_jobs (type, lock_key) VALUES ('SUPPLIER_FULL_SYNC','magi:full')" >/dev/null
if run "INSERT INTO sync_jobs (type, lock_key) VALUES ('SUPPLIER_FULL_SYNC','magi:full')" >/dev/null 2>&1; then
  echo "    FAIL: a duplicate job was accepted"; exit 1
fi
echo "    ok: the second enqueue of the same work was rejected"

echo "==> two workers cannot claim the same job"
# Genuinely concurrent: worker A claims inside a transaction and holds it open,
# so worker B must skip the locked row rather than block on it. Running these
# sequentially would prove nothing about SKIP LOCKED.
claim_sql() {
  cat <<SQL
WITH claimed AS (
  SELECT id FROM sync_jobs
  WHERE status = 'QUEUED' AND next_run_at <= now()
  ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1)
UPDATE sync_jobs j SET status='RUNNING', locked_by='$1',
       lease_expires_at = now() + interval '15 minutes', attempts = j.attempts + 1
FROM claimed WHERE j.id = claimed.id RETURNING j.id;
SQL
}

# A holds its transaction open for 3 seconds after claiming.
{
  printf 'BEGIN;\n'
  claim_sql worker-a
  printf 'SELECT pg_sleep(3);\nCOMMIT;\n'
} | psql -h $SOCK -p $PORT -U postgres -d $DB -tA > /tmp/queue_a.out 2>&1 &
A_PID=$!

sleep 1
# Extract a UUID, not psql's command tag ("UPDATE 0" is not a claimed job).
B=$(claim_sql worker-b | psql -h $SOCK -p $PORT -U postgres -d $DB -tA \
      | { grep -oE '[0-9a-f]{8}-[0-9a-f-]+' || true; } | head -1)
wait $A_PID
A=$( { grep -oE '[0-9a-f]{8}-[0-9a-f-]+' /tmp/queue_a.out || true; } | head -1)

[ -n "$A" ] || { echo "    FAIL: the first worker claimed nothing"; cat /tmp/queue_a.out; exit 1; }
[ -z "$B" ] || { echo "    FAIL: both workers claimed a job ($A / $B)"; exit 1; }
echo "    ok: worker-a claimed $A while holding the row; worker-b skipped it"

echo "==> a job can be re-enqueued once it finishes"
run "UPDATE sync_jobs SET status='SUCCEEDED', finished_at=now(), locked_by=NULL WHERE lock_key='magi:full'" >/dev/null
run "INSERT INTO sync_jobs (type, lock_key) VALUES ('SUPPLIER_FULL_SYNC','magi:full')" >/dev/null
echo "    ok: the same lock key is reusable after completion"

# Each lease check uses its own lock key, so the scenarios cannot interfere
# with one another (or with the partial unique index).
count_uuids() { { grep -cE '[0-9a-f]{8}-[0-9a-f-]+' || true; } ; }

echo "==> an expired lease is reclaimable"
run "INSERT INTO sync_jobs (type, lock_key, status, locked_by, lease_expires_at)
     VALUES ('SUPPLIER_STOCK_CHECK','lease:dead','RUNNING','dead-worker', now() - interval '1 minute')" >/dev/null
RECLAIMED=$(run "UPDATE sync_jobs SET status='QUEUED', locked_by=NULL, lease_expires_at=NULL
                 WHERE status='RUNNING' AND lease_expires_at < now() RETURNING id" | count_uuids)
[ "$RECLAIMED" -ge 1 ] || { echo "    FAIL: the stranded job was not reclaimed"; exit 1; }
echo "    ok: $RECLAIMED job(s) reclaimed from the dead worker"

echo "==> a live lease is left alone"
run "INSERT INTO sync_jobs (type, lock_key, status, locked_by, lease_expires_at)
     VALUES ('SUPPLIER_PRICE_CHECK','lease:live','RUNNING','live-worker', now() + interval '10 minutes')" >/dev/null
STOLEN=$(run "UPDATE sync_jobs SET status='QUEUED'
              WHERE status='RUNNING' AND lease_expires_at < now() RETURNING id" | count_uuids)
[ "$STOLEN" = "0" ] || { echo "    FAIL: a job with a live lease was stolen"; exit 1; }
echo "    ok: the running job was not disturbed"

echo ""
echo "All queue checks passed."
