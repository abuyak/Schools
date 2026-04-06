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
STAGNANT_PASS_LIMIT = 20

# FIX (memory/DOM): Facebook keeps all scrolled-past posts in the DOM indefinitely.
# After ~300 items the locator query `div[role='feed'] [aria-posinset]` matches
# hundreds of detached/off-screen nodes, and iterating them all causes cascading
# Playwright timeouts (each up to 30s).  We cap how many items we hold in the DOM
# by periodically reloading the page at a deep scroll position â€” but only once we
# have genuinely processed everything visible first.
# This constant controls how many DOM items we tolerate before a page reload.
DOM_ITEM_RELOAD_THRESHOLD = 150


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


def click_see_more(item, item_key: str, blocked_expansions: set) -> None:
    """
    FIX (timeout cascade): The original called extract_post_url() and
    extract_post_text() inside this function to build item_key.  Those each
    iterate up to 12 inner_text() calls at 1500ms timeout each.  That's 36s of
    potential timeouts per item, called BEFORE we even try to click See More.
    We now accept item_key and blocked_expansions as parameters â€” the caller
    builds item_key once from already-extracted data and passes it in.
    """
    if item_key and item_key in blocked_expansions:
        return

    message_blocks = item.locator("[data-ad-preview='message'], [data-ad-comet-preview='message']")
    for idx in range(min(message_blocks.count(), 2)):
        block = message_blocks.nth(idx)
        try:
            button = block.locator("text=/^See more$/i").first
            if button.count():
                button.scroll_into_view_if_needed(timeout=1_500)
                button.click(timeout=2_000)
                item.page.wait_for_timeout(500)
                if not item.page.url.startswith(GROUP_URL_PREFIX):
                    if item_key:
                        blocked_expansions.add(item_key)
                    raise RuntimeError("Unsafe expansion click redirected away from the group page.")
                return
        except Exception:
            if item_key:
                blocked_expansions.add(item_key)
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
                # FIX (timeout): reduced from 1500ms to 800ms â€” detached nodes
                # that will never resolve should fail fast, not block for 1.5s each.
                text = normalize_text(loc.nth(idx).inner_text(timeout=800))
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
            # FIX (timeout): get_attribute falls back to the 30s page default timeout.
            # Explicitly cap it so a stale node doesn't block for 30s.
            href = links.nth(idx).get_attribute("href", timeout=1_000) or ""
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
    highest_processed_posinset = 0

    # FIX (DOM growth): blocked_expansions was stored on `page` as a dynamic attribute,
    # which is fragile and doesn't survive page reloads.  Keep it here in Python scope.
    blocked_expansions: set[str] = set()

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

            items = page.locator("div[role='feed'] [aria-posinset]")
            total_visible = items.count()

            print(
                f"Scroll pass {scroll_pass} | "
                f"posts saved: {len(posts)} | "
                f"DOM items: {total_visible} | "
                f"highest posinset: {highest_processed_posinset}"
            )

            if total_visible == 0:
                page.wait_for_timeout(2_000)
                continue

            # FIX (DOM memory leak): Facebook never removes posts from the DOM as you
            # scroll.  After hundreds of posts the selector matches a huge stale list.
            # Iterating it causes cascading timeouts on detached nodes â€” this is what
            # killed the previous run after ~300 posts (4 hours of zero progress).
            #
            # Solution: once the DOM item count exceeds the threshold AND we've
            # processed all currently visible items, reload the page.  Facebook will
            # re-render only the items near the current scroll position, giving us a
            # clean DOM.  We track position via highest_processed_posinset so we never
            # reprocess old posts after the reload.
            if total_visible > DOM_ITEM_RELOAD_THRESHOLD:
                # Check whether there are actually any new items to process.
                has_new = False
                for idx in range(total_visible - 1, max(total_visible - 20, -1), -1):
                    try:
                        ps = int(items.nth(idx).get_attribute("aria-posinset", timeout=500) or "0")
                        if ps > highest_processed_posinset:
                            has_new = True
                            break
                    except Exception:
                        continue

                if not has_new:
                    print(f"DOM has {total_visible} items but nothing new â€” reloading page to flush DOM...")
                    # Scroll a bit first so Facebook resumes from roughly the right spot.
                    page.mouse.wheel(0, 15_000)
                    page.wait_for_timeout(3_000)
                    open_group_page(page)
                    stagnant_passes = 0
                    continue

            before = len(posts)
            for idx in range(total_visible):
                item = items.nth(idx)

                try:
                    posinset_str = item.get_attribute("aria-posinset", timeout=500) or "0"
                    posinset = int(posinset_str)
                except Exception:
                    posinset = 0

                # Already handled â€” skip immediately without any DOM interaction.
                if posinset > 0 and posinset <= highest_processed_posinset:
                    continue

                try:
                    item.scroll_into_view_if_needed(timeout=5_000)
                    page.wait_for_timeout(200)
                except Exception:
                    continue

                # Extract text and URL first (needed for dedup key and See More key).
                post_text = extract_post_text(item)
                post_url = extract_post_url(item)

                # Now call click_see_more with the already-built key â€” no redundant extraction.
                item_key = normalize_text(post_url) or normalize_text(post_text)
                click_see_more(item, item_key, blocked_expansions)

                # Re-extract text after potential See More expansion.
                if item_key:
                    post_text = extract_post_text(item)

                author = extract_author(item)

                # Advance watermark regardless of whether we save the post.
                if posinset > 0:
                    highest_processed_posinset = max(highest_processed_posinset, posinset)

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
                print(f"  â†’ Saved post #{len(posts)} (posinset={posinset}): {author[:40]!r}")

            # Scroll further down.
            try:
                items.nth(total_visible - 1).scroll_into_view_if_needed(timeout=3_000)
            except Exception:
                pass
            page.mouse.wheel(0, 15_000)
            page.wait_for_timeout(5_000)

            if len(posts) == before:
                stagnant_passes += 1
                print(f"  No new posts this pass ({stagnant_passes}/{STAGNANT_PASS_LIMIT})")
                if stagnant_passes >= STAGNANT_PASS_LIMIT:
                    print("Feed plateau â€” JS scroll to bottom and waiting...")
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(6_000)
                    stagnant_passes = 0
            else:
                stagnant_passes = 0

        context.close()
        return posts


if __name__ == "__main__":
    scrape_posts()

