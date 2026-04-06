from pathlib import Path
import re
import json
from datetime import datetime

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


# Scraper behavior:
# 1. Open the target Facebook group with a saved Firefox profile.
# 2. Verify Facebook did not redirect away from the group page.
# 3. Inspect visible feed posts one by one near the bottom of the feed.
# 4. Expand only the main post's top-level "See more" when present.
# 5. Extract and save only clean post records with:
#    post_id, author, post_text, post_url, scraped_at.
# 6. Skip duplicates already present in the JSON output file.
# 7. Save the JSON file immediately after every new post found.
# 8. Scroll deeper into the feed and repeat until several passes find no new posts.
# 9. Prefer clean post text over broad capture, even if that means skipping some posts.

GROUP_URL = "https://www.facebook.com/groups/352579246373154"
GROUP_URL_PREFIX = "https://www.facebook.com/groups/352579246373154"
PROFILE_DIR = Path("playwright_facebook_profile").resolve()
OUTPUT_JSON = Path("facebook_group_posts.json").resolve()
LOGIN_WAIT_MS = 300_000
MAX_SCROLLS = 200
POSTS_PER_PASS = 80
STAGNANT_PASS_LIMIT = 10
RECENT_VISIBLE_ITEMS = 12


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def load_existing_posts() -> list[dict]:
    if not OUTPUT_JSON.exists():
        return []
    try:
        return json.loads(OUTPUT_JSON.read_text(encoding="utf-8"))
    except Exception:
        return []


def save_posts(posts: list[dict]) -> None:
    OUTPUT_JSON.write_text(
        json.dumps(posts, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def ensure_on_group_page(page) -> None:
    current_url = page.url
    if not current_url.startswith(GROUP_URL_PREFIX):
        raise RuntimeError(
            f"Facebook redirected away from the group page. Current URL: {current_url}"
        )


def open_group_page(page) -> None:
    page.goto(GROUP_URL, wait_until="domcontentloaded")
    ensure_on_group_page(page)
    page.wait_for_selector("div[role='feed'] [aria-posinset]", timeout=LOGIN_WAIT_MS)


def recover_group_page(page) -> bool:
    try:
        page.go_back(wait_until="domcontentloaded")
        page.wait_for_timeout(1_500)
        ensure_on_group_page(page)
        page.wait_for_selector("div[role='feed'] [aria-posinset]", timeout=LOGIN_WAIT_MS)
        print("Recovered group page with browser Back.")
        return True
    except Exception:
        return False


def click_see_more(item) -> None:
    item_key = normalize_text(extract_post_url(item)) or normalize_text(extract_post_text(item))
    blocked_expansions = getattr(item.page, "_blocked_expansions", set())
    if item_key and item_key in blocked_expansions:
        return

    # Expand only the main post message block, not descendant comments.
    message_blocks = item.locator("[data-ad-preview='message'], [data-ad-comet-preview='message']")
    for idx in range(min(message_blocks.count(), 2)):
        block = message_blocks.nth(idx)
        try:
            button = block.locator("text=/^See more$/i").first
            if button.count():
                before_url = item.page.url
                button.scroll_into_view_if_needed(timeout=1_500)
                button.click(timeout=2_000)
                item.page.wait_for_timeout(500)
                if not item.page.url.startswith(GROUP_URL_PREFIX):
                    if item_key:
                        blocked_expansions.add(item_key)
                        item.page._blocked_expansions = blocked_expansions
                    raise RuntimeError("Unsafe expansion click redirected away from the group page.")
                return
        except Exception:
            if item_key:
                blocked_expansions.add(item_key)
                item.page._blocked_expansions = blocked_expansions
            continue


def extract_author(item) -> str:
    author_loc = item.locator("h2 a, h3 a").first
    if not author_loc.count():
        return ""
    try:
        return normalize_text(author_loc.inner_text(timeout=2_000))
    except Exception:
        return ""


def extract_post_text(item) -> str:
    selectors = [
        "[data-ad-preview='message']",
        "[data-ad-comet-preview='message']",
    ]

    for selector in selectors:
        loc = item.locator(selector)
        parts: list[str] = []
        for idx in range(min(loc.count(), 12)):
            try:
                text = normalize_text(loc.nth(idx).inner_text(timeout=1_500))
            except Exception:
                continue
            if not text:
                continue
            if text.count("Facebook") >= 3:
                continue
            if text in {"Like", "Comment", "Send"}:
                continue
            if "See more" in text:
                continue
            if text not in parts:
                parts.append(text)
        if parts:
            combined = normalize_text(" ".join(parts))
            if combined:
                return combined
    return ""


def extract_post_url(item) -> str:
    links = item.locator("a[href*='/posts/'], a[href*='/permalink/'], a[href*='multi_permalinks']")
    for idx in range(links.count()):
        try:
            href = links.nth(idx).get_attribute("href") or ""
        except Exception:
            continue
        if not href:
            continue
        href = href.replace("&amp;", "&")
        if "?comment_id=" in href:
            href = href.split("?comment_id=", 1)[0]
        elif "&comment_id=" in href:
            href = href.split("&comment_id=", 1)[0]
        if "/posts/" in href or "/permalink/" in href or "multi_permalinks" in href:
            return href
    return ""


def scrape_posts() -> list[dict]:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    posts = load_existing_posts()
    seen_keys = {
        (normalize_text(post.get("post_url", "")), normalize_text(post.get("post_text", "")))
        for post in posts
    }

    with sync_playwright() as p:
        context = p.firefox.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1400, "height": 1200},
            args=["--start-maximized"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.set_default_timeout(30_000)

        print("Opening Facebook group...")
        print(f"Writing posts to: {OUTPUT_JSON}")
        try:
            open_group_page(page)
        except PlaywrightTimeoutError as exc:
            context.close()
            raise RuntimeError("Facebook posts did not appear. Check login and group access.") from exc
        except RuntimeError as exc:
            context.close()
            raise

        stagnant_passes = 0
        scroll_pass = 0

        while True:
            scroll_pass += 1
            try:
                ensure_on_group_page(page)
            except RuntimeError:
                print("Facebook redirected away from the group. Trying browser Back...")
                recovered = recover_group_page(page)
                if not recovered:
                    print("Back did not restore the group page. Reopening group page...")
                    open_group_page(page)

            print(f"Scroll pass {scroll_pass}")
            items = page.locator("div[role='feed'] [aria-posinset]")
            total_visible = items.count()
            if total_visible == 0:
                page.wait_for_timeout(2_000)
                continue

            start_idx = max(0, total_visible - RECENT_VISIBLE_ITEMS)
            count = min(total_visible, POSTS_PER_PASS)

            before = len(posts)
            for idx in range(start_idx, count):
                item = items.nth(idx)
                try:
                    item.scroll_into_view_if_needed(timeout=5_000)
                    page.wait_for_timeout(250)
                except Exception:
                    continue

                click_see_more(item)
                author = extract_author(item)
                post_text = extract_post_text(item)
                post_url = extract_post_url(item)

                if not post_text:
                    continue

                key = (normalize_text(post_url), normalize_text(post_text))
                if key in seen_keys:
                    continue

                record = {
                    "post_id": len(posts) + 1,
                    "author": author,
                    "post_text": post_text,
                    "post_url": post_url,
                    "scraped_at": datetime.utcnow().isoformat() + "+00:00",
                }
                posts.append(record)
                seen_keys.add(key)
                save_posts(posts)
                print(f"Saved {len(posts)} posts")

            try:
                items.nth(total_visible - 1).scroll_into_view_if_needed(timeout=3_000)
            except Exception:
                pass
            page.mouse.wheel(0, 12000)
            page.wait_for_timeout(4_000)

            if len(posts) == before:
                stagnant_passes += 1
                if stagnant_passes >= STAGNANT_PASS_LIMIT:
                    print("Feed plateau detected. Reopening group and continuing...")
                    stagnant_passes = 0
                    open_group_page(page)
            else:
                stagnant_passes = 0

        context.close()
        return posts


if __name__ == "__main__":
    scrape_posts()
