import asyncio
import json
import os

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

CANDIDATES = [
    ("11680937130", "6674584d00000000070042d5"),
    ("95665891638", "67c39d5a000000000e01344b"),
    ("26507714854", "666a753600000000030306a7"),
    ("3884251743", "63aa597d0000000026006589"),
    ("6868122277", "649c2ab1000000001c029d8a"),
]

async def inspect(context, xhs_id, profile_id):
    page = await context.new_page()
    url = f"https://www.xiaohongshu.com/user/profile/{profile_id}?xsec_source=pc_search"
    try:
        await page.goto(url, wait_until="commit", timeout=20000)
    except PlaywrightTimeoutError:
        pass
    await page.wait_for_timeout(3500)
    for _ in range(2):
        await page.mouse.wheel(0, 1500)
        await page.wait_for_timeout(600)
    data = await page.locator("body").evaluate("""
      body => {
        const text = (body.innerText || '').trim();
        const avatars = [...body.querySelectorAll('img')]
          .map(img => img.currentSrc || img.src || '')
          .filter(src => src.includes('sns-avatar'));
        const notes = [...body.querySelectorAll("a[href*='/explore/']")]
          .map(a => ({href:a.href, text:(a.innerText||'').trim()}));
        return {
          body: text.slice(0, 5000),
          avatar: avatars.find(src => src.includes('/w/540/')) || avatars[0] || '',
          noteCount: new Set(notes.map(x => x.href)).size,
          noteText: [...new Set(notes.map(x => x.text).filter(Boolean))].join('\n').slice(0,5000)
        };
      }
    """)
    await page.close()
    return {"xhsId": xhs_id, "profileId": profile_id, **data}

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(os.environ["XHS_CDP_WS"], timeout=30000)
        context = browser.contexts[0]
        out = []
        for xhs_id, profile_id in CANDIDATES:
            out.append(await inspect(context, xhs_id, profile_id))
            await asyncio.sleep(1.2)
        print(json.dumps(out, ensure_ascii=False))
        await browser.close()

asyncio.run(main())
