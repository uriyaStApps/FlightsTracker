-- FlightTracker: daily ONE-WAY price samples from TLV to multiple destinations
-- (Oslo, Calgary, Vancouver, Anchorage, Chicago), via Kayak, single-carrier
-- itineraries only. Run this whole file once in Supabase Dashboard -> SQL
-- Editor -> New query -> Run.
-- This MIGRATES the 126 real rows already collected today for Oslo (one
-- day's sample can't be re-collected) into the new schema before dropping
-- the old one, instead of discarding them.

create schema if not exists flight_tracker;
grant usage on schema flight_tracker to anon, authenticated;

create table flight_tracker.one_way_prices (
  id bigint generated always as identity primary key,
  sample_date date not null default current_date,        -- calendar day the job ran (for daily dedupe)
  sampled_at timestamptz not null default now(),         -- exact fetch time
  destination text not null,                             -- IATA code of the non-TLV airport, e.g. 'OSL', 'YYC', 'YVR', 'ANC', 'ORD'
  flight_date date not null,                             -- the one-way flight's date
  direction text not null,                               -- 'OUTBOUND' (TLV -> destination) or 'RETURN' (destination -> TLV)
  query_status text not null,                            -- 'ok' (page loaded, may still have no prices) | 'no_data' (page load/parse failed)
  prices jsonb,                                          -- {"Lufthansa": 192, "SAS": 342, ...} -- every single-carrier airline price Kayak showed that day (airline sets differ per destination, so this isn't fixed columns)
  currency text not null default 'USD',
  unique (sample_date, destination, flight_date, direction)
);

-- Migrate today's real Oslo data from the old schema before dropping it.
insert into flight_tracker.one_way_prices
  (sample_date, sampled_at, destination, flight_date, direction, query_status, prices, currency)
select
  sample_date,
  sampled_at,
  'OSL',
  flight_date,
  case direction when 'TLV_OSL' then 'OUTBOUND' when 'OSL_TLV' then 'RETURN' else direction end,
  query_status,
  case when sas_price is null and lufthansa_price is null and lot_price is null and austrian_price is null
       then raw_snapshot
       else coalesce(raw_snapshot, '{}'::jsonb)
            || jsonb_strip_nulls(jsonb_build_object(
                 'Scandinavian Airlines', sas_price,
                 'Lufthansa', lufthansa_price,
                 'LOT', lot_price,
                 'Austrian Airlines', austrian_price
               ))
  end,
  currency
from tlv_osl_prices.one_way_prices
on conflict (sample_date, destination, flight_date, direction) do nothing;

drop table if exists tlv_osl_prices.one_way_prices;
drop schema if exists tlv_osl_prices;

alter table flight_tracker.one_way_prices enable row level security;

-- Public dashboard can only read. Writes come from the GitHub Actions job using the service_role key,
-- which bypasses RLS entirely -- no insert/update policy for anon is needed or granted.
create policy "anon can read one-way prices" on flight_tracker.one_way_prices
  for select to anon, authenticated using (true);

grant select on flight_tracker.one_way_prices to anon, authenticated;

-- service_role bypasses RLS but still needs an explicit schema/table grant --
-- it is NOT automatic just because it's the privileged role.
grant usage on schema flight_tracker to service_role;
grant select, insert, update on flight_tracker.one_way_prices to service_role;
