import os
import re
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
REFERENCE_URL = os.environ.get("REFERENCE_URL", "").rstrip("/")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SESSION_TOKEN = os.environ.get("SESSION_TOKEN", "")
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "jpgr_session")
ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)


def settled_goto(page, url: str) -> None:
    page.goto(url, wait_until="domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=6_000)
    except PlaywrightTimeoutError:
        print(f"networkidle_timeout url={page.url}", flush=True)
    page.locator("body").wait_for(state="visible")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    if SESSION_TOKEN:
        context.add_cookies([
            {
                "name": SESSION_COOKIE_NAME,
                "value": SESSION_TOKEN,
                "url": BASE_URL,
                "httpOnly": True,
                "sameSite": "Strict",
            }
        ])
    page = context.new_page()
    page.set_default_timeout(45_000)
    console_errors: list[str] = []
    api_responses: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: console_errors.append(str(error)))
    page.on("response", lambda response: api_responses.append(f"{response.status} {response.url}") if "/api/" in response.url else None)

    if SESSION_TOKEN:
        settled_goto(page, f"{BASE_URL}/dashboard")
    else:
        assert PASSWORD, "ADMIN_PASSWORD or SESSION_TOKEN is required"
        settled_goto(page, f"{BASE_URL}/login")
        page.get_by_label("管理员密码").fill(PASSWORD)
        page.get_by_role("button", name="进入系统").click()
        page.wait_for_url(f"{BASE_URL}/dashboard")
        page.wait_for_load_state("networkidle")
    print(f"stage=authenticated url={page.url}", flush=True)

    settled_goto(page, f"{BASE_URL}/listings")
    try:
        page.get_by_role("link", name=re.compile("打开商品记录")).first.wait_for(timeout=15_000)
    except PlaywrightTimeoutError:
        print("api_responses=" + " | ".join(api_responses), flush=True)
        print("console_errors=" + " | ".join(console_errors), flush=True)
        raise
    print(f"stage=listings url={page.url}", flush=True)
    listings_text = page.locator("body").inner_text()
    assert "已存商品记录" in listings_text
    assert "商品事实与监控设置，分开归档。" in listings_text
    assert "查看历史" not in listings_text
    assert page.get_by_role("link", name=re.compile("打开商品记录")).count() > 0
    assert page.get_by_role("button", name=re.compile("正在监控|监控已暂停")).count() == 0
    page.screenshot(path=ARTIFACTS / "listing-records-desktop.png", full_page=True)

    watched_cards = page.locator('article.listing-card[data-watched="true"]')
    record_card = watched_cards.first if watched_cards.count() else page.locator("article.listing-card").first
    record_href = record_card.get_by_role("link", name=re.compile("打开商品记录")).get_attribute("href")
    assert record_href is not None
    settled_goto(page, f"{BASE_URL}{record_href}")
    print(f"stage=listing_detail url={page.url}", flush=True)

    detail_text = page.locator("body").inner_text()
    assert "CURRENT / ITEM RECORD" in detail_text
    assert "商品记录" in detail_text
    assert "关注档案" in detail_text
    assert "价格快照" in detail_text
    assert "该商品的变化事件" in detail_text
    assert page.get_by_role("link", name=re.compile("打开全局变化记录")).count() == 1
    assert page.get_by_role("button", name=re.compile("立即巡回|暂停巡回|恢复巡回|删除整份档案")).count() == 0

    if "FIRST BASELINE" in detail_text:
        assert page.locator(".price-chart").count() == 0
    if page.locator(".price-chart").count():
        assert page.locator(".record-timeline > div").count() >= 2
    if page.locator(".record-timeline-scroll").count():
        overflow = page.locator(".record-timeline-scroll").first.evaluate(
            "element => ({maxHeight: getComputedStyle(element).maxHeight, overflowY: getComputedStyle(element).overflowY})"
        )
        assert overflow["maxHeight"] == "390px"
        assert overflow["overflowY"] == "auto"
    page.screenshot(path=ARTIFACTS / "listing-record-detail-desktop.png", full_page=True)

    related_watch = page.get_by_role("link", name=re.compile("关联关注档案|管理关注档案")).first
    if related_watch.count():
        watch_href = related_watch.get_attribute("href")
        assert watch_href is not None
        settled_goto(page, f"{BASE_URL}{watch_href}")
        print(f"stage=watch_dossier url={page.url}", flush=True)
        watch_text = page.locator("body").inner_text()
        assert "监控计划与运行记录" in watch_text
        assert "打开商品记录：价格快照与变化事件" in watch_text
        assert page.get_by_role("button", name="删除整份档案").count() == 1
        page.screenshot(path=ARTIFACTS / "watch-dossier-cross-link-desktop.png", full_page=True)

    settled_goto(page, f"{BASE_URL}/events")
    print(f"stage=events url={page.url}", flush=True)
    assert page.locator(".page-hero .eyebrow").inner_text() == "EVENTS / GLOBAL INBOX"
    assert "全局变化收件箱" in page.locator("body").inner_text()
    assert page.locator(".event-inbox-card h3 a").count() == 0
    page.screenshot(path=ARTIFACTS / "global-events-desktop.png", full_page=True)

    settled_goto(page, f"{BASE_URL}/dashboard")
    print(f"stage=dashboard_cross_link url={page.url}", flush=True)
    assert page.get_by_role("link", name="打开全局变化记录").count() == 1

    page.set_viewport_size({"width": 390, "height": 844})
    settled_goto(page, f"{BASE_URL}{record_href}")
    print(f"stage=listing_detail_mobile url={page.url}", flush=True)
    assert page.evaluate("document.documentElement.scrollWidth === document.documentElement.clientWidth")
    assert page.locator(".detail-route-context").evaluate(
        "element => getComputedStyle(element).gridTemplateColumns.split(' ').length"
    ) == 1
    page.screenshot(path=ARTIFACTS / "listing-record-detail-mobile.png", full_page=True)

    if REFERENCE_URL:
        reference = context.new_page()
        reference.set_viewport_size({"width": 1440, "height": 1000})
        settled_goto(reference, f"{REFERENCE_URL}/kakekoi/")
        print(f"stage=reference url={reference.url}", flush=True)
        assert reference.locator("body").is_visible()
        reference.screenshot(path=ARTIFACTS / "kakekoi-reference-desktop.png", full_page=True)
        reference.close()

    if console_errors:
        raise AssertionError("Browser console errors: " + " | ".join(console_errors))

    browser.close()

print("LISTING_INFORMATION_ARCHITECTURE_VERIFY_OK records detail dossier events dashboard mobile reference console=0")
