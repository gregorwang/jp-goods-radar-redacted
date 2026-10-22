import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
DEV_PASSWORD = os.environ.get("ADMIN_PASSWORD", "dev-only-change-me-1234567890")
ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    page.set_default_timeout(10_000)
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: console_errors.append(str(error)))

    page.goto(f"{BASE_URL}/login", wait_until="networkidle")
    print("stage=login_loaded", flush=True)
    assert "进入雷达室" in page.locator("body").inner_text()
    assert page.locator("[data-nextjs-dialog]").count() == 0
    login_button = page.get_by_role("button", name="进入系统")
    assert login_button.is_enabled()
    assert login_button.evaluate("(element) => getComputedStyle(element).cursor") == "pointer"
    assert page.get_by_label("管理员密码").get_attribute("minlength") is None
    page.screenshot(path=ARTIFACTS / "login-desktop.png", full_page=True)

    page.get_by_label("管理员密码").fill(DEV_PASSWORD)
    login_button.click()
    page.wait_for_url(f"{BASE_URL}/dashboard")
    page.wait_for_load_state("networkidle")
    print("stage=dashboard_loaded", flush=True)
    assert "静候" in page.locator("body").inner_text()
    assert page.locator(".briefing-grid").count() == 1
    assert page.locator(".briefing-signals article").count() == 3
    assert page.locator("[data-nextjs-dialog]").count() == 0
    page.wait_for_timeout(1_000)
    page.screenshot(path=ARTIFACTS / "dashboard-desktop.png", full_page=True)

    page.goto(f"{BASE_URL}/search", wait_until="networkidle")
    print("stage=search_loaded", flush=True)
    assert "寻找" in page.locator("body").inner_text()
    assert page.get_by_role("button", name="开始搜索").is_disabled()
    page.screenshot(path=ARTIFACTS / "search-desktop.png", full_page=True)

    page.goto(f"{BASE_URL}/events", wait_until="networkidle")
    print("stage=events_loaded", flush=True)
    event_type = page.get_by_role("combobox", name="01 事件类型 Event type")
    assert event_type.is_visible()
    assert page.get_by_role("combobox", name="02 发送状态 Delivery status").is_visible()
    event_type.click()
    assert page.get_by_text("价格下降", exact=True).is_visible()
    page.wait_for_timeout(450)
    page.screenshot(path=ARTIFACTS / "events-dropdown-open.png")
    page.get_by_text("价格下降", exact=True).click()
    assert "价格下降" in event_type.inner_text()
    event_type.click()
    page.keyboard.press("Escape")
    page.wait_for_timeout(220)
    assert page.locator(".editorial-select-trigger").first.get_attribute("aria-expanded") == "false"
    assert page.locator(".rail-index").count() == 0
    assert page.locator(".topline p").inner_text() == "SIGNALS / 变化记录"
    assert page.locator(".page-hero .eyebrow").inner_text() == "EVENTS"
    expanded_rail_width = page.locator(".side-rail").evaluate("(element) => element.getBoundingClientRect().width")
    collapse_button = page.get_by_role("button", name="收起侧边栏")
    expanded_rail_box = page.locator(".side-rail").bounding_box()
    collapse_button_box = collapse_button.bounding_box()
    assert expanded_rail_box is not None and collapse_button_box is not None
    assert collapse_button_box["x"] + collapse_button_box["width"] <= expanded_rail_box["x"] + expanded_rail_box["width"]
    assert collapse_button_box["width"] == 44
    assert collapse_button.evaluate("(element) => getComputedStyle(element).boxShadow") == "none"
    collapse_button.click()
    page.locator('.app-shell[data-rail-collapsed="true"]').wait_for(state="attached")
    page.wait_for_timeout(120)
    mid_rail_width = page.locator(".side-rail").evaluate("(element) => element.getBoundingClientRect().width")
    assert 88 < mid_rail_width < expanded_rail_width, (expanded_rail_width, mid_rail_width)
    page.wait_for_timeout(300)
    assert page.locator(".side-rail").evaluate("(element) => element.getBoundingClientRect().width") == 88
    assert page.locator(".rail-label").first.evaluate("(element) => getComputedStyle(element).visibility") == "hidden"
    collapsed_rail_box = page.locator(".side-rail").bounding_box()
    expand_button_box = page.get_by_role("button", name="展开侧边栏").bounding_box()
    assert collapsed_rail_box is not None and expand_button_box is not None
    assert expand_button_box["x"] + expand_button_box["width"] <= collapsed_rail_box["x"] + collapsed_rail_box["width"]
    page.reload(wait_until="networkidle")
    assert page.get_by_role("button", name="展开侧边栏").is_visible()
    page.screenshot(path=ARTIFACTS / "events-desktop.png", full_page=True)

    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(f"{BASE_URL}/events", wait_until="networkidle")
    print("stage=events_mobile_loaded", flush=True)
    assert page.get_by_role("button", name="展开侧边栏").is_hidden()
    mobile_filter_columns = page.locator(".event-filters").evaluate("(element) => getComputedStyle(element).gridTemplateColumns")
    assert len(mobile_filter_columns.split()) == 1
    assert page.evaluate("document.documentElement.scrollWidth === document.documentElement.clientWidth")
    page.screenshot(path=ARTIFACTS / "events-mobile.png", full_page=True)

    page.goto(f"{BASE_URL}/dashboard", wait_until="networkidle")
    print("stage=mobile_loaded", flush=True)
    assert page.locator(".side-rail").count() == 1
    assert page.locator(".briefing-grid").count() == 1
    assert page.locator(".briefing-signals article").count() == 3
    page.screenshot(path=ARTIFACTS / "dashboard-mobile.png", full_page=True)

    if console_errors:
        raise AssertionError("Browser console errors: " + " | ".join(console_errors))

    print("BROWSER_VERIFY_OK login dashboard search events rail mobile console=0")
    browser.close()
