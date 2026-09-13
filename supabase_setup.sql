-- NorwayFlightsTracker2028: daily ONE-WAY TLV<->OSL price samples for
-- SAS, Lufthansa, LOT and Austrian, via Kayak (single-carrier itineraries only)
-- Run this whole file once in Supabase Dashboard -> SQL Editor -> New query -> Run
-- (Replaces the earlier round-trip schema -- safe to drop, no meaningful data lost.)

drop table if exists tlv_osl_prices.price_samples;
drop table if exists tlv_osl_prices.one_way_prices;

create schema if not exists tlv_osl_prices;
grant usage on schema tlv_osl_prices to anon, authenticated;

create table tlv_osl_prices.one_way_prices (
  id bigint generated always as identity primary key,
  sample_date date not null default current_date,        -- calendar day the job ran (for daily dedupe)
  sampled_at timestamptz not null default now(),          -- exact fetch time
  flight_date date not null,                              -- the one-way flight's date
  direction text not null,                                -- 'TLV_OSL' or 'OSL_TLV'
  query_status text not null,                             -- 'ok' (page loaded, may still have null prices) | 'no_data' (page load/parse failed)
  sas_price numeric,
  lufthansa_price numeric,
  lot_price numeric,
  austrian_price numeric,
  raw_snapshot jsonb,                                     -- every single-carrier airline price Kayak showed that day, for later reanalysis
  currency text not null default 'USD',
  unique (sample_date, flight_date, direction)
);

alter table tlv_osl_prices.one_way_prices enable row level security;

-- Public dashboard can only read. Writes come from the GitHub Actions job using the service_role key,
-- which bypasses RLS entirely -- no insert/update policy for anon is needed or granted.
create policy "anon can read one-way prices" on tlv_osl_prices.one_way_prices
  for select to anon, authenticated using (true);

grant select on tlv_osl_prices.one_way_prices to anon, authenticated;

-- service_role bypasses RLS but still needs an explicit schema/table grant --
-- it is NOT automatic just because it's the privileged role.
grant usage on schema tlv_osl_prices to service_role;
grant select, insert, update on tlv_osl_prices.one_way_prices to service_role;
