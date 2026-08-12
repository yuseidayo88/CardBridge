-- market_prices records active_min and active_median but had no active_max.
--
-- The spread is the part that says whether the median means anything: a wide
-- gap between the cheapest and dearest comparable usually means the search
-- matched several different cards that share a name, and the median is then
-- describing none of them.

ALTER TABLE market_prices
  ADD COLUMN IF NOT EXISTS active_max numeric(20, 6);

-- A max below the min is not a tight market, it is a bug in whatever wrote it.
ALTER TABLE market_prices
  ADD CONSTRAINT market_prices_active_range
  CHECK (active_min IS NULL OR active_max IS NULL OR active_max >= active_min);
