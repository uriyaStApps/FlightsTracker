"""
Daily TLV<->OSL price sampler for Lufthansa + SAS, via Kayak (headless browser).

Runs once a day (via GitHub Actions). For every (departure_date, return_date)
pair in the May-June 2027 trip matrix, loads the Kayak search results page and
reads whatever price Kayak's own "cheapest per airline" sidebar shows for
Lufthansa and SAS right now.

SAS rarely operates this route itself (it shows up only via occasional
interline/codeshare fares), so its price is often simply not present in that
sidebar on a given day -- that's a real fact about the market, not a scraper
bug, and is recorded as such (null) rather than forced. Each day's snapshot is
a one-shot, unrepeatable observation, so a compact snapshot of the whole
top-priced-airlines list is kept alongside the two prices we care about.
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
MATRIX_START = date(TRIP_YEAR, 5, 1)
MATRIX_END = date(TRIP_YEAR, 6, 30)
DURATIONS_NIGHTS = [10, 11, 12, 13, 14]

# Project is defined to end here regardless of the workflow's own schedule.
PROJECT_END = date(2027, 5, 1)

SUPABASE_URL = "https://pualpwrkztjzhgpaqudm.supabase.co"
SUPABASE_SCHEMA = "tlv_osl_prices"
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

MIN_SLEEP_SECONDS = 1.5
MAX_SLEEP_SECONDS = 3.0

AIRLINE_ROW_JS = """
() => {
    const out = [];
    document.querySelectorAll('input[id^="valueSetFilter-vertical-airlines-"]').forEach(inp => {
        const code = inp.id.split('-').pop();
        const row = inp.closest('.hYzH');
        const label = row ? row.querySelector('.hYzH-checkbox-label') : null;
        const priceEl = row ? row.querySelector('.hYzH-price') : null;
        out.push({
            code,
            name: label ? label.textContent : null,
            price: priceEl ? priceEl.textContent : null,
        });
    });
    return out;
}
"""


def build_date_pairs():
    pairs = []
    d = MATRIX_START
    while d <= MATRIX_END:
        for nights in DURATIONS_NIGHTS:
            pairs.append((d, d + timedelta(days=nights)))
        d += timedelta(days=1)
    return pairs


def parse_price(text):
    if not text:
        return None
    m = re.search(r"[\d,]+", text)
    return int(m.group(0).replace(",", "")) if m else None


def query_one(page, dep: date, ret: date):
    url = f"https://www.kayak.com/flights/{ORIGIN}-{DEST}/{dep.isoformat()}/{ret.isoformat()}"
    page.goto(url, timeout=60000)
    try:
        page.wait_for_load_state("networkidle", timeout=25000)
    except Exception:
        pass
    page.wait_for_timeout(4000)

    rows = page.evaluate(AIRLINE_ROW_JS)

    body_text = page.inner_text("body")
    total_match = re.search(r"of ([\d,]+) flights", body_text)
    total_flights = int(total_match.group(1).replace(",", "")) if total_match else None

    priced = [r for r in rows if r["price"]]
    for r in priced:
        r["price"] = parse_price(r["price"])

    by_code = {r["code"]: r["price"] for r in rows if r["price"]}
    return {
        "lufthansa_price": by_code.get("LH"),
        "sas_price": by_code.get("SK"),
        "total_flights": total_flights,
        "top_airlines": priced,
    }


def check_connection():
    url = f"{SUPABASE_URL}/rest/v1/price_samples?select=id&limit=1"
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

    check_connection()

    today = date.today()
    if today > PROJECT_END:
        print(f"Today ({today}) is past the project end date ({PROJECT_END}). Nothing to do.")
        return

    pairs = build_date_pairs()
    print(f"Today: {today}. Querying {len(pairs)} date pairs via Kayak.")

    rows = []
    ok_count = 0
    no_data_count = 0

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1400, "height": 1200})

        for dep, ret in pairs:
            try:
                result = query_one(page, dep, ret)
                rows.append(
                    {
                        "sample_date": today.isoformat(),
                        "departure_date": dep.isoformat(),
                        "return_date": ret.isoformat(),
                        "query_status": "ok",
                        "lufthansa_price": result["lufthansa_price"],
                        "sas_price": result["sas_price"],
                        "total_flights": result["total_flights"],
                        "top_airlines": result["top_airlines"] or None,
                        "currency": "USD",
                    }
                )
                ok_count += 1
            except Exception as e:
                print(f"  no data for {dep} / {ret}: {type(e).__name__}: {e}")
                rows.append(
                    {
                        "sample_date": today.isoformat(),
                        "departure_date": dep.isoformat(),
                        "return_date": ret.isoformat(),
                        "query_status": "no_data",
                        "lufthansa_price": None,
                        "sas_price": None,
                        "total_flights": None,
                        "top_airlines": None,
                        "currency": "USD",
                    }
                )
                no_data_count += 1

            time.sleep(random.uniform(MIN_SLEEP_SECONDS, MAX_SLEEP_SECONDS))

        browser.close()

    lh_found = sum(1 for r in rows if r["lufthansa_price"] is not None)
    sas_found = sum(1 for r in rows if r["sas_price"] is not None)
    print(f"Done: {ok_count} ok, {no_data_count} no_data. Lufthansa priced: {lh_found}, SAS priced: {sas_found}.")

    CHUNK = 50
    for i in range(0, len(rows), CHUNK):
        upsert_rows(rows[i : i + CHUNK])

    print(f"Upserted {len(rows)} rows to Supabase.")


if __name__ == "__main__":
    main()
