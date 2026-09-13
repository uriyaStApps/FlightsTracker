"""
Daily ONE-WAY price sampler, TLV to a configured destination, via Kayak.

Runs once a day per destination (via a GitHub Actions matrix -- see
.github/workflows/daily_fetch.yml). For every single flight date in each
direction, loads the Kayak one-way search results, loads as many result cards
as it can (Kayak lazy-loads/paginates), and reads the cheapest price for
every airline directly off the itinerary cards -- but ONLY itineraries
operated by that one airline for every leg (no interline/codeshare mixes, and
explicitly excluding "self-transfer" combos of two separate tickets).

Tracking one-way fares (instead of fixed round-trip combos) lets any
departure/return pair be assembled after the fact from two independent daily
numbers, and needs far fewer queries per day than a full round-trip matrix.

Each day's snapshot is a one-shot, unrepeatable observation, so the full set
of single-carrier prices Kayak showed that day is kept as jsonb (airline sets
differ per destination, so this isn't a fixed set of columns).
"""

import argparse
import json
import os
import random
import re
import sys
import time
from datetime import date, timedelta

import requests
from playwright.sync_api import sync_playwright

ORIGIN = "TLV"
DURATIONS_NIGHTS = [10, 11, 12, 13, 14]

# Each destination owns its own trip window -- add a new one at any time with
# whatever month makes sense for it, and tracking starts from that moment
# (today) forward, independent of every other destination. Tracking for a
# destination stops once its own trip_start arrives (see project_end() below)
# -- the point is learning the lead-up behavior, not the travel month itself.
#
# outbound_start / outbound_end: the range of possible outbound flight dates
# (the target travel month, or a range spanning it).
DESTINATIONS = {
    "OSL": {"name": "Oslo (Norway)", "outbound_start": date(2027, 5, 1), "outbound_end": date(2027, 6, 30)},
    "YYC": {"name": "Calgary (Western Canada)", "outbound_start": date(2027, 5, 1), "outbound_end": date(2027, 6, 30)},
    "YVR": {"name": "Vancouver (Western Canada)", "outbound_start": date(2027, 5, 1), "outbound_end": date(2027, 6, 30)},
    "ANC": {"name": "Anchorage (Alaska)", "outbound_start": date(2027, 5, 1), "outbound_end": date(2027, 6, 30)},
    "ORD": {"name": "Chicago", "outbound_start": date(2027, 5, 1), "outbound_end": date(2027, 6, 30)},
}


def project_end(destination: str) -> date:
    """Tracking for a destination stops once its own trip window begins."""
    return DESTINATIONS[destination]["outbound_start"]

# Airlines seen across these routes, needed so a card mentioning two of these
# names is correctly recognized as a mixed/interline itinerary and excluded,
# rather than mis-read as a single-carrier fare. Not a per-destination
# allowlist -- any single-carrier airline found is kept in raw form.
ALL_KNOWN_AIRLINES = [
    "Scandinavian Airlines", "Lufthansa", "LOT", "Austrian Airlines",
    "Air France", "KLM", "SWISS", "Brussels Airlines", "EL AL", "Iberia",
    "ITA Airways", "TAP AIR PORTUGAL", "TAROM", "Aegean Airlines", "airBaltic",
    "Norwegian", "Ryanair", "Wizz Air", "Emirates", "Etihad Airways",
    "Ethiopian Air", "flydubai", "Sky Express", "British Airways", "Delta",
    "United", "American Airlines", "Virgin Atlantic", "JetBlue", "Air Canada",
    "Alaska Airlines", "Hawaiian Airlines", "Norse Atlantic Airways",
    "Condor", "Finnair", "Icelandair", "Turkish Airlines", "Qatar Airways",
]

SUPABASE_URL = "https://pualpwrkztjzhgpaqudm.supabase.co"
SUPABASE_SCHEMA = "flight_tracker"
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

MIN_SLEEP_SECONDS = 1.5
MAX_SLEEP_SECONDS = 3.0


def build_flight_dates(destination: str):
    outbound_start = DESTINATIONS[destination]["outbound_start"]
    outbound_end = DESTINATIONS[destination]["outbound_end"]
    return_start = outbound_start + timedelta(days=min(DURATIONS_NIGHTS))
    return_end = outbound_end + timedelta(days=max(DURATIONS_NIGHTS))

    pairs = []
    d = outbound_start
    while d <= outbound_end:
        pairs.append((d, "OUTBOUND"))
        d += timedelta(days=1)
    d = return_start
    while d <= return_end:
        pairs.append((d, "RETURN"))
        d += timedelta(days=1)
    return pairs


def parse_card(text):
    if "Self-transfer hack" in text or "Separate tickets" in text:
        return None
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    price = None
    for l in lines:
        if re.fullmatch(r"\$[\d,]+", l):
            price = int(l.replace("$", "").replace(",", ""))
            break
    if price is None:
        return None
    airlines_in_card = set(a for a in ALL_KNOWN_AIRLINES if a in lines)
    if len(airlines_in_card) != 1:
        return None  # mixed-carrier (or unrecognized) itinerary -- excluded by design
    return next(iter(airlines_in_card)), price


def query_one(page, destination: str, flight_date: date, direction: str):
    origin, dest = (ORIGIN, destination) if direction == "OUTBOUND" else (destination, ORIGIN)
    url = f"https://www.kayak.com/flights/{origin}-{dest}/{flight_date.isoformat()}"
    page.goto(url, timeout=60000)
    # Kayak's page never reaches true network-idle (continuous background
    # polling/ads/tracking), so waiting on that blocks for its full timeout
    # every time (confirmed empirically: ~40s/query instead of ~10-13s).
    # Wait for a concrete signal -- the first result card -- instead.
    try:
        page.wait_for_selector(".nrc6", timeout=15000)
    except Exception:
        pass  # may genuinely be zero results; the card scan below just finds nothing
    page.wait_for_timeout(1500)

    for _ in range(6):
        page.keyboard.press("End")
        page.wait_for_timeout(500)
        try:
            page.get_by_text(re.compile(r"Show more results")).click(timeout=1000, force=True)
            page.wait_for_timeout(800)
        except Exception:
            pass

    card_texts = page.evaluate("() => Array.from(document.querySelectorAll('.nrc6')).map(el => el.innerText)")

    best = {}
    for t in card_texts:
        parsed = parse_card(t)
        if parsed is None:
            continue
        airline, price = parsed
        if airline not in best or price < best[airline]:
            best[airline] = price

    return best


def check_connection():
    # All 5 matrix jobs hit Supabase at the same instant on startup -- seen
    # a transient 504 Gateway Timeout from this alone (real production
    # failure, not hypothetical). A couple of retries absorbs that.
    url = f"{SUPABASE_URL}/rest/v1/one_way_prices?select=id&limit=1"
    headers = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Accept-Profile": SUPABASE_SCHEMA,
    }
    last_error = None
    for attempt in range(3):
        if attempt > 0:
            time.sleep(5 * attempt + random.uniform(0, 3))
        try:
            resp = requests.get(url, headers=headers, timeout=30)
            if resp.status_code < 300:
                print("Supabase connection check ok.")
                return
            last_error = RuntimeError(f"Supabase connection check failed ({resp.status_code}): {resp.text}")
        except requests.RequestException as e:
            last_error = e
    raise last_error


def upsert_rows(rows):
    if not rows:
        return
    # merge-duplicates without an explicit on_conflict target defaults to the
    # primary key (id), which is always new per row -- so it silently fails
    # to match our real unique constraint and 409s on any re-run for a day
    # that already has partial data (confirmed: this crashed a real run).
    url = f"{SUPABASE_URL}/rest/v1/one_way_prices?on_conflict=sample_date,destination,flight_date,direction"
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True, choices=sorted(DESTINATIONS))
    args = parser.parse_args()
    destination = args.destination

    if not SERVICE_ROLE_KEY:
        print("SUPABASE_SERVICE_ROLE_KEY is not set", file=sys.stderr)
        sys.exit(1)

    check_connection()

    end = project_end(destination)
    today = date.today()
    if today > end:
        print(f"Today ({today}) is past {destination}'s project end date ({end}). Nothing to do.")
        return

    flight_dates = build_flight_dates(destination)
    random.shuffle(flight_dates)  # spread any transient slowness across both directions, not just the second half
    print(f"Today: {today}. Destination: {destination} ({DESTINATIONS[destination]['name']}). "
          f"Querying {len(flight_dates)} one-way (date, direction) pairs via Kayak.")

    # Cheap insurance, kept even though the real fix for the "RETURN queries
    # all came back empty" bug turned out to be the networkidle wait (see
    # query_one) -- recycling the browser periodically costs almost nothing.
    BROWSER_RECYCLE_EVERY = 25

    rows = []
    ok_count = 0
    no_data_count = 0
    airline_hit_counts = {}
    consecutive_empty = 0

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1400, "height": 1200})

        for i, (flight_date, direction) in enumerate(flight_dates):
            if i > 0 and i % BROWSER_RECYCLE_EVERY == 0:
                page.close()
                browser.close()
                browser = p.chromium.launch()
                page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1400, "height": 1200})
                print(f"  recycled browser session at query {i}")

            try:
                best = query_one(page, destination, flight_date, direction)
                if best:
                    consecutive_empty = 0
                else:
                    consecutive_empty += 1
                    if consecutive_empty >= 5:
                        print(f"  {consecutive_empty} empty results in a row as of query {i} -- forcing a browser recycle")
                        page.close()
                        browser.close()
                        browser = p.chromium.launch()
                        page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1400, "height": 1200})
                        consecutive_empty = 0
                for airline in best:
                    airline_hit_counts[airline] = airline_hit_counts.get(airline, 0) + 1
                rows.append(
                    {
                        "sample_date": today.isoformat(),
                        "destination": destination,
                        "flight_date": flight_date.isoformat(),
                        "direction": direction,
                        "query_status": "ok",
                        "prices": best or None,
                        "currency": "USD",
                    }
                )
                ok_count += 1
            except Exception as e:
                print(f"  no data for {flight_date} {direction}: {type(e).__name__}: {e}")
                rows.append(
                    {
                        "sample_date": today.isoformat(),
                        "destination": destination,
                        "flight_date": flight_date.isoformat(),
                        "direction": direction,
                        "query_status": "no_data",
                        "prices": None,
                        "currency": "USD",
                    }
                )
                no_data_count += 1

            time.sleep(random.uniform(MIN_SLEEP_SECONDS, MAX_SLEEP_SECONDS))

        browser.close()

    print(f"Done: {ok_count} ok, {no_data_count} no_data (out of {len(rows)}).")
    print(f"Airlines seen (single-carrier hits across all queries): {airline_hit_counts}")

    CHUNK = 50
    for i in range(0, len(rows), CHUNK):
        upsert_rows(rows[i : i + CHUNK])

    print(f"Upserted {len(rows)} rows to Supabase.")


if __name__ == "__main__":
    main()
