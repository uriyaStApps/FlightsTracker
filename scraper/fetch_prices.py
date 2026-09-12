"""
Daily TLV<->OSL price sampler for SAS + Lufthansa.

Runs once a day (via GitHub Actions). For every (departure_date, return_date)
pair in the May-June 2027 trip matrix, queries Google Flights (via fast-flights),
keeps only itineraries that include SAS or Lufthansa, and upserts one row per
pair per day into Supabase.

Each day's snapshot is a one-shot, unrepeatable observation -- if a query fails
or the route isn't bookable yet that far out, we record that explicitly rather
than silently skipping, and we keep the raw matched-flight list (not just the
cheapest number) since we can never re-sample a past day.
"""

import json
import os
import random
import sys
import time
from datetime import date, timedelta

import requests
from fast_flights import FlightQuery, Passengers, create_query, get_flights

ORIGIN = "TLV"
DEST = "OSL"
TARGET_AIRLINES = {"Lufthansa", "Scandinavian Airlines"}

TRIP_YEAR = 2027
MATRIX_START = date(TRIP_YEAR, 5, 1)
MATRIX_END = date(TRIP_YEAR, 6, 30)
DURATIONS_NIGHTS = [10, 11, 12, 13, 14]

# Empirically this route only returns real data ~120-125 days out (tested
# 2026-09-12: boundary fell around 2027-01-11/12). Add a safety margin so we
# don't burn requests on dates that are essentially guaranteed to fail yet.
HORIZON_DAYS = 150

# Once we're past the trip's own booking window there's nothing left to learn --
# the project is defined to end here regardless of what the workflow schedule does.
PROJECT_END = date(2027, 5, 1)

SUPABASE_URL = "https://pualpwrkztjzhgpaqudm.supabase.co"
SUPABASE_SCHEMA = "tlv_osl_prices"
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

MIN_SLEEP_SECONDS = 1.0
MAX_SLEEP_SECONDS = 2.5


def build_date_pairs(today: date):
    pairs = []
    d = MATRIX_START
    while d <= MATRIX_END:
        for nights in DURATIONS_NIGHTS:
            pairs.append((d, d + timedelta(days=nights)))
        d += timedelta(days=1)

    eligible, skipped = [], 0
    for dep, ret in pairs:
        if (dep - today).days <= HORIZON_DAYS:
            eligible.append((dep, ret))
        else:
            skipped += 1
    return eligible, skipped


def query_one(dep: date, ret: date):
    q = create_query(
        flights=[
            FlightQuery(date=dep.isoformat(), from_airport=ORIGIN, to_airport=DEST),
            FlightQuery(date=ret.isoformat(), from_airport=DEST, to_airport=ORIGIN),
        ],
        seat="economy",
        trip="round-trip",
        passengers=Passengers(adults=1),
        currency="USD",
    )
    return get_flights(q)


def to_row(sample_date: date, dep: date, ret: date, status: str, matches=None):
    matches = matches or []
    row = {
        "sample_date": sample_date.isoformat(),
        "departure_date": dep.isoformat(),
        "return_date": ret.isoformat(),
        "query_status": status,
        "match_count": len(matches),
        "cheapest_price": None,
        "cheapest_airline": None,
        "currency": "USD",
        "raw_matches": matches or None,
    }
    if matches:
        cheapest = min(matches, key=lambda m: m["price"])
        row["cheapest_price"] = cheapest["price"]
        row["cheapest_airline"] = ", ".join(cheapest["airlines"])
    return row


def extract_matches(result):
    matches = []
    for f in result:
        if TARGET_AIRLINES.intersection(f.airlines):
            matches.append(
                {
                    "type": f.type,
                    "airlines": f.airlines,
                    "price": f.price,
                    "stops": len(f.flights) - 1,
                }
            )
    return matches


def upsert_rows(rows):
    if not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/price_samples"
    headers = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Content-Profile": SUPABASE_SCHEMA,
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    resp = requests.post(url, headers=headers, data=json.dumps(rows), timeout=60)
    if resp.status_code >= 300:
        raise RuntimeError(f"Supabase upsert failed ({resp.status_code}): {resp.text}")


def main():
    if not SERVICE_ROLE_KEY:
        print("SUPABASE_SERVICE_ROLE_KEY is not set", file=sys.stderr)
        sys.exit(1)

    today = date.today()
    if today > PROJECT_END:
        print(f"Today ({today}) is past the project end date ({PROJECT_END}). Nothing to do.")
        return

    pairs, skipped = build_date_pairs(today)
    print(f"Today: {today}. {len(pairs)} date pairs in horizon, {skipped} skipped (too far out).")

    rows = []
    ok_count = 0
    no_data_count = 0
    matched_count = 0

    for dep, ret in pairs:
        try:
            result = query_one(dep, ret)
            matches = extract_matches(result)
            rows.append(to_row(today, dep, ret, "ok", matches))
            ok_count += 1
            if matches:
                matched_count += 1
        except Exception as e:
            print(f"  no data for {dep} / {ret}: {type(e).__name__}: {e}")
            rows.append(to_row(today, dep, ret, "no_data"))
            no_data_count += 1

        time.sleep(random.uniform(MIN_SLEEP_SECONDS, MAX_SLEEP_SECONDS))

    print(f"Done: {ok_count} ok ({matched_count} with SAS/Lufthansa matches), {no_data_count} no_data.")

    # Send in chunks so one bad batch doesn't lose everything.
    CHUNK = 50
    for i in range(0, len(rows), CHUNK):
        upsert_rows(rows[i : i + CHUNK])

    print(f"Upserted {len(rows)} rows to Supabase.")


if __name__ == "__main__":
    main()
