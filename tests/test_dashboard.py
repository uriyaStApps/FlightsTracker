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

            # A transient network hiccup reaching Supabase from the CI runner
            # (seen for real: an ERR_FAILED / a 504 elsewhere in this project)
            # would otherwise fail every downstream check for a reason that
            # has nothing to do with the code under test. One reload is
            # enough to tell "genuinely broken" apart from "network blip".
            if page.eval_on_selector_all("#heatmapOutbound rect", "els => els.length") == 0:
                print("  (no trend chart rendered after first load -- retrying once in case of a transient network issue)")
                console_errors.clear()
                page.reload(timeout=20000)
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
                "outbound date dropdown is populated",
                page.eval_on_selector_all("#outboundDateSelect option", "els => els.length") > 0,
            )
            check(
                "return date dropdown is populated",
                page.eval_on_selector_all("#returnDateSelect option", "els => els.length") > 0,
            )
            check(
                "package departure dropdown is populated",
                page.eval_on_selector_all("#packageDepartureSelect option", "els => els.length") > 0,
            )
            check(
                "package duration dropdown is populated",
                page.eval_on_selector_all("#packageDurationSelect option", "els => els.length") > 0,
            )
            check(
                "outbound trend chart rendered at least one line",
                page.eval_on_selector_all("#heatmapOutbound path", "els => els.length") > 0,
            )

            # Hover the outbound trend chart and confirm the tooltip both shows
            # text AND actually lands near the cursor on screen -- catches the
            # class of bug where the tooltip renders with content but at a
            # position computed with the wrong coordinate system (e.g.
            # page-relative coordinates used inside a `position: relative`
            # ancestor), which a text-only check would miss entirely. Hit this
            # for real: a `position: absolute` tooltip inside a
            # `position: relative` `.chart-shell` combined with page-relative
            # `e.pageX/pageY` placed the tooltip far from the cursor,
            # effectively invisible.
            console_errors.clear()
            rects = page.locator("#heatmapOutbound rect")
            if rects.count() > 0:
                idx = min(20, rects.count() - 1)
                box = rects.nth(idx).bounding_box()
                cursor_x, cursor_y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                page.mouse.move(cursor_x, cursor_y)
                page.wait_for_timeout(300)
                tooltip_text = page.eval_on_selector("#heatmapTooltipOutbound", "el => el.textContent")
                check("hovering the outbound trend chart shows tooltip text", bool(tooltip_text and tooltip_text.strip()))

                tbox = page.eval_on_selector(
                    "#heatmapTooltipOutbound",
                    "el => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; }",
                )
                viewport = page.viewport_size
                near_cursor = abs(tbox["x"] - cursor_x) < 200 and abs(tbox["y"] - cursor_y) < 200
                on_screen = 0 <= tbox["x"] <= viewport["width"] and 0 <= tbox["y"] <= viewport["height"]
                check(f"tooltip renders on-screen near the cursor (tooltip at {tbox}, cursor at {cursor_x:.0f},{cursor_y:.0f})", near_cursor and on_screen)
            else:
                check("hovering the outbound trend chart shows tooltip text", False)
                check("tooltip renders on-screen near the cursor", False)

            # Switching destination should not throw and should repopulate controls.
            # A genuine JS bug is deterministic across destinations; a lone
            # failure surrounded by passes is the network-blip signature (see
            # above) -- one retry tells them apart instead of failing the
            # whole suite on a fluke unrelated to the code being tested.
            for code in DESTINATIONS:
                console_errors.clear()
                page.select_option("#destinationSelect", code)
                page.wait_for_timeout(1500)
                if console_errors:
                    print(f"  ({code} had console errors on first try -- retrying once in case of a network blip)")
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
