"""
Dashboard smoke tests -- runs against the live Supabase data (read-only
anon key), same as a real visitor. Formalizes the manual checks that were
being run ad hoc during development (page loads with no console errors,
controls populate, switching destinations doesn't break anything, hovering
a chart actually shows something). Run via `python tests/test_dashboard.py`
(needs a local static server -- see .github/workflows/test.yml) or in CI on
every push, so a regression like the earlier "supabase const name collision
silently killed all JS" bug gets caught automatically instead of by a user
report.
"""

import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8000/"
DESTINATIONS = ["OSL", "YYC", "YVR", "ANC", "ORD"]

failures = []


def check(label, condition):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        failures.append(label)


def main():
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8000"],
        cwd=".",
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1200, "height": 1400})
            console_errors = []
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: console_errors.append(str(e)))

            page.goto(BASE_URL, timeout=20000)
            page.wait_for_timeout(3000)

            check("page has no JS console/page errors on load", len(console_errors) == 0)
            if console_errors:
                for e in console_errors:
                    print("    ", e)

            check(
                "destination dropdown has all 5 destinations",
                page.eval_on_selector_all("#destinationSelect option", "els => els.length") == len(DESTINATIONS),
            )
            check(
                "duration dropdown is populated",
                page.eval_on_selector_all("#durationSelect2 option", "els => els.length") > 0,
            )
            check(
                "departure date dropdown is populated",
                page.eval_on_selector_all("#departureSelect option", "els => els.length") > 0,
            )
            check(
                "outbound heatmap rendered at least one cell",
                page.eval_on_selector_all("#heatmapOutbound rect", "els => els.length") > 0,
            )

            # Hover a heatmap cell and confirm the tooltip actually shows text
            console_errors.clear()
            rects = page.locator("#heatmapOutbound rect")
            if rects.count() > 0:
                box = rects.nth(min(20, rects.count() - 1)).bounding_box()
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.wait_for_timeout(300)
                tooltip_text = page.eval_on_selector("#heatmapTooltip", "el => el.textContent")
                check("hovering a heatmap cell shows tooltip text", bool(tooltip_text and tooltip_text.strip()))
            else:
                check("hovering a heatmap cell shows tooltip text", False)

            # Switching destination should not throw and should repopulate controls
            for code in DESTINATIONS:
                console_errors.clear()
                page.select_option("#destinationSelect", code)
                page.wait_for_timeout(1500)
                check(f"switching to destination {code} raises no console errors", len(console_errors) == 0)
                if console_errors:
                    for e in console_errors:
                        print("    ", e)

            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("All checks passed.")


if __name__ == "__main__":
    main()
