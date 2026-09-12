-- NorwayFlightsTracker2028: daily TLV<->OSL price samples for Lufthansa + SAS, via Kayak
-- Run this whole file once in Supabase Dashboard -> SQL Editor -> New query -> Run
-- (Replaces the earlier Google-Flights-based schema -- table had 0 rows, safe to drop.)

drop table if exists tlv_osl_prices.price_samples;

create schema if not exists tlv_osl_prices;
grant usage on schema tlv_osl_prices to anon, authenticated;

create table tlv_osl_prices.price_samples (
  id bigint generated always as identity primary key,
  sample_date date not null default current_date,       -- calendar day the job ran (for daily dedupe)
  sampled_at timestamptz not null default now(),         -- exact fetch time
  departure_date date not null,                          -- TLV -> OSL date
  return_date date not null,                             -- OSL -> TLV date
  query_status text not null,                            -- 'ok' (page loaded, may still have null prices) | 'no_data' (page load/parse failed)
  lufthansa_price numeric,                               -- null if Lufthansa wasn't in Kayak's top-priced airline list that day
  sas_price numeric,                                     -- null if SAS wasn't in Kayak's top-priced airline list that day (common -- SAS mostly reaches this route via codeshare)
  total_flights int,                                     -- total itineraries Kayak reported for context
  top_airlines jsonb,                                    -- snapshot of the airlines Kayak did show a price for that day
  currency text not null default 'USD',
  unique (sample_date, departure_date, return_date)
);

alter table tlv_osl_prices.price_samples enable row level security;

-- Public dashboard can only read. Writes come from the GitHub Actions job using the service_role key,
-- which bypasses RLS entirely -- no insert/update policy for anon is needed or granted.
create policy "anon can read price samples" on tlv_osl_prices.price_samples
  for select to anon, authenticated using (true);

grant select on tlv_osl_prices.price_samples to anon, authenticated;

-- service_role bypasses RLS but still needs an explicit schema/table grant --
-- it is NOT automatic just because it's the privileged role.
grant usage on schema tlv_osl_prices to service_role;
grant select, insert, update on tlv_osl_prices.price_samples to service_role;
