-- TlvOsloPriceTracker: daily TLV<->OSL price samples for SAS + Lufthansa
-- Run this whole file once in Supabase Dashboard -> SQL Editor -> New query -> Run

create schema if not exists tlv_osl_prices;
grant usage on schema tlv_osl_prices to anon, authenticated;

create table tlv_osl_prices.price_samples (
  id bigint generated always as identity primary key,
  sample_date date not null default current_date,       -- calendar day the job ran (for daily dedupe)
  sampled_at timestamptz not null default now(),         -- exact fetch time
  departure_date date not null,                          -- TLV -> OSL date
  return_date date not null,                             -- OSL -> TLV date
  query_status text not null,                            -- 'ok' (query succeeded, may have 0 matches) | 'no_data' (fetch failed -- usually because the route isn't bookable that far out yet)
  match_count int not null default 0,                    -- number of SAS/Lufthansa itineraries found
  cheapest_price numeric,                                -- cheapest matched price (null if none/error)
  cheapest_airline text,                                 -- which airline(s) gave the cheapest match
  currency text not null default 'USD',
  raw_matches jsonb,                                     -- full list of matched flights for this query (kept since each day's snapshot is unbounded)
  unique (sample_date, departure_date, return_date)
);

alter table tlv_osl_prices.price_samples enable row level security;

-- Public dashboard can only read. Writes come from the GitHub Actions job using the service_role key,
-- which bypasses RLS entirely -- no insert/update policy for anon is needed or granted.
create policy "anon can read price samples" on tlv_osl_prices.price_samples
  for select to anon, authenticated using (true);

grant select on tlv_osl_prices.price_samples to anon, authenticated;
