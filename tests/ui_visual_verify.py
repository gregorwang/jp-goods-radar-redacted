from pathlib import Path
import os
from playwright.sync_api import sync_playwright

ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
BASE_URL = os.environ.get("UI_BASE_URL", "http://127.0.0.1:3001").rstrip("/")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors: list[str] = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{BASE_URL}/login", wait_until="commit", timeout=60_000)
    page.wait_for_selector(".login-title-art", timeout=60_000)
    page.wait_for_function("document.querySelector('.login-title-art')?.complete")
    assert page.locator(".login-title-art").evaluate("element => element.complete && element.naturalWidth > 0")
    assert page.locator(".login-shadow-art").evaluate("element => element.complete && element.naturalWidth > 0")
    assert page.get_by_role("button", name="进入系统").is_enabled()
    page.screenshot(path=ARTIFACTS / "login-v4-desktop.png", full_page=True)

    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(f"{BASE_URL}/login", wait_until="commit", timeout=60_000)
    page.wait_for_selector(".login-title-art", timeout=60_000)
    page.wait_for_function("document.querySelector('.login-title-art')?.complete")
    assert page.locator(".login-page").evaluate("element => element.scrollWidth <= window.innerWidth")
    page.screenshot(path=ARTIFACTS / "login-v4-mobile.png", full_page=True)
    runtime_errors = [error for error in errors if "/_next/webpack-hmr" not in error]
    if runtime_errors:
        raise AssertionError("Browser console errors: " + " | ".join(runtime_errors))
    print("UI_VISUAL_VERIFY_OK desktop mobile assets console=0")
    browser.close()
