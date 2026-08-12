#!/usr/bin/env bash
#
# Run every hand-written query in the app and worker against the real schema.
#
# TypeScript cannot see inside a sql`` template, so a column that was renamed --
# or never existed -- typechecks perfectly and fails at runtime, on a page an
# operator is looking at. This catches that class of bug in about ten seconds,
# with no Supabase and no network.
#
# It found two real ones on its first run: market_prices had no active_max
# column at all, and marketplaces has no ebay_category_id.
#
# Usage: scripts/db/verify-sql.sh
set -uo pipefail
PGBIN=/usr/lib/postgresql/16/bin
PGDATA=/tmp/pgdata_sqlcheck; PORT=55434; SOCK=/tmp; DB=sqlcheck
cleanup() { su postgres -c "$PGBIN/pg_ctl -D $PGDATA stop -m immediate" >/dev/null 2>&1 || true; rm -rf $PGDATA; }
trap cleanup EXIT
rm -rf $PGDATA; mkdir -p $PGDATA; chown postgres:postgres $PGDATA; chmod 700 $PGDATA
su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PORT -k $SOCK' -l /tmp/pg_sqlcheck.log start" >/dev/null
sleep 2
psql -h $SOCK -p $PORT -U postgres -q -c "CREATE DATABASE $DB;"
psql -h $SOCK -p $PORT -U postgres -d $DB -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
SQL
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

check() {
  local label="$1" sql="$2"
  if psql -h $SOCK -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1; then
    echo "  ok: $label"
  else
    echo "  FAIL: $label"
    psql -h $SOCK -p $PORT -U postgres -d $DB -c "$sql" 2>&1 | head -3
    exit 1
  fi
}

echo "==> ai-generation.ts"
check "card name load" "SELECT name_ja, name_en, set_code, card_number, source, is_verified FROM card_names"
check "products needing copy" "
  SELECT c.id, c.card_name_ja, c.card_name_en, c.set_name, c.set_code, c.card_number,
         c.rarity, c.release_year, c.grading_company, c.grade, c.language,
         '183050' AS category_id, ap.payload AS aspects
  FROM catalog_products c
  LEFT JOIN ebay_aspect_policies ap ON ap.category_id = '183050' AND ap.marketplace_code = 'EBAY_US'
  WHERE NOT EXISTS (SELECT 1 FROM ai_generations g
                    WHERE g.target_id = c.id AND g.purpose = 'LISTING_COPY' AND g.output IS NOT NULL)
  ORDER BY c.updated_at DESC LIMIT 25"

echo "==> market-price.ts"
check "stalest products first" "
  SELECT c.id, c.card_name_en, c.card_number, c.set_name,
         c.grading_company, c.grade, m.id AS marketplace_id
  FROM catalog_products c
  CROSS JOIN LATERAL (SELECT id FROM marketplaces WHERE code = 'EBAY_US' LIMIT 1) m
  LEFT JOIN LATERAL (SELECT max(collected_at) AS last_seen FROM market_prices mp
                     WHERE mp.catalog_product_id = c.id) last ON true
  ORDER BY last.last_seen ASC NULLS FIRST LIMIT 50"

echo "==> ebay-metadata.ts"
check "condition policy upsert" "
  INSERT INTO ebay_condition_policies (marketplace_code, category_id, environment, payload, fetched_at)
  VALUES ('EBAY_US','ALL','SANDBOX','{}'::jsonb, now())
  ON CONFLICT (marketplace_code, category_id, environment)
  DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()"
check "aspect policy upsert" "
  INSERT INTO ebay_aspect_policies (marketplace_code, category_id, environment, payload, fetched_at)
  VALUES ('EBAY_US','183050','SANDBOX','[]'::jsonb, now())
  ON CONFLICT (marketplace_code, category_id, environment)
  DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()"

echo "==> matching page + actions"
check "pending candidates" "
  SELECT mc.id, mc.score, mc.signals, mc.blockers,
         sp.raw_title, s.code, sp.canonical_url, sp.price_incl_tax_jpy,
         c.card_name_ja, c.card_name_en, c.card_number, c.set_name, c.grade, c.grading_company
  FROM match_candidates mc
  JOIN supplier_products sp ON sp.id = mc.supplier_product_id
  JOIN suppliers s ON s.id = sp.supplier_id
  JOIN catalog_products c ON c.id = mc.catalog_product_id
  WHERE mc.resolved_at IS NULL ORDER BY mc.score DESC LIMIT 50"
check "established matches" "
  SELECT pm.id, pm.match_score, pm.match_method, pm.matched_by, sp.raw_title, s.code,
         c.card_name_ja, c.card_name_en
  FROM product_matches pm
  JOIN supplier_products sp ON sp.id = pm.supplier_product_id
  JOIN suppliers s ON s.id = sp.supplier_id
  JOIN catalog_products c ON c.id = pm.catalog_product_id
  WHERE pm.unmatched_at IS NULL ORDER BY pm.matched_at DESC LIMIT 50"
check "unmatch" "UPDATE product_matches SET unmatched_at = now(), unmatched_by = 'a@b.c', unmatch_reason = 'x' WHERE unmatched_at IS NULL"

echo "==> cost profile screen"
check "profile load" "
  SELECT id, name, category_fee_percent, fixed_fee_per_order, international_fee_percent,
         ad_rate_percent, fx_spread_percent, fx_buffer_percent, return_reserve_percent,
         packaging_cost, packaging_currency, other_cost, is_active, notes
  FROM cost_profiles ORDER BY is_active DESC, effective_from DESC"

echo "==> card names screen"
check "rows + search" "
  SELECT id, name_ja, name_en, set_code, card_number, source, is_verified, verified_by, note
  FROM card_names WHERE NULL::text IS NULL OR name_ja ILIKE '%x%'
  ORDER BY is_verified ASC, name_ja ASC LIMIT 200"

echo ""
echo "All SQL verified against the real schema."
