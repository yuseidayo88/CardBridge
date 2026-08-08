#!/usr/bin/env bash
#
# Apply every migration to a throwaway Postgres cluster and assert that the
# integrity constraints actually reject bad data.
#
# This runs without Supabase and without network access, so it works in CI and
# on a laptop. It exists because a CHECK constraint that was silently dropped
# during a schema edit looks exactly like one that works, right up until bad
# data lands in production.
#
# Usage: scripts/db/verify-migrations.sh
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PGDATA=${PGDATA_DIR:-/tmp/pgdata_cardbridge_verify}
PORT=${PGPORT:-55433}
SOCK=/tmp
DB=cardbridge_verify
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cleanup() {
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA stop -m immediate" >/dev/null 2>&1 || true
  rm -rf "$PGDATA"
}
trap cleanup EXIT

echo "==> starting throwaway postgres on port $PORT"
rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PORT -k $SOCK' -l /tmp/pg_verify.log start" >/dev/null
sleep 2

psql -h $SOCK -p $PORT -U postgres -q -c "CREATE DATABASE $DB;"

# Supabase supplies auth.uid() and the anon/authenticated roles; stub them so
# the RLS migration is exercised exactly as written.
psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
SQL

echo "==> applying migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

run_sql() { psql -h $SOCK -p $PORT -U postgres -d $DB -tA -c "$1"; }

# Assert a statement is REJECTED by the database.
assert_rejected() {
  local label="$1" sql="$2"
  if psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1; then
    echo "    FAIL: $label was accepted but should have been rejected"
    exit 1
  fi
  echo "    ok: $label rejected"
}

echo "==> schema"
tables=$(run_sql "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
rls=$(run_sql "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity")
echo "    $tables tables, $rls with RLS enabled"
[ "$tables" = "$rls" ] || { echo "    FAIL: not every table has RLS enabled"; exit 1; }

echo "==> safety defaults"
[ "$(run_sql "SELECT value FROM app_settings WHERE key='dryRun'")" = "true" ] \
  || { echo "    FAIL: dryRun is not seeded true"; exit 1; }
[ "$(run_sql "SELECT value FROM app_settings WHERE key='allowProductionPublish'")" = "false" ] \
  || { echo "    FAIL: allowProductionPublish is not seeded false"; exit 1; }
[ "$(run_sql "SELECT value FROM app_settings WHERE key='maxEbayQuantity'")" = "1" ] \
  || { echo "    FAIL: maxEbayQuantity is not seeded 1"; exit 1; }
[ "$(run_sql "SELECT value FROM app_settings WHERE key='defaultImageProcessingMethod'")" = '"ORIGINAL"' ] \
  || { echo "    FAIL: default image method is not ORIGINAL"; exit 1; }
echo "    ok: dry run on, production publish off, quantity capped at 1, images unmodified"

echo "==> integrity constraints"
psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO supplier_products (supplier_id, source_product_id, canonical_url, raw_title, price_incl_tax_jpy, stock_status, content_hash)
SELECT id,'fixture','https://example.test/1','fixture','1000','IN_STOCK','h' FROM suppliers WHERE code='magi';
INSERT INTO catalog_products (card_name_ja, language, grading_company, grade, match_key)
VALUES ('フィクスチャ','JAPANESE','PSA',10,'fixture-key');
SQL

assert_rejected "negative price" \
  "INSERT INTO supplier_products (supplier_id, source_product_id, canonical_url, raw_title, price_incl_tax_jpy, stock_status, content_hash)
   SELECT id,'neg','https://example.test/2','x','-1','IN_STOCK','h' FROM suppliers WHERE code='magi'"

assert_rejected "attribute with source=unknown carrying a value" \
  "INSERT INTO supplier_product_attributes (supplier_product_id, field, value, source, confidence)
   SELECT id,'cardNumber','006/165','unknown',0 FROM supplier_products WHERE source_product_id='fixture'"

assert_rejected "null attribute with non-zero confidence" \
  "INSERT INTO supplier_product_attributes (supplier_product_id, field, value, source, confidence)
   SELECT id,'setCode',NULL,'title_parser',0.9 FROM supplier_products WHERE source_product_id='fixture'"

assert_rejected "eBay title longer than 80 characters" \
  "INSERT INTO marketplace_listings (catalog_product_id, marketplace_id, sku, title_en)
   SELECT c.id, m.id, 'SKU-LONG', repeat('A',81) FROM catalog_products c, marketplaces m
   WHERE m.code='EBAY_US' AND c.match_key='fixture-key'"

assert_rejected "redacted image approved without a human" \
  "INSERT INTO product_images (supplier_product_id, original_image_url, original_image_hash, processing_method, processing_status)
   SELECT id,'https://example.test/i.jpg','hash1','BLACK_MASK','APPROVED' FROM supplier_products WHERE source_product_id='fixture'"

assert_rejected "negative listing quantity" \
  "INSERT INTO marketplace_listings (catalog_product_id, marketplace_id, sku, quantity)
   SELECT c.id, m.id, 'SKU-NEG', -1 FROM catalog_products c, marketplaces m
   WHERE m.code='EBAY_US' AND c.match_key='fixture-key'"

psql -h $SOCK -p $PORT -U postgres -d $DB -q -c \
  "INSERT INTO sync_jobs (type, lock_key) VALUES ('SUPPLIER_FULL_SYNC','magi:full')" >/dev/null
assert_rejected "duplicate active sync job" \
  "INSERT INTO sync_jobs (type, lock_key) VALUES ('SUPPLIER_FULL_SYNC','magi:full')"

assert_rejected "card name marked verified with nobody's name on it" \
  "INSERT INTO card_names (name_ja, name_key, name_en, source, is_verified)
   VALUES ('リザードンex','リザードンex','Charizard ex','test',true)"

assert_rejected "card name with a blank English name" \
  "INSERT INTO card_names (name_ja, name_key, name_en, source)
   VALUES ('リザードンex','リザードンex','   ','test')"

psql -h $SOCK -p $PORT -U postgres -d $DB -q -c \
  "INSERT INTO card_names (name_ja, name_key, name_en, set_code, card_number, source)
   VALUES ('リザードンex','リザードンex','Charizard ex','sv3a','006/165','test')" >/dev/null
assert_rejected "the same card name in the same set and number twice" \
  "INSERT INTO card_names (name_ja, name_key, name_en, set_code, card_number, source)
   VALUES ('リザードンex','リザードンex','Charizard ex','sv3a','006/165','test')"

# A name-only row is a different row from a set-scoped one, and must still be
# allowed to coexist with it -- otherwise importing a general fallback name
# would collide with every specific printing already recorded.
psql -h $SOCK -p $PORT -U postgres -d $DB -q -c \
  "INSERT INTO card_names (name_ja, name_key, name_en, source)
   VALUES ('リザードンex','リザードンex','Charizard ex','test')" >/dev/null \
  && echo "    ok: a name-only row coexists with a set-scoped one" \
  || { echo "    FAILED: a name-only row was rejected alongside a set-scoped one"; exit 1; }

assert_rejected "two name-only rows for the same card" \
  "INSERT INTO card_names (name_ja, name_key, name_en, source)
   VALUES ('リザードンex','リザードンex','Charizard ex','test')"

echo ""
echo "All migration checks passed."
