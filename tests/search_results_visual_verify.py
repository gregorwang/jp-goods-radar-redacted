import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import Route, sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
DEV_PASSWORD = os.environ.get("ADMIN_PASSWORD", "dev-only-change-me-1234567890")
SESSION_TOKEN = os.environ.get("SESSION_TOKEN")
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "jpgr_session")
ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", Path(__file__).parent / "artifacts"))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
LIVE_AI = os.environ.get("LIVE_AI") == "1"


def listing(source: str, item_id: str, title: str, price: int | None, **overrides):
    catalog_sources = {"rakuten_books", "charaon", "cospa", "animate"}
    new_sources = {"rakuten_ichiba", "rakuten_books", "charaon", "cospa", "animate"}
    value = {
        "sourceId": source,
        "sourceItemId": item_id,
        "identityScope": "catalog" if source in catalog_sources else "listing",
        "canonicalUrl": {
            "rakuten_ichiba": f"https://item.rakuten.co.jp/test/{item_id}/",
            "rakuten_books": f"https://books.rakuten.co.jp/rb/{item_id}/",
            "mercari_jp": f"https://jp.mercari.com/item/{item_id}",
            "surugaya": f"https://www.suruga-ya.jp/product/detail/{item_id}",
            "charaon": f"https://www.charaon.jp/SHOP/{item_id}.html",
            "cospa": f"https://www.cospa.com/cospa/detail/id/{item_id}",
            "animate": f"https://www.animate-onlineshop.jp/pn/_/pd/{item_id}/",
        }[source],
        "title": title,
        "imageUrl": "/art/radar-title-placeholder.png" if int(item_id[-1], 36) % 2 else "/art/radar-shadow.png",
        "currency": "JPY",
        "currentPrice": price,
        "priceBasis": "catalog_price" if source in catalog_sources else "listing_price",
        "condition": "new" if source in new_sources else "used",
        "availability": "available",
        "sourceListedAt": "2026-07-11T08:20:00.000Z",
        "sourceUpdatedAt": "2026-07-12T09:30:00.000Z",
        "rawMetadata": {},
    }
    value.update(overrides)
    return value


SAME_TITLE = "Re:ゼロから始める異世界生活 Vol.3 Blu-ray 初回限定版"
LISTINGS = [
    listing("rakuten_ichiba", "offer1", SAME_TITLE, 7800, shopName="映像専門店", descriptionExcerpt="初回限定版。全巻収納BOX付き。", rawMetadata={"sourceConditionLabel": "新品", "pointRate": 3}),
    listing("mercari_jp", "m00000001", "Ｒｅ：ゼロから始める異世界生活 Ｖｏｌ．３ Ｂｌｕ－ｒａｙ 初回限定版", 5200, sellerName="コレクション整理", descriptionExcerpt="ディスク再生確認済み。外箱角に小傷あり。帯なし。", rawMetadata={"sourceConditionId": "4", "sourceConditionLabel": "やや傷や汚れあり"}),
    listing("surugaya", "900000001", SAME_TITLE, 6100, rawMetadata={"sourceConditionLabel": "中古", "category": "Blu-ray", "marketplacePrice": 6480}),
    listing("rakuten_books", "9784041064839", "氷菓 Blu-ray BOX", 16800, shopName="Rakuten Books", sourceListedAt="2026-03-01", rawMetadata={"sourceConditionLabel": "新品", "author": "京都アニメーション", "publisherName": "KADOKAWA", "identifiers": {"isbn": "9784041064839"}}),
    listing("mercari_jp", "m00000002", "エミリア 1/7 スケールフィギュア", 4300, sellerName="figure room", descriptionExcerpt="開封済み。台座あり。右袖に色移りがあります。", rawMetadata={"sourceConditionId": "5", "sourceConditionLabel": "傷や汚れあり"}),
    listing("surugaya", "900000002", "レム アクリルスタンド", None, rawMetadata={"sourceConditionLabel": "中古", "category": "雑貨", "marketplacePrice": 2100}),
    listing("rakuten_ichiba", "offer2", "Re:ゼロ エミリア B2タペストリー", 3200, shopName="キャラクター雑貨店", rawMetadata={"sourceConditionLabel": "新品", "pointRate": 1}),
    listing("mercari_jp", "m00000003", "Re:ゼロ 小説 1-10巻セット", 3600, sellerName="本棚整理", descriptionExcerpt="経年ヤケあり。書き込みなし。5巻の帯のみ欠品。", availability="sold_out", rawMetadata={"sourceConditionId": "4", "sourceConditionLabel": "やや傷や汚れあり", "sourceStatus": "ITEM_STATUS_TRADING"}),
    listing("rakuten_books", "4900000000001", "Re:ゼロ Memory Snow DVD", 4800, shopName="Rakuten Books", sourceListedAt="2025-12-18", rawMetadata={"sourceConditionLabel": "新品", "identifiers": {"jan": "4900000000001"}}),
    listing("surugaya", "900000003", "Re:ゼロから始める異世界生活 Vol.5 Blu-ray", 1000, availability="sold_out", rawMetadata={"sourceConditionLabel": "中古", "category": "Blu-ray", "marketplacePrice": 2600}),
    listing("charaon", "AZBSD154", "文豪ストレイドッグス 缶バッジ", 440,
            descriptionExcerpt="発売日 2026年7月31日。サイズ：約φ56mm。発売元：アズメーカー。",
            facts={
                "identifiers": {"jan": "4580805211413", "sku": "AZBSD154", "sourceCatalogId": "AZBSD154"},
                "brand": "CharaON", "manufacturer": "アズメーカー", "workTitle": "文豪ストレイドッグス",
                "releaseDate": "2026-07-31", "preorderDeadline": "2026-07-20",
                "imageUrls": ["https://image1.shopserve.jp/charaon.jp/pic-labo/llimg/AZBSD154_01.jpg", "https://image1.shopserve.jp/charaon.jp/pic-labo/llimg/AZBSD154_02.jpg"],
                "specifications": [{"name": "尺寸", "value": "约 φ56mm"}, {"name": "材质", "value": "钢合金、PET"}],
                "sourceAvailabilityLabel": "在庫 ○", "sourceConditionLabel": "新品",
            }),
]

ACTIVE_SOURCES = ["rakuten_ichiba", "rakuten_books", "mercari_jp", "surugaya", "charaon"]
ALL_SOURCES = ["rakuten_ichiba", "rakuten_books", "mercari_jp", "surugaya", "charaon", "cospa", "animate", "yahoo_shopping", "amazon_jp", "ebay"]


def grouped_listings():
    groups = [{
        "sourceId": source,
        "status": "success",
        "listings": [item for item in LISTINGS if item["sourceId"] == source],
        "coverage": "rolling_window",
        "warnings": ["视觉回归 fixture：仅验证布局，不写入生产数据库"],
    } for source in ACTIVE_SOURCES]
    surugaya = next(group for group in groups if group["sourceId"] == "surugaya")
    surugaya["requestRoute"] = "managed_api"
    surugaya["routeOutcome"] = {
        "kind": "fallback_success",
        "primaryRoute": "mercari_service",
        "fallbackRoute": "managed_api",
        "provider": "parse",
        "cacheStatus": "hit",
        "searchQuery": "Re:ゼロ",
        "queryNarrowed": False,
        "primaryFailure": {
            "code": "surugaya_service_platform_invalid_response",
            "status": 502,
            "retryable": True,
            "message": "东京主路径两次有界尝试失败",
            "attempts": [],
        },
    }
    return groups


HISTORY = {
    "id": "0f1e2d3c-4b5a-4678-9123-abcdefabcdef",
    "query": "Re:ゼロ",
    "sources": ACTIVE_SOURCES,
    "filters": {"minPrice": None, "maxPrice": 20000, "conditions": ["new", "used"], "inStockOnly": False},
    "status": "success",
    "resultCount": len(LISTINGS),
    "sourceSummary": [{
        "sourceId": source,
        "status": "success",
        "resultCount": len([item for item in LISTINGS if item["sourceId"] == source]),
        "error": None,
    } for source in ACTIVE_SOURCES],
    "searchedAt": "2026-07-12T09:40:00.000Z",
    "hasSnapshot": True,
}

HISTORY_ITEMS = [HISTORY, *[
    {
        **HISTORY,
        "id": f"00000000-0000-4000-8000-{index:012x}",
        "searchedAt": f"2026-07-{12 - index:02d}T09:40:00.000Z",
    }
    for index in range(1, 10)
]]

TRANSLATED_TITLES = {
    SAME_TITLE: "《Re：从零开始的异世界生活》Vol.3 Blu-ray 初回限定版",
    "Ｒｅ：ゼロから始める異世界生活 Ｖｏｌ．３ Ｂｌｕ－ｒａｙ 初回限定版": "《Re：从零开始的异世界生活》Vol.3 Blu-ray 初回限定版",
    "氷菓 Blu-ray BOX": "《冰菓》Blu-ray BOX",
    "エミリア 1/7 スケールフィギュア": "爱蜜莉雅 1/7 比例手办",
    "レム アクリルスタンド": "蕾姆亚克力立牌",
    "Re:ゼロ エミリア B2タペストリー": "《Re：从零开始》爱蜜莉雅 B2 挂画",
    "Re:ゼロ 小説 1-10巻セット": "《Re：从零开始》小说第 1—10 卷套装",
    "Re:ゼロ Memory Snow DVD": "《Re：从零开始》Memory Snow DVD",
    "Re:ゼロから始める異世界生活 Vol.5 Blu-ray": "《Re：从零开始的异世界生活》Vol.5 Blu-ray",
}

search_posts: list[dict] = []
ai_enrichment_posts: list[list[dict]] = []
ai_request_order: list[str] = []
item_watch_posts: list[dict] = []


def fulfill_json(route: Route, body: object, status: int = 200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body, ensure_ascii=False))


def handle_api(route: Route):
    request = route.request
    parsed_url = urlparse(request.url)
    if parsed_url.path.endswith("/api/dashboard"):
        fulfill_json(route, {"summary": {
            "activeWatches": 0,
            "activeSources": len(ACTIVE_SOURCES),
            "todaySearches": 1,
            "todayNewListings": 0,
            "todayPriceDrops": 0,
            "todayEmails": 0,
            "failingSources": 0,
            "emailProtectionTriggered": False,
        }, "recentEvents": []})
        return
    if parsed_url.path.endswith("/api/sources"):
        transports = {
            "rakuten_ichiba": "official_api", "rakuten_books": "official_api", "mercari_jp": "internal_api",
            "surugaya": "html_endpoint", "charaon": "html_endpoint", "cospa": "html_endpoint",
            "animate": "html_endpoint", "yahoo_shopping": "official_api", "amazon_jp": "manual", "ebay": "manual",
        }
        items = [{
            "id": source,
            "display_name": source,
            "transport": transports[source],
            "official_api": 1 if transports[source] == "official_api" else 0,
            "enabled": 1 if source in ACTIVE_SOURCES else 0,
            "adapter_available": True,
            "health_status": "healthy" if source in ACTIVE_SOURCES else "disabled",
            "monitoring_allowed": source in ACTIVE_SOURCES,
            "credential_status": "ready" if source.startswith("rakuten") else "not_required",
            "request_route": "mercari_service" if source in {"mercari_jp", "surugaya", "charaon", "cospa", "animate"} else "direct",
            "parser_version": "fixture-v1", "last_success_at": "2026-07-12T09:40:00.000Z",
            "consecutive_failures": 0, "cooldown_until": None, "last_http_status": 200,
            "last_error_message": None, "last_signature_success_at": "2026-07-12T09:40:00.000Z",
            "schema_version": "fixture-v1", "last_403_at": None, "last_429_at": None,
            "last_container_count": None, "last_page_bytes": None, "captcha_detected": 0,
            "probe_status": "pending", "probe_started_at": None, "probe_planned_end_at": None,
            "probe_total_runs": 0, "probe_successful_runs": 0, "probe_field_total": 0,
            "probe_field_complete": 0, "probe_captcha_runs": 0, "probe_cpu_limit_runs": 0,
            "probe_login_required_runs": 0, "probe_decision_reason": None, "probe_request_route": "direct",
        } for source in ALL_SOURCES]
        fulfill_json(route, {
            "items": items,
            "resend": {"configured": True},
            "rakuten": {"affiliateMode": False, "privateMonitoringEnabled": False, "publicPreviewEnabled": True},
            "mercari": {"independentServiceConfigured": True, "requestRoute": "mercari_service"},
            "surugaya": {"independentServiceConfigured": True, "requestRoute": "mercari_service"},
            "yahooAuctions": {"experimentalEnabled": False},
            "yahooFleamarket": {"cloudflareDirectEnabled": True, "browserRunFallbackConfigured": False},
            "browserRun": {"configured": False},
            "amazon": {"configured": True, "monitoringEnabled": True, "cloudflareDirectEnabled": True, "browserRunFallbackConfigured": True, "requestRoute": "direct"},
            "sourceService": {"configured": True, "requestRoute": "mercari_service", "sources": ["charaon", "cospa", "animate"]},
            "managedApi": {"provider": "parse", "totalMonthlyLimit": 200, "mcpAndBuildBudget": 140,
                           "runtimeBudget": 40, "runtimeCalls": 0, "emergencyReserve": 20, "ledgerAvailable": True},
            "verification": [], "completion": None, "qualification": None,
            "healthObservations": [], "probeHistory": [],
        })
        return
    if parsed_url.path.endswith("/api/watch-profiles") and request.method == "GET":
        fulfill_json(route, {"items": [{
            "id": "legacy-exact-watch",
            "name": "同款 · 初音ミク レーシングVer. ミニ色紙 Tony 浴衣Ver.",
            "description": "具体日文商品名：初音ミク レーシングVer. ミニ色紙 Tony 浴衣Ver.",
            "enabled": 1,
            "binding_count": 2,
            "active_binding_count": 2,
            "next_run_at": "2026-07-22T15:00:00.000Z",
            "last_success_at": "2026-07-22T14:00:00.000Z",
            "failing_binding_count": 0,
            "monitoring_purposes": "keyword_new_listing",
            "dossier_kind": "exact_product",
        }]})
        return
    if parsed_url.path.endswith("/api/search/preview") and request.method == "GET":
        if parse_qs(parsed_url.query).get("historyId"):
            fulfill_json(route, {"history": HISTORY, "groups": grouped_listings()})
        else:
            fulfill_json(route, {"items": HISTORY_ITEMS})
        return
    if parsed_url.path.endswith("/api/search/preview") and request.method == "POST":
        search_posts.append(request.post_data_json)
        fulfill_json(route, {"groups": grouped_listings(), "historyId": HISTORY["id"], "sessionId": HISTORY["id"]})
        return
    if parsed_url.path.endswith("/api/search/item-preview"):
        requested = request.post_data_json
        source_item_id = requested["sourceItemId"]
        item = next(value for value in LISTINGS if value["sourceItemId"] == source_item_id)
        detail = {**item, "descriptionExcerpt": item.get("descriptionExcerpt", "来源详情没有额外说明。")}
        fulfill_json(route, {"listing": detail})
        return
    if parsed_url.path.endswith("/api/ai/search-overview"):
        if LIVE_AI:
            route.continue_()
            return
        ai_request_order.append("overview")
        fulfill_json(route, {
            "overview": {
                "summary": "本次 11 件商品来自 5 个来源，包含 10 件在售商品和 1 件已成交或缺货参考。",
                "highlights": ["可见标价为 1,000 至 16,800 日元", "共有 1 组可安全合并的同款"],
            },
            "model": "gemini-3.5-flash-lite",
            "providerCalled": True,
        })
        return
    if parsed_url.path.endswith("/api/ai/listing-enrichment"):
        if LIVE_AI:
            route.continue_()
            return
        ai_request_order.append("listing")
        requested_items = request.post_data_json["items"]
        ai_enrichment_posts.append(requested_items)
        enriched_items = []
        for index, item in enumerate(requested_items):
            source_condition = item.get("sourceConditionLabel")
            evidence = [{"field": "title", "quote": item["title"]}]
            condition_notes = []
            if source_condition:
                evidence.append({"field": "sourceCondition", "quote": source_condition})
                condition_notes = ["中古品相，以来源标注为准"] if source_condition == "中古" else ["有轻微划痕或污渍"]
            enriched_items.append({
                "index": index,
                "relevance": "relevant",
                "relevanceReason": "与当前搜索词相关",
                "translatedTitle": TRANSLATED_TITLES.get(item["title"], "中文商品标题"),
                "summary": "已从标题与来源品相中提取可核实的商品信息。",
                "normalizedCategory": "角色周边",
                "productType": "收藏品",
                "workTitle": "Re:ゼロから始める異世界生活",
                "series": None,
                "characters": [],
                "officialStatus": "unknown",
                "normalizedCondition": item.get("condition", "unknown"),
                "conditionNotes": condition_notes,
                "defects": [],
                "missingParts": [],
                "includedItems": [],
                "editionOrModel": None,
                "extraInfo": {},
                "evidence": evidence,
                "confidence": "high",
            })
        fulfill_json(route, {
            "jobId": f"visual-job-{len(ai_enrichment_posts)}",
            "status": "completed",
            "items": enriched_items,
            "itemStatuses": ["completed" for _ in enriched_items],
            "completedItems": len(enriched_items),
            "failedItems": 0,
            "totalItems": len(enriched_items),
            "model": "gemini-3.5-flash-lite",
            "taskPersisted": True,
        })
        return
    if parsed_url.path.endswith("/api/item-watches") and request.method == "POST":
        item_watch_posts.append(request.post_data_json)
        fulfill_json(route, {"profileId": "watch-profile-1", "bindingId": "watch-binding-1", "paused": False}, 201)
        return
    route.continue_()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    page.set_default_timeout(15_000)
    console_errors: list[str] = []
    live_ai_models: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: console_errors.append(str(error)))

    def record_ai_model(response):
        if LIVE_AI and (response.url.endswith("/api/ai/listing-enrichment") or response.url.endswith("/api/ai/search-overview")) and response.ok:
            payload = response.json()
            if isinstance(payload, dict) and isinstance(payload.get("model"), str):
                live_ai_models.append(payload["model"])

    page.on("response", record_ai_model)
    page.route("**/api/**", handle_api)

    if SESSION_TOKEN:
        context.add_cookies([{"name": SESSION_COOKIE_NAME, "value": SESSION_TOKEN, "url": BASE_URL}])
        page.goto(f"{BASE_URL}/dashboard", wait_until="networkidle")
    else:
        page.goto(f"{BASE_URL}/login", wait_until="networkidle")
        page.get_by_label("管理员密码").fill(DEV_PASSWORD)
        page.get_by_role("button", name="进入系统").click()
        page.wait_for_url(f"{BASE_URL}/dashboard")
    page.get_by_text("今日检索", exact=True).wait_for()
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")

    page.goto(f"{BASE_URL}/watches", wait_until="networkidle")
    dossier = page.locator(".dossier-card").filter(has_text="初音ミク レーシングVer. ミニ色紙 Tony 浴衣Ver.")
    dossier.wait_for()
    assert dossier.locator("h3").inner_text().replace("\n", " ") == "同款 · 初音ミク レーシングVer. ミニ色紙 Tony 浴衣Ver."
    assert "具体日文商品名" not in dossier.inner_text()
    assert dossier.get_by_text("初音ミク レーシングVer. ミニ色紙 Tony 浴衣Ver.", exact=True).count() == 1
    assert dossier.locator(".dossier-title-kind").evaluate("element => getComputedStyle(element).color") != dossier.locator("h3 > span:last-child").evaluate("element => getComputedStyle(element).color")
    assert page.locator(".composer-mode-orbit").count() == 0
    assert page.locator("#composer-panel-exact-product").get_by_text("Rakuten Books", exact=True).count() == 0
    assert page.locator(".rail-brand-copy").inner_text().strip() == "格银西里尔"
    assert float(page.locator(".rail-brand-copy strong").evaluate("element => getComputedStyle(element).fontSize.replace('px', '')")) >= 18
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")
    page.screenshot(path=ARTIFACTS / "watch-semantics-desktop.png", full_page=False)

    page.goto(f"{BASE_URL}/sources", wait_until="networkidle")
    page.locator(".source-card").first.wait_for()
    assert page.locator(".source-card").count() == len(ALL_SOURCES)
    assert "运行兜底剩余 40/40" in page.locator(".policy-grid").inner_text()
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")

    page.goto(f"{BASE_URL}/search", wait_until="networkidle")
    assert page.locator(".history-card").count() == 0
    assert page.get_by_role("link", name="02 搜索记录").count() == 1
    assert page.locator(".source-option .rakuten-credit").count() == 1
    assert page.get_by_role("group", name="选择搜索范围").get_by_text("Rakuten Books", exact=True).count() == 0
    assert page.locator(".search-studio > .rakuten-credit").count() == 0
    assert page.locator(".search-studio").evaluate("element => element.scrollWidth <= element.clientWidth")
    assert page.locator(".search-results").evaluate("element => element.scrollWidth <= element.clientWidth")
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")

    page.goto(f"{BASE_URL}/search/history", wait_until="networkidle")
    page.locator(".search-history-row").first.wait_for()
    assert page.locator(".search-history-row").count() == len(HISTORY_ITEMS)
    assert page.locator(".history-card").count() == 0
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")

    page.goto(f"{BASE_URL}/search", wait_until="networkidle")
    page.get_by_role("button", name="宽泛关键词").click()
    page.get_by_label("想找什么？").wait_for()
    page.get_by_label("想找什么？").fill("rezero")
    page.get_by_role("button", name="开始搜索").click()
    page.locator(".result-product-card").first.wait_for()
    page.locator('[data-ai-status="ready"]').wait_for()

    assert page.locator(".result-product-card").count() == len(LISTINGS)
    surugaya_status = page.locator(".source-result-strip .status-pill").filter(has_text="骏河屋")
    assert "3 件 · 兜底" in surugaya_status.inner_text()
    assert "warn" in (surugaya_status.get_attribute("class") or "")
    assert "已售出" in page.locator('.result-product-card[data-availability="sold_out"]').inner_text()
    assert "交易中" in page.locator(".result-product-card").filter(has_text="小説 1-10巻セット").inner_text()
    assert page.locator(".result-price-block strong").count() == len(LISTINGS)
    price_texts = page.locator(".result-price-block strong").all_inner_texts()
    assert "价格待确认" in price_texts, price_texts
    assert all(text == "价格待确认" or any(character.isdigit() for character in text) for text in price_texts)
    assert page.get_by_text("爱蜜莉雅 1/7 比例手办", exact=True).count() == 1
    assert "やや傷や汚れあり" not in " ".join(page.locator(".result-product-kicker").all_inner_texts())
    assert "コレクション整理" not in page.locator(".result-product-card").filter(has_text="Mercari").first.inner_text()
    assert page.get_by_role("button", name="建立关键词雷达").count() == 1
    assert page.locator(".result-filter-grid select").count() == 0
    assert page.locator(".result-filter-grid .editorial-select-trigger").count() == 5
    assert page.get_by_role("combobox", name="00 查看范围 Result scope").count() == 1
    assert "当前＋历史参考" in page.get_by_role("combobox", name="00 请求范围 Request mode").inner_text()
    assert page.get_by_role("combobox", name="01 来源 Source").count() == 1
    assert page.get_by_role("combobox", name="02 本次结果状态 Returned results").count() == 1
    assert page.get_by_text("可切换到“完整人工检索池”逐件核对", exact=False).count() == 1
    assert ai_request_order[0] == "listing"
    assert page.locator(".result-workbench").evaluate("element => element.scrollWidth <= element.clientWidth")
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")

    first_card = page.locator(".result-product-card").first
    first_price = first_card.locator(".result-price-block")
    first_card_box = first_card.bounding_box()
    first_price_box = first_price.bounding_box()
    assert first_card_box is not None and first_price_box is not None
    assert first_card_box["height"] < 360
    assert first_price_box["x"] + first_price_box["width"] <= first_card_box["x"] + first_card_box["width"]
    assert float(first_price.locator("strong").evaluate("element => getComputedStyle(element).fontSize.replace('px', '')")) >= 42
    assert first_price.locator("strong").evaluate("element => getComputedStyle(element).textShadow") != "none"
    assert first_card.locator(".result-card-controls .result-actions").count() == 1
    assert first_card.locator(".result-ai-brief").count() == 0
    first_card.get_by_role("button", name="展开商品详情").click()
    first_card.locator(".result-ai-brief .result-ai-brief-body").wait_for()
    assert first_card.locator(".result-product-main > .result-facts").count() == 0
    assert page.locator(".result-product-footer").count() == 0
    assert page.locator(".result-original-title").count() > 0
    assert page.locator(".result-original-title[open]").count() == 0
    assert page.get_by_text("查看日文原标题", exact=True).count() > 0

    posts_before_restore = len(search_posts)
    page.goto(f"{BASE_URL}/search?historyId={HISTORY['id']}", wait_until="networkidle")
    page.get_by_text("没有重新访问来源", exact=False).wait_for()
    assert len(search_posts) == posts_before_restore
    assert page.locator(".history-card").count() == 0

    availability_filter = page.get_by_role("combobox", name="02 本次结果状态 Returned results")
    availability_filter.click()
    page.locator(".editorial-select-option").filter(has_text="已售出").click()
    page.locator(".result-product-card").filter(has_text="来源已售状态 / 最后公开标价").wait_for()
    assert page.locator(".result-product-card").count() == 1
    assert "来源已售状态 / 最后公开标价" in page.locator(".result-product-card").inner_text()
    availability_filter.click()
    page.locator(".editorial-select-option").filter(has_text="交易中").click()
    page.locator(".result-product-card").filter(has_text="来源交易中 / 当前公开标价").wait_for()
    assert page.locator(".result-product-card").count() == 1
    availability_filter.click()
    page.locator(".editorial-select-option").filter(has_text="全部状态").click()

    result_scope = page.get_by_role("combobox", name="00 查看范围 Result scope")
    result_scope.click()
    page.locator(".editorial-select-option").filter(has_text="完整人工检索池").click()
    manual_pool = page.locator(".manual-pool-section")
    manual_pool.get_by_role("heading", name="完整人工检索池", exact=True).wait_for()
    assert manual_pool.locator(".result-product-card").count() == len(LISTINGS)
    availability_filter.click()
    page.locator(".editorial-select-option").filter(has_text="已售出").click()
    assert manual_pool.locator(".result-product-card").count() == 1
    availability_filter.click()
    page.locator(".editorial-select-option").filter(has_text="全部状态").click()
    result_scope.click()
    page.locator(".editorial-select-option").filter(has_text="整理后结果").click()

    compare_button = page.locator(".result-view-switch button").filter(has_text="同款比价")
    assert compare_button.count() == 1
    compare_button.click()
    page.locator(".comparison-group").first.wait_for()
    assert page.locator(".comparison-group").count() == 1

    mercari_offer = page.locator(".comparison-group .result-product-card").filter(has_text="Mercari")
    assert mercari_offer.count() == 1
    assert mercari_offer.get_by_role("button", name="卡内详情").count() == 0
    mercari_offer.get_by_role("button", name="展开商品详情").click()
    mercari_offer.locator(".result-ai-brief").wait_for()
    assert "不做购买判断" in mercari_offer.locator(".result-ai-brief").inner_text()
    assert mercari_offer.locator(".semantic-result").count() == 1
    mercari_offer.get_by_role("button", name="监控此商品降价").click()
    mercari_offer.get_by_role("button", name="正在监控").wait_for()
    assert len(item_watch_posts) == 1
    assert "targetPrice" not in item_watch_posts[0]

    all_button = page.locator(".result-view-switch button").filter(has_text="商品清单")
    all_button.click()
    charaon_card = page.locator(".result-product-card").filter(has_text="CharaON")
    assert charaon_card.count() == 1
    charaon_card.get_by_role("button", name="展开商品详情").click()
    charaon_card.locator(".result-ai-brief").wait_for()
    more_charaon_facts = charaon_card.locator(".result-more-facts")
    if more_charaon_facts.count() == 1:
        more_charaon_facts.locator("summary").click()
    charaon_text = charaon_card.inner_text()
    assert "4580805211413" in charaon_text
    assert "アズメーカー" in charaon_text
    assert "文豪ストレイドッグス" in charaon_text
    assert "φ56mm" in charaon_text
    assert "钢合金、PET" in charaon_text
    assert charaon_card.get_by_role("button", name="卡内详情").count() == 0
    assert page.locator(".result-workbench").evaluate("element => element.scrollWidth <= element.clientWidth")
    page.screenshot(path=ARTIFACTS / "search-rich-desktop.png", full_page=True)

    page.emulate_media(reduced_motion="reduce")
    page.set_viewport_size({"width": 390, "height": 844})
    assert all_button.count() == 1
    all_button.click()
    page.locator(".result-product-card").first.scroll_into_view_if_needed()
    assert page.locator("html").evaluate("element => element.scrollWidth <= window.innerWidth")
    page.screenshot(path=ARTIFACTS / "search-rich-mobile.png", full_page=False)

    runtime_errors = [error for error in console_errors if "/_next/webpack-hmr" not in error]
    if runtime_errors:
        raise AssertionError("Browser console errors: " + " | ".join(runtime_errors))
    browser.close()

print("SEARCH_RESULTS_VISUAL_VERIFY_OK desktop mobile compare editorial-filters watch-semantics reduced-motion console=0", flush=True)
