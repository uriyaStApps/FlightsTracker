from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1000, "height": 900})
    errors = []
    page.on("console", lambda msg: errors.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda exc: errors.append(f"[pageerror] {exc}"))
    page.goto("https://uriyastapps.github.io/NorwayFlightsTracker2028/", timeout=60000)
    page.wait_for_timeout(4000)
    print("CONSOLE/ERRORS:")
    for e in errors:
        print(" ", e)
    print("durationSelect outerHTML:")
    print(page.eval_on_selector("#durationSelect", "el => el.outerHTML"))
    print("supabase defined:", page.evaluate("() => typeof window.supabase"))
    page.screenshot(path="debug_screenshot.png", full_page=True)
    browser.close()
