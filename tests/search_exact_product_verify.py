import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
DEV_PASSWORD = os.environ.get("ADMIN_PASSWORD", "dev-only-change-me-1234567890")
SESSION_TOKEN = os.environ.get("SESSION_TOKEN")
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "jpgr_session")
SCREENSHOT = Path(tempfile.gettempdir()) / "jpgr-search-exact-product.png"
ACTION_SCREENSHOT = Path(tempfile.gettempdir()) / "jpgr-search-watch-action.png"
PRICE_SCREENSHOT = Path(tempfile.gettempdir()) / "jpgr-search-price-intelligence.png"
SOLD_MOBILE_SCREENSHOT = Path(tempfile.gettempdir()) / "jpgr-search-sold-intelligence-mobile.png"
SESSION_ID = "11111111-1111-4111-8111-111111111111"
WATCH_PROFILE_ID = "22222222-2222-4222-8222-222222222222"
PRODUCT_IDENTITY = {
    "productVariantId": "pv_1111111111111111",
    "canonicalProductId": "cp_1111111111111111",
    "comparisonProfileId": "cmp_1111111111111111",
    "confirmedCount": 1,
    "rejectedCount": 5,
    "uncertainCount": 0,
    "projectedAt": "2026-07-17T00:00:00.000Z",
}

TARGET = {
    "workTitle": "Re:ゼロから始める異世界生活",
    "characters": ["ラインハルト", "ラインハルト・ヴァン・アストレア"],
    "productType": "ぬいぐるみ",
    "manufacturer": "GSクラフト",
    "model": "N0065",
    "jan": "4589955576984",
    "size": "18cm",
    "aliases": ["剣聖"],
    "excludedTerms": ["GiGO", "ちびぐるみ", "プライズ"],
}

SOURCE_STATES = [
    {
        "id": "yahoo_fleamarket_jp",
        "enabled": 1,
        "adapter_available": True,
        "history_search_supported": False,
        "health_status": "healthy",
        "monitoring_allowed": True,
        "cooldown_until": None,
    },
    {
        "id": "rakuten_books",
        "enabled": 1,
        "adapter_available": True,
        "history_search_supported": False,
        "health_status": "healthy",
        "monitoring_allowed": True,
        "cooldown_until": None,
    },
]


def listing(
    item_id: str,
    title: str,
    price: int,
    *,
    description: str = "",
    manufacturer: str | None = None,
    availability: str = "available",
    source_listed_at: str | None = None,
):
    facts = {
        "manufacturer": manufacturer,
        "workTitle": "Re:ゼロから始める異世界生活",
        "characters": ["ラインハルト"],
        "categoryPath": ["ぬいぐるみ"],
        "identifiers": {},
        "specifications": [],
    }
    if item_id == "z589863828":
        facts["identifiers"] = {"jan": "4589955576984", "modelNumber": "N0065"}
        facts["specifications"] = [{"name": "全長", "value": "18cm"}]
    item = {
        "sourceId": "yahoo_fleamarket_jp",
        "sourceItemId": item_id,
        "identityScope": "listing",
        "canonicalUrl": f"https://paypayfleamarket.yahoo.co.jp/item/{item_id}",
        "title": title,
        "descriptionExcerpt": description,
        "currency": "JPY",
        "currentPrice": price,
        "priceBasis": "listing_price",
        "condition": "used",
        "availability": availability,
        "facts": facts,
        "rawMetadata": {"sourceConditionLabel": "未使用に近い"},
    }
    if source_listed_at:
        item["sourceListedAt"] = source_listed_at
    return item


PRIMARY_LISTINGS = [
    listing("z589863828", "Re:ゼロから始める異世界生活 ラインハルト ぬいぐるみ リゼロ", 7200,
            description="GSクラフト ラインハルト・ヴァン・アストレア 未開封 全長18cm N0065",
            manufacturer="GSクラフト"),
    listing("z589863829", "GSクラフト ラインハルト 18cm ぬいぐるみ", 6800,
            description="Re:ゼロ ラインハルト 座形ぬいぐるみ", manufacturer="GSクラフト"),
    listing("z600000001", "Chopinui Puchi ラインハルト GiGO限定", 2600, manufacturer="GiGO"),
    listing("z600000002", "ラインハルト・ユリウス ちびぐるみ 2点セット", 4200, manufacturer="BANDAI"),
    listing("z600000003", "Re:ゼロ ラインハルト アクリルスタンド", 1800),
    listing("z600000004", "別作品 ラインハルト風 マスコット", 900),
]


def hit(variant_id: str, query: str, lane: str, rank: int, kind: str = "manufacturer"):
    return {
        "variantId": variant_id,
        "query": query,
        "kind": kind,
        "lane": lane,
        "upstreamRank": rank,
        "weight": 0.9,
        "liveVerified": True,
    }


def evidence(relation: str, score: int, reasons: list[str], *, web: bool = False, historical: bool = False):
    hits = [hit("manufacturer-3", "ラインハルト ぬいぐるみ GSクラフト", "source_native", 1)]
    if web:
        hits.append(hit("web_site-6", "site:paypayfleamarket.yahoo.co.jp/item ラインハルト GSクラフト", "web_search", 1, "web_site"))
    if historical:
        hits.append(hit("manufacturer-3", "ラインハルト ぬいぐるみ GSクラフト", "historical_index", 2))
    return {
        "hits": hits,
        "fusedScore": round(score / 100, 4),
        "bestRank": 1,
        "historical": historical,
        "liveVerified": True,
        "match": {
            "version": "product-match-v4",
            "relation": relation,
            "score": score,
            "confidence": "high" if score >= 80 else "medium",
            "matchedFields": ["厂商", "角色"],
            "conflicts": ["排除词：GiGO"] if relation == "variant" else [],
            "reasons": reasons,
        },
    }


PRIMARY_EVIDENCE = {
    "z589863828": evidence("exact", 100, ["JAN 完全一致", "型号完全一致", "厂商匹配", "尺寸匹配"], web=True, historical=True),
    "z589863829": evidence("probable_exact", 86, ["厂商匹配", "角色匹配", "尺寸匹配"]),
    "z600000001": evidence("variant", 34, ["角色匹配", "检测到目标排除系列"]),
    "z600000002": evidence("bundle", 52, ["角色匹配", "标题表示多商品套装"]),
    "z600000003": evidence("related", 24, ["角色匹配，但品类不一致"]),
    "z600000004": evidence("irrelevant", 0, ["作品与商品身份均不一致"]),
}


def plan(payload: dict):
    query = payload["query"]
    variants = [
        {"id": "original-1", "query": query, "kind": "original", "weight": 0.55, "lane": "source_native"},
        {"id": "identifier-2", "query": payload.get("target", TARGET).get("jan", "4589955576984"), "kind": "identifier", "weight": 1, "lane": "source_native"},
        {"id": "manufacturer-3", "query": "ラインハルト ぬいぐるみ GSクラフト", "kind": "manufacturer", "weight": 0.9, "lane": "source_native"},
    ]
    if payload.get("deepSearch"):
        variants.append({
            "id": "web_site-4",
            "query": "site:paypayfleamarket.yahoo.co.jp/item ラインハルト GSクラフト",
            "kind": "web_site",
            "weight": 0.92,
            "lane": "web_search",
        })
    return {
        "version": "product-search-plan-v3",
        "intentVersion": "named-product-intent-v2",
        "intentKind": "fingerprint",
        "mode": "exact_product",
        "originalQuery": query,
        "target": payload.get("target", TARGET),
        "variants": variants,
        "deepSearch": bool(payload.get("deepSearch")),
        "warnings": ["网页补漏候选均已回到 Yahoo!フリマ详情实时核验。"] if payload.get("deepSearch") else [],
    }


def state_fixture(payload: dict):
    if payload["query"] == "price-intelligence":
        items = [
            listing("z-price-sold-1", "F:NEX限定 エミリア ぬいぐるみ", 1200,
                    manufacturer="F:NEX", availability="sold_out", source_listed_at="2025-02-03T00:00:00.000Z"),
            listing("z-price-sold-2", "F:NEX限定 エミリア ぬいぐるみ 美品", 1322,
                    manufacturer="F:NEX", availability="sold_out", source_listed_at="2025-10-12T00:00:00.000Z"),
            listing("z-price-live-1", "F:NEX限定 エミリア ぬいぐるみ 中古", 3800,
                    manufacturer="F:NEX", source_listed_at="2026-06-20T00:00:00.000Z"),
        ]
        return items, {
            item["sourceItemId"]: evidence("exact", 100, ["商品身份完全一致", "厂商匹配", "角色匹配"])
            for item in items
        }
    if payload["query"] == "sold-intelligence":
        items = [
            listing("z-sold-only-1", "F:NEX限定 エミリア ぬいぐるみ", 1200,
                    manufacturer="F:NEX", availability="sold_out", source_listed_at="2025-02-03T00:00:00.000Z"),
            listing("z-sold-only-2", "F:NEX限定 エミリア ぬいぐるみ 美品", 1322,
                    manufacturer="F:NEX", availability="sold_out", source_listed_at="2025-10-12T00:00:00.000Z"),
        ]
        return items, {
            item["sourceItemId"]: evidence("exact", 100, ["商品身份完全一致", "厂商匹配", "角色匹配"])
            for item in items
        }
    match = re.fullmatch(r"state-(0|1|10|100)", payload["query"])
    if not match:
        return PRIMARY_LISTINGS, PRIMARY_EVIDENCE
    count = int(match.group(1))
    items = [listing(f"z7{index:08d}", f"状态样本 {index + 1} GSクラフト ラインハルト 18cm", 5000 + index,
                     manufacturer="GSクラフト") for index in range(count)]
    candidate_evidence = {
        item["sourceItemId"]: evidence("probable_exact", max(80, 99 - index), ["厂商匹配", "角色匹配", "尺寸匹配"])
        for index, item in enumerate(items)
    }
    return items, candidate_evidence


search_posts: list[dict] = []
watch_posts: list[dict] = []
ai_requests: list[str] = []
search_jobs: dict[str, dict] = {}


def fulfill(route: Route, body: object, status: int = 200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body, ensure_ascii=False))


def handle_api(route: Route):
    request = route.request
    path = urlparse(request.url).path
    if path.endswith("/api/dashboard"):
        fulfill(route, {"summary": {"activeWatches": 0, "activeSources": 1, "todaySearches": 0, "todayNewListings": 0, "todayPriceDrops": 0, "todayEmails": 0, "failingSources": 0, "emailProtectionTriggered": False}, "recentEvents": []})
        return
    if path.endswith("/api/sources"):
        fulfill(route, {"items": SOURCE_STATES})
        return
    if path.endswith("/api/item-watches") and request.method == "GET":
        fulfill(route, {"items": []})
        return
    if path.endswith("/api/search/preview") and request.method == "GET":
        job_id = parse_qs(urlparse(request.url).query).get("jobId", [None])[0]
        if job_id:
            fulfill(route, search_jobs[job_id])
        else:
            fulfill(route, {"items": []})
        return
    if path.endswith("/api/search/preview") and request.method == "POST":
        payload = request.post_data_json
        search_posts.append(payload)
        assert payload["mode"] == "exact_product"
        assert payload["sources"] == ["yahoo_fleamarket_jp"]
        items, candidate_evidence = state_fixture(payload)
        group = {
            "sourceId": "yahoo_fleamarket_jp",
            "status": "success" if items else "empty",
            "listings": items,
            "candidateEvidence": candidate_evidence,
            "coverage": "rolling_window",
            "warnings": [],
            "durationMs": 240,
            "requestEvidence": {
                "availabilityMode": "all",
                "rawResultCount": len(items),
                "normalizedResultCount": len(items),
                "pagesFetched": 1,
            },
        }
        job_id = f"job-{len(search_posts)}"
        search_jobs[job_id] = {
            "jobId": job_id,
            "status": "completed",
            "groups": [group],
            "historyId": SESSION_ID,
            "sessionId": SESSION_ID,
            "searchedAt": "2026-07-17T00:00:00.000Z",
            "plan": plan(payload),
            "productIdentity": PRODUCT_IDENTITY,
        }
        fulfill(route, {"jobId": job_id, "status": "queued", "plan": plan(payload)}, 202)
        return
    if path.endswith("/api/watch-profiles") and request.method == "POST":
        watch_posts.append(request.post_data_json)
        fulfill(route, {"id": WATCH_PROFILE_ID, "pausedBindings": 0}, 201)
        return
    if "/api/ai/" in path:
        ai_requests.append(path)
        payload = request.post_data_json or {}
        item_count = len(payload.get("items", []))
        fulfill(route, {
            "jobId": "ai-cleaning-fixture",
            "status": "failed",
            "items": [None] * item_count,
            "itemStatuses": ["failed"] * item_count,
            "model": "gemini-3.5-flash-lite",
            "taskPersisted": True,
        })
        return
    route.continue_()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    page.set_default_timeout(25_000)
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
    assert page.get_by_role("button", name="保存为关注").count() == 0
    search_sources = page.get_by_role("group", name="选择搜索范围")
    assert search_sources.get_by_text("Rakuten Books", exact=True).count() == 0

    page.get_by_role("button", name="按商品名找同款").click()
    page.get_by_label("具体日文商品名", exact=True).fill("ラインハルト ぬいぐるみ")
    page.get_by_text("高级校正（通常不需要填写）", exact=True).click()
    page.get_by_label("作品", exact=True).fill(TARGET["workTitle"])
    page.get_by_label("角色（逗号分隔）").fill("、".join(TARGET["characters"]))
    page.get_by_label("商品类型").fill(TARGET["productType"])
    page.get_by_label("厂商 / 品牌").fill(TARGET["manufacturer"])
    page.get_by_label("型号 / SKU").fill(TARGET["model"])
    page.get_by_label("JAN", exact=True).fill(TARGET["jan"])
    page.get_by_label("尺寸", exact=True).fill(TARGET["size"])
    page.get_by_label("别名 / 标准标题（逗号分隔）").fill("、".join(TARGET["aliases"]))
    page.get_by_label("明确排除（逗号分隔）").fill("、".join(TARGET["excludedTerms"]))
    page.get_by_text("本次手动启用网页补漏", exact=True).click()
    page.get_by_role("button", name="开始搜索").click()

    page.get_by_text("本次同款搜索召回 6 件来源候选", exact=True).wait_for()
    assert search_posts[0]["deepSearch"] is True
    assert "rakuten_books" not in search_posts[0]["sources"]
    assert search_posts[0]["target"]["jan"] == TARGET["jan"]
    assert search_posts[0]["target"]["excludedTerms"] == TARGET["excludedTerms"]
    assert page.locator(".search-plan-evidence").count() == 0
    assert page.get_by_role("link", name="查看本次运行记录").count() == 1
    curated = page.locator(".curated-result-section .result-product-card")
    assert curated.count() == 1
    assert curated.first.get_attribute("data-match") == "exact"
    assert "z589863828" in curated.first.locator("a[href*='z589863828']").get_attribute("href")
    assert page.get_by_text("完全同款 · 100", exact=True).count() == 1
    assert page.get_by_text("历史索引 · 已复核", exact=True).count() == 1
    assert page.locator('.result-product-card[data-match="irrelevant"]').count() == 0
    assert curated.locator(".result-ai-brief").count() == 0
    assert curated.get_by_role("button", name="以此扩展同款检索").count() == 0
    curated.first.get_by_role("button", name="展开商品详情").click()
    assert "JAN 完全一致" in curated.first.locator(".product-match-evidence").inner_text()

    page.get_by_role("button", name=re.compile(r"全部分组\s*6")).click()
    assert curated.count() == 5
    assert page.get_by_text("高概率同款 · 86", exact=True).count() == 1

    page.get_by_role("button", name=re.compile(r"其他版本\s*1")).click()
    assert page.locator('.curated-result-section .result-product-card[data-match="variant"]').count() == 1
    page.get_by_role("button", name=re.compile(r"全部分组\s*6")).click()

    # Saving "current search" must use the plan that produced the visible
    # results, not unsent edits in the form above it.
    page.get_by_label("型号 / SKU").fill("UNSENT-EDIT")
    intelligence = page.locator(".product-price-intelligence")
    assert intelligence.get_by_role("button", name=re.compile("建立.*(?:监控|雷达)")).count() == 0
    create_exact_watch = page.get_by_role("button", name="建立精确同款监控", exact=True)
    assert create_exact_watch.count() == 1
    create_exact_watch.scroll_into_view_if_needed()
    page.screenshot(path=ACTION_SCREENSHOT, full_page=False)
    create_exact_watch.click()
    page.get_by_role("heading", name="建立精确同款关注档案", exact=True).wait_for()
    page.get_by_role("button", name="创建精确同款关注档案", exact=True).click()
    page.get_by_text("精确同款关注档案已建立", exact=False).wait_for()
    assert len(watch_posts) == 1
    assert watch_posts[0]["productVariantId"] == PRODUCT_IDENTITY["productVariantId"]
    assert watch_posts[0]["productIdentitySearchHistoryId"] == SESSION_ID
    assert watch_posts[0]["name"] == "ラインハルト ぬいぐるみ"
    assert "description" not in watch_posts[0]
    binding = watch_posts[0]["bindings"][0]
    assert binding["sourceConfig"]["searchMode"] == "exact_product"
    assert binding["sourceConfig"]["productTarget"]["model"] == "N0065"
    assert binding["sourceConfig"]["deepSearch"] is False
    assert page.get_by_role("link", name="打开关注档案", exact=True).get_attribute("href") == f"/watches/{WATCH_PROFILE_ID}"

    result_scope = page.get_by_role("combobox", name="00 查看范围 Result scope")
    result_scope.click()
    page.locator(".editorial-select-option").filter(has_text="完整人工检索池").click()
    manual_pool = page.locator(".manual-pool-section")
    manual_pool.get_by_role("heading", name="完整人工检索池", exact=True).wait_for()
    assert manual_pool.locator(".result-product-card").count() == 6
    assert manual_pool.get_by_role("button", name="以此扩展同款检索").count() == 0
    condition_filter = page.get_by_role("combobox", name="03 品相 Condition")
    condition_filter.click()
    page.locator(".editorial-select-option").filter(has_text="新品").click()
    manual_pool.get_by_text("当前筛选在人工检索池中没有商品", exact=True).wait_for()
    assert manual_pool.locator(".result-product-card").count() == 0
    page.get_by_role("button", name="清除筛选", exact=True).click()
    assert manual_pool.locator(".result-product-card").count() == 6

    page.get_by_label("具体日文商品名", exact=True).fill("price-intelligence")
    page.get_by_role("button", name="开始搜索").click()
    page.get_by_text("本次同款搜索召回 3 件来源候选", exact=True).wait_for()
    intelligence = page.locator(".product-price-intelligence")
    intelligence.get_by_text("2 件", exact=True).wait_for()
    assert "1,261" in intelligence.get_by_text(re.compile(r"1,261")).first.inner_text()
    assert "3,800" in intelligence.get_by_text(re.compile(r"3,800")).first.inner_text()
    assert intelligence.get_by_text("+201%", exact=True).count() == 1
    assert intelligence.get_by_text("当前报价明显偏高，非急需可继续等", exact=True).count() == 1
    assert page.locator(".curated-result-section .terminal-listing-note").count() == 2
    assert page.locator(".curated-result-section .watch-item-button").count() == 1
    intelligence.scroll_into_view_if_needed()
    page.screenshot(path=PRICE_SCREENSHOT, full_page=False)

    page.get_by_label("具体日文商品名", exact=True).fill("sold-intelligence")
    page.get_by_role("button", name="开始搜索").click()
    page.get_by_text("本次同款搜索召回 2 件来源候选", exact=True).wait_for()
    intelligence = page.locator(".product-price-intelligence")
    assert intelligence.get_by_text("暂无有效报价", exact=True).count() == 1
    assert intelligence.get_by_text("不适用", exact=True).count() == 1
    assert intelligence.get_by_text("暂无可买同款，等待新上架", exact=True).count() == 1
    assert page.locator(".curated-result-section .terminal-listing-note").count() == 2
    assert page.locator(".curated-result-section .watch-item-button").count() == 0
    assert page.locator(".curated-result-section").get_by_role("button", name="以此扩展同款检索").count() == 0
    page.set_viewport_size({"width": 390, "height": 844})
    intelligence.scroll_into_view_if_needed()
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")
    page.screenshot(path=SOLD_MOBILE_SCREENSHOT, full_page=False)
    page.set_viewport_size({"width": 1440, "height": 1000})

    for count in (0, 1, 10, 100):
        page.get_by_label("具体日文商品名", exact=True).fill(f"state-{count}")
        page.get_by_role("button", name="开始搜索").click()
        page.get_by_text(f"本次同款搜索召回 {count} 件来源候选", exact=True).wait_for()
        if count:
            page.get_by_role("button", name=re.compile(rf"全部分组\s*{count}")).click()
        expected_cards = min(count, 12)
        assert page.locator(".curated-result-section .result-product-card").count() == expected_cards
        assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")

    page.set_viewport_size({"width": 390, "height": 844})
    page.locator(".search-results").scroll_into_view_if_needed()
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")
    page.screenshot(path=SCREENSHOT, full_page=False)
    assert not ai_requests, "deterministic price intelligence must not trigger client-side AI inference"
    runtime_errors = [error for error in errors if "/_next/webpack-hmr" not in error]
    assert not runtime_errors, " | ".join(runtime_errors)
    browser.close()

print(
    "search_exact_product_ok states=0,1,10,100 "
    f"screenshots={SCREENSHOT},{ACTION_SCREENSHOT},{PRICE_SCREENSHOT},{SOLD_MOBILE_SCREENSHOT}"
)
