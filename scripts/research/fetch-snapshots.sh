#!/usr/bin/env bash
#
# Fetch the partner category pages once each, for offline selector development.
#
# Deliberately plain bash and curl, with no dependency on the repository, node
# or pnpm: the person who can reach these sites is the operator on their laptop,
# not this project's toolchain, and asking them to install a toolchain first is
# how a ten-minute task becomes an evening.
#
# Usage:  bash fetch-snapshots.sh [output-directory]
#
set -uo pipefail

OUT_DIR="${1:-$HOME/Desktop/cardbridge-html}"
UA="CardBridgeBot/1.0 (+https://github.com/yuseidayo88/CardBridge)"

# Three seconds between requests. Permission from a partner is permission to
# fetch, not permission to hammer, and this whole run is under two minutes even
# so.
DELAY=3

MAGI_PAGES=5
CARDRUSH_PAGES=14
CARDRUSH_BASE='https://www.cardrush-pokemon.jp/product-group/277/0/photo?num=100&img=160&available=1&sort='

mkdir -p "$OUT_DIR"
cd "$OUT_DIR" || exit 1

echo "saving to $OUT_DIR"
echo

fetch() {
  local url="$1" out="$2"
  local status

  status=$(curl -sS -A "$UA" -w '%{http_code}' -o "$out" "$url" 2>/dev/null)

  if [ "$status" != "200" ]; then
    echo "  FAILED $out  (HTTP $status)"
    rm -f "$out"
    return 1
  fi

  local bytes
  bytes=$(wc -c <"$out" | tr -d ' ')

  # A few hundred bytes means an error page, a consent wall or a redirect stub.
  # Saying so here beats discovering it during analysis, when the file is one of
  # nineteen and nobody remembers which.
  if [ "$bytes" -lt 5000 ]; then
    echo "  WARNING $out is only ${bytes} bytes - probably not a real page"
  else
    echo "  ok $out (${bytes} bytes)"
  fi
}

echo "magi (${MAGI_PAGES} pages)"
for page in $(seq 1 "$MAGI_PAGES"); do
  fetch "https://www.magicardshop.jp/product-group/14?page=${page}" "magi-list-${page}.html"
  sleep "$DELAY"
done

echo
echo "cardrush (${CARDRUSH_PAGES} pages)"
# Page 1 has no page parameter: that is the URL the shop's own pagination
# produces, and requesting page=1 explicitly is a guess we do not need to make.
fetch "$CARDRUSH_BASE" 'cardrush-list-1.html'
sleep "$DELAY"
for page in $(seq 2 "$CARDRUSH_PAGES"); do
  fetch "${CARDRUSH_BASE}&page=${page}" "cardrush-list-${page}.html"
  sleep "$DELAY"
done

echo
echo "--- results ---"
ls -lh ./*.html 2>/dev/null || echo "nothing was saved"

echo
echo "--- does the raw HTML already contain products? ---"
# If this reports zero, the shop renders its listings with JavaScript and the
# adapter needs a headless browser. That single fact decides the entire fetching
# strategy, so it is worth answering before anything else.
for f in magi-list-1.html cardrush-list-1.html; do
  [ -f "$f" ] || continue
  echo "  $f: $(grep -o '円' "$f" | wc -l | tr -d ' ') price marks"
done
