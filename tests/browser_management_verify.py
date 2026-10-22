import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "dev-only-change-me-1234567890")
ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
TEST_NAME = f"Playwright 本地验收 {os.getpid()}"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.set_default_timeout(12_000)
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: console_errors.append(str(error)))

    page.goto(f"{BASE_URL}/login", wait_until="networkidle")
    page.get_by_label("管理员密码").fill(PASSWORD)
    page.get_by_role("button", name="进入系统").click()
    page.wait_for_url(f"{BASE_URL}/dashboard")

    page.goto(f"{BASE_URL}/sources", wait_until="networkidle")
    assert "邮件通道" in page.locator("body").inner_text()
    assert "alerts@example.com" in page.locator("body").inner_text()
    source_card = page.locator("article.stack-card").filter(has_text="Rakuten Ichiba").first
    assert source_card.get_by_role("button", name="测试连接").is_visible()

    page.goto(f"{BASE_URL}/watches", wait_until="networkidle")
    page.get_by_label("主题名称").fill(TEST_NAME)
    page.get_by_label("日文检索词").fill("千反田える テスト")
    page.get_by_role("button", name="保存订阅").click()
    page.wait_for_timeout(700)
    assert "来源会在凭据就绪并启用后开始运行" in page.locator("body").inner_text()
    watch_card = page.locator("article.stack-card").filter(has_text=TEST_NAME)
    watch_card.get_by_role("link", name=TEST_NAME).click()
    page.wait_for_url(f"{BASE_URL}/watches/**")
    page.get_by_text("千反田える テスト").wait_for()
    detail_text = page.locator("body").inner_text()
    if "千反田える テスト" not in detail_text:
        print(detail_text, flush=True)
        print(console_errors, flush=True)
    assert "千反田える テスト" in detail_text
    page.screenshot(path=ARTIFACTS / "watch-detail-desktop.png", full_page=True)

    page.goto(f"{BASE_URL}/watches", wait_until="networkidle")
    watch_card = page.locator("article.stack-card").filter(has_text=TEST_NAME)
    page.once("dialog", lambda dialog: dialog.accept())
    watch_card.get_by_role("button", name="删除").click()
    page.wait_for_timeout(700)
    assert page.locator("article.stack-card").filter(has_text=TEST_NAME).count() == 0

    item_name = f"Playwright 单品监控 {os.getpid()}"
    item_result = page.evaluate("""async ([name]) => {
      const response = await fetch('/api/item-watches', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, source: 'rakuten_ichiba', sourceItemId: 'testshop:123', targetUrl: 'https://item.rakuten.co.jp/testshop/123/', minDropAmount: 100})
      });
      return {status: response.status, body: await response.json()};
    }""", [item_name])
    assert item_result["status"] == 201
    assert item_result["body"]["paused"] is True
    page.reload(wait_until="networkidle")
    item_card = page.locator("article.stack-card").filter(has_text=item_name)
    assert item_card.count() == 1
    page.once("dialog", lambda dialog: dialog.accept())
    item_card.get_by_role("button", name="删除").click()
    page.wait_for_timeout(700)

    page.goto(f"{BASE_URL}/events", wait_until="networkidle")
    assert page.get_by_role("combobox").count() == 2
    page.goto(f"{BASE_URL}/listings", wait_until="networkidle")
    assert "商品档案" in page.locator("body").inner_text()

    assert console_errors == [], console_errors
    browser.close()

print("MANAGEMENT_VERIFY_OK resend sources watch-crud details events listings console=0", flush=True)
