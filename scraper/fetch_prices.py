"""
Daily TLV<->OSL ONE-WAY price sampler for SAS, Lufthansa, LOT and Austrian, via Kayak.

Runs once a day (via GitHub Actions). For every single flight date in each
direction, loads the Kayak one-way search results, loads as many result cards
as it can (Kayak lazy-loads/paginates), and reads the cheapest price for each
target airline directly off the itinerary cards -- but ONLY itineraries
operated by that one airline for every leg (no interline/codeshare mixes, and
explicitly excluding "self-transfer" combos of two separate tickets).

Tracking one-way fares (instead of fixed round-trip combos) lets any
departure/return pair be assembled after the fact from two independent daily
numbers, and needs far fewer queries per day than a full round-trip matrix.

Each day's snapshot is a one-shot, unrepeatable observation, so the full set
of single-carrier prices Kayak showed that day is kept (not just our 4
target airlines) in case it's useful later.
"""

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
DEST = "OSL"

TRIP_YEAR = 2027
OUTBOUND_START = date(TRIP_YEAR, 5, 1)
OUTBOUND_END = date(TRIP_YEAR, 6, 30)
DURATIONS_NIGHTS = [10, 11, 12, 13, 14]
RETURN_START = OUTBOUND_START + timedelta(days=min(DURATIONS_NIGHTS))
RETURN_END = OUTBOUND_END + timedelta(days=max(DURATIONS_NIGHTS))

# Project is defined to end here regardless of the workflow's own schedule.
PROJECT_END = date(2027, 5, 1)

TARGET_AIRLINES = {
    "SK": "Scandinavian Airlines",
    "LH": "Lufthansa",
    "LO": "LOT",
    "OS": "Austrian Airlines",
}
# Other carriers that show up on this route, needed so a card mentioning two
# of these names is correctly recognized as a mixed/interline itinerary and
# excluded, rather than mis-read as a single-carrier fare.
ALL_KNOWN_AIRLINES = list(TARGET_AIRLINES.values()) + [
    "Air France", "KLM", "SWISS", "Brussels Airlines", "EL AL", "Iberia",
    "ITA Airways", "TAP AIR PORTUGAL", "TAROM", "Aegean Airlines", "airBaltic",
    "Norwegian", "Ryanair", "Wizz Air", "Emirates", "Etihad Airways",
    "Ethiopian Air", "flydubai", "Sky Express", "British Airways", "Delta",
    "United", "American", "Virgin Atlantic", "JetBlue",
]

SUPABASE_URL = "https://pualpwrkztjzhgpaqudm.supabase.co"
SUPABASE_SCHEMA = "tlv_osl_prices"
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

MIN_SLEEP_SECONDS = 1.5
MAX_SLEEP_SECONDS = 3.0


def build_flight_dates():
    pairs = []
    d = OUTBOUND_START
    while d <= OUTBOUND_END:
        pairs.append((d, "TLV_OSL"))
        d += timedelta(days=1)
    d = RETURN_START
    while d <= RETURN_END:
        pairs.append((d, "OSL_TLV"))
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


def query_one(page, flight_date: date, direction: str):
    origin, dest = (ORIGIN, DEST) if direction == "TLV_OSL" else (DEST, ORIGIN)
    url = f"https://www.kayak.com/flights/{origin}-{dest}/{flight_date.isoformat()}"
    page.goto(url, timeout=60000)
    try:
        page.wait_for_load_state("networkidle", timeout=25000)
    except Exception:
        pass
    page.wait_for_timeout(3500)

    for _ in range(6):
        page.keyboard.press("End")
        page.wait_for_timeout(600)
        try:
            page.get_by_text(re.compile(r"Show more results")).click(timeout=1200, force=True)
            page.wait_for_timeout(1000)
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
    url = f"{SUPABASE_URL}/rest/v1/one_way_prices?select=id&limit=1"
    headers = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Accept-Profile": SUPABASE_SCHEMA,
    }
    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code >= 300:
        raise RuntimeError(f"Supabase connection check failed ({resp.status_code}): {resp.text}")
    print("Supabase connection check ok.")


def upsert_rows(rows):
    if not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/one_way_prices"
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

    check_connection()

    today = date.today()
    if today > PROJECT_END:
        print(f"Today ({today}) is past the project end date ({PROJECT_END}). Nothing to do.")
        return

    flight_dates = build_flight_dates()
    print(f"Today: {today}. Querying {len(flight_dates)} one-way (date, direction) pairs via Kayak.")

    rows = []
    ok_count = 0
    no_data_count = 0

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1400, "height": 1200})

        for flight_date, direction in flight_dates:
            try:
                best = query_one(page, flight_date, direction)
                rows.append(
                    {
                        "sample_date": today.isoformat(),
                        "flight_date": flight_date.isoformat(),
                        "direction": direction,
                        "query_status": "ok",
                        "sas_price": best.get(TARGET_AIRLINES["SK"]),
                        "lufthansa_price": best.get(TARGET_AIRLINES["LH"]),
                        "lot_price": best.get(TARGET_AIRLINES["LO"]),
                        "austrian_price": best.get(TARGET_AIRLINES["OS"]),
                        "raw_snapshot": best or None,
                        "currency": "USD",
                    }
                )
                ok_count += 1
            except Exception as e:
                print(f"  no data for {flight_date} {direction}: {type(e).__name__}: {e}")
                rows.append(
                    {
                        "sample_date": today.isoformat(),
                        "flight_date": flight_date.isoformat(),
                        "direction": direction,
                        "query_status": "no_data",
                        "sas_price": None,
                        "lufthansa_price": None,
                        "lot_price": None,
                        "austrian_price": None,
                        "raw_snapshot": None,
                        "currency": "USD",
                    }
                )
                no_data_count += 1

            time.sleep(random.uniform(MIN_SLEEP_SECONDS, MAX_SLEEP_SECONDS))

        browser.close()

    sas_n = sum(1 for r in rows if r["sas_price"] is not None)
    lh_n = sum(1 for r in rows if r["lufthansa_price"] is not None)
    lo_n = sum(1 for r in rows if r["lot_price"] is not None)
    os_n = sum(1 for r in rows if r["austrian_price"] is not None)
    print(f"Done: {ok_count} ok, {no_data_count} no_data.")
    print(f"Priced -- SAS: {sas_n}, Lufthansa: {lh_n}, LOT: {lo_n}, Austrian: {os_n} (out of {len(rows)}).")

    CHUNK = 50
    for i in range(0, len(rows), CHUNK):
        upsert_rows(rows[i : i + CHUNK])

    print(f"Upserted {len(rows)} rows to Supabase.")


if __name__ == "__main__":
    main()
