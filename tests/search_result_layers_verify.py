import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Route, sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
DEV_PASSWORD = os.environ.get("ADMIN_PASSWORD", "dev-only-change-me-1234567890")
SESSION_TOKEN = os.environ.get("SESSION_TOKEN")
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "jpgr_session")
SCREENSHOT = Path(tempfile.gettempdir()) / "jpgr-search-result-layers.png"


def product(item_id: str, title: str, price: int):
    return {
        "sourceId": "mercari_jp",
        "sourceItemId": item_id,
        "identityScope": "listing",
        "canonicalUrl": f"https://jp.mercari.com/item/{item_id}",
        "title": title,
        "currency": "JPY",
        "currentPrice": price,
        "priceBasis": "listing_price",
        "condition": "used",
        "availability": "available",
        "rawMetadata": {"sourceConditionLabel": "中古"},
    }


INITIAL_PRODUCTS = [
    product("m10000001", "Re:ゼロ エミリア 特典カード", 4_800),
    product("m10000002", " unrelated kitchen timer ", 900),
    product("m10000003", "Re:ゼロ レム アクリルスタンド", 2_400),
]
NEXT_PRODUCT = product("m10000004", "Re:ゼロ ベアトリス 缶バッジ", 1_600)
SOURCE_STATES = [
    {"id": "mercari_jp", "enabled": 1, "adapter_available": True, "history_search_supported": True, "health_status": "healthy", "monitoring_allowed": True, "cooldown_until": None},
    {"id": "yahoo_shopping", "enabled": 1, "adapter_available": True, "history_search_supported": False, "health_status": "healthy", "monitoring_allowed": True, "cooldown_until": None},
    {"id": "charaon", "enabled": 1, "adapter_available": True, "history_search_supported": False, "health_status": "healthy", "monitoring_allowed": True, "cooldown_until": None},
]


def group(source_id: str, listings: list[dict], next_cursor: str | None = None):
    return {
        "sourceId": source_id,
        "status": "success" if listings else "empty",
        "listings": listings,
        "coverage": "rolling_window",
        "warnings": [],
        "durationMs": 120,
        "nextCursor": next_cursor,
        "requestEvidence": {
            "availabilityMode": "all",
            "rawResultCount": len(listings),
            "normalizedResultCount": len(listings),
            "pagesFetched": 1,
        },
    }


def enrichment(item: dict):
    irrelevant = "kitchen timer" in item["title"]
    return {
        "relevance": "irrelevant" if irrelevant else "relevant",
        "relevanceReason": "与搜索作品无关" if irrelevant else "标题与搜索作品一致",
        "translatedTitle": "无关的厨房计时器" if irrelevant else item["title"],
        "summary": "来源商品事实已整理。",
        "normalizedCategory": "角色周边",
        "productType": "收藏品",
        "workTitle": None if irrelevant else "Re:ゼロから始める異世界生活",
        "series": None,
        "characters": [],
        "officialStatus": "unknown",
        "normalizedCondition": "used",
        "conditionNotes": ["中古"],
        "defects": [],
        "missingParts": [],
        "includedItems": [],
        "editionOrModel": None,
        "extraInfo": {},
        "evidence": [{"field": "title", "quote": item["title"].strip()}],
        "confidence": "high",
    }


ai_batches: list[list[str]] = []


def fulfill(route: Route, body: object, status: int = 200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body, ensure_ascii=False))


def handle_api(route: Route):
    request = route.request
    path = urlparse(request.url).path
    if path.endswith("/api/dashboard"):
        fulfill(route, {"summary": {"activeWatches": 0, "activeSources": 3, "todaySearches": 0, "todayNewListings": 0, "todayPriceDrops": 0, "todayEmails": 0, "failingSources": 0, "emailProtectionTriggered": False}, "recentEvents": []})
        return
    if path.endswith("/api/sources"):
        fulfill(route, {"items": SOURCE_STATES})
        return
    if path.endswith("/api/item-watches") and request.method == "GET":
        fulfill(route, {"items": []})
        return
    if path.endswith("/api/search/preview") and request.method == "GET":
        fulfill(route, {"items": []})
        return
    if path.endswith("/api/search/preview") and request.method == "POST":
        payload = request.post_data_json
        if payload.get("sourcePageTokens"):
            assert payload.get("searchSessionId") == "11111111-1111-4111-8111-111111111111"
            groups = [group("mercari_jp", [NEXT_PRODUCT])]
        else:
            groups = [
                group("mercari_jp", INITIAL_PRODUCTS, "page-2"),
                group("yahoo_shopping", []),
                group("charaon", []),
            ]
        fulfill(route, {
            "groups": groups,
            "historyId": "22222222-2222-4222-8222-222222222222" if payload.get("sourcePageTokens") else "11111111-1111-4111-8111-111111111111",
            "sessionId": "11111111-1111-4111-8111-111111111111",
        })
        return
    if path.endswith("/api/ai/listing-enrichment") and request.method == "POST":
        items = request.post_data_json["items"]
        ai_batches.append([item["sourceItemId"] for item in items])
        fulfill(route, {
            "jobId": f"22222222-2222-4222-8222-{len(ai_batches):012d}",
            "status": "completed",
            "items": [enrichment(item) for item in items],
            "itemStatuses": ["completed" for _ in items],
            "completedItems": len(items),
            "failedItems": 0,
            "totalItems": len(items),
            "model": "gemini-3.5-flash-lite",
            "taskPersisted": True,
        })
        return
    route.continue_()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    page.set_default_timeout(20_000)
    page.set_default_navigation_timeout(120_000)
    errors: list[str] = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/api/**", handle_api)

    if SESSION_TOKEN:
        context.add_cookies([{"name": SESSION_COOKIE_NAME, "value": SESSION_TOKEN, "url": BASE_URL}])
    else:
        page.goto(f"{BASE_URL}/login", wait_until="domcontentloaded")
        page.get_by_label("管理员密码").fill(DEV_PASSWORD)
        page.get_by_role("button", name="进入系统").click()
        page.wait_for_url(re.compile(r"/dashboard$"))
    page.goto(f"{BASE_URL}/search", wait_until="networkidle")
    page.get_by_role("button", name="宽泛关键词").click()
    page.get_by_label("想找什么？").fill("Re:ゼロ")
    page.get_by_role("button", name="开始搜索").click()

    page.get_by_text("Gemini 已清洗 3 件", exact=True).wait_for()
    curated = page.locator(".curated-result-section .result-product-card")
    assert curated.count() == 2
    assert curated.filter(has_text="kitchen timer").count() == 0
    assert page.locator(".manual-pool-section").count() == 0
    assert curated.locator(".result-ai-brief").count() == 0
    first_card = curated.first
    assert first_card.get_by_role("button", name="展开商品详情").get_attribute("aria-expanded") == "false"
    first_card.get_by_role("button", name="展开商品详情").click()
    first_card.locator(".result-ai-brief").wait_for()
    assert first_card.get_by_role("button", name="收起商品详情").get_attribute("aria-expanded") == "true"

    source_filter = page.get_by_role("combobox", name="01 来源 Source")
    source_filter.click()
    assert page.locator(".editorial-select-option").filter(has_text="Yahoo! Shopping（实验） · 0 件").count() == 1
    assert page.locator(".editorial-select-option").filter(has_text="CharaON · 0 件").count() == 1
    page.keyboard.press("Escape")

    result_scope = page.get_by_role("combobox", name="00 查看范围 Result scope")
    result_scope.click()
    page.locator(".editorial-select-option").filter(has_text="完整人工检索池").click()
    manual_cards = page.locator(".manual-pool-section .result-product-card")
    assert manual_cards.count() == 3
    assert manual_cards.filter(has_text="kitchen timer").count() == 1

    page.get_by_role("button", name="继续读取 Mercari 下一页").click()
    page.get_by_text("Gemini 已清洗 4 件", exact=True).wait_for()
    assert ai_batches == [["m10000001", "m10000002", "m10000003"], ["m10000004"]]
    assert page.locator(".manual-pool-section .result-product-card").count() == 4
    result_scope.click()
    page.locator(".editorial-select-option").filter(has_text="整理后结果").click()
    assert page.locator(".curated-result-section .result-product-card").count() == 3
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")

    page.screenshot(path=SCREENSHOT, full_page=True)
    runtime_errors = [error for error in errors if "/_next/webpack-hmr" not in error]
    assert not runtime_errors, " | ".join(runtime_errors)
    browser.close()

print(f"search_result_layers_ok screenshot={SCREENSHOT}")
