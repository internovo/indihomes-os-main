#!/usr/bin/env python3
"""
Local 99acres scraper using undetected-chromedriver.

Reads a JSON request from stdin: {"name": str, "builder": str, "city": str}
Writes a JSON result to stdout (same shape the Node server expects from
the old Apify integration). All diagnostic logging goes to stderr so it
never corrupts the stdout JSON.

Key finding: 99acres' Akamai WAF blocks *headless* Chrome outright (even
with undetected-chromedriver), but allows a normal (non-headless) browser
window through. So this script intentionally does NOT run headless.
"""
import sys
import json
import time
import re
import os
import html as html_lib

from chrome_utils import make_driver as _make_driver


def clean_html(text):
    """99acres embeds raw marketing HTML (price-list tables, <b> tags, <br>)
    directly inside some text fields (e.g. moreAboutProject.description).
    Strip it down to plain, readable text — tables/lists become line breaks,
    not a wall of tags."""
    if not text:
        return ''
    s = str(text)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|tr|li|h[1-6])>', '\n', s)
    s = re.sub(r'(?i)<li[^>]*>', '• ', s)
    s = re.sub(r'<[^>]+>', '', s)           # drop all remaining tags
    s = html_lib.unescape(s)                 # decode &amp; &nbsp; etc.
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n\s*\n+', '\n\n', s)       # collapse repeated blank lines
    return s.strip()


def log(msg):
    print(f'[scrape_99acres] {msg}', file=sys.stderr, flush=True)


def clean_key(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def fuzzy_match(a, b):
    ca, cb = clean_key(a), clean_key(b)
    if not ca or not cb:
        return False
    return ca == cb or ca in cb or cb in ca


def make_driver():
    return _make_driver(log=log)


def extract_intel(initial_data, name, builder, city, listing_url):
    pd = initial_data.get('projectDetailState', {}) or {}
    page = pd.get('pageData', {}) or {}
    bd = page.get('basicDetails', {}) or {}
    comp = page.get('components', {}) or {}
    sl = comp.get('summaryLayer', {}) or {}

    description = ''
    more_about = comp.get('moreAboutProject', {}) or {}
    if more_about.get('description'):
        description = more_about['description']
    elif (comp.get('builder', {}) or {}).get('description'):
        description = comp['builder']['description']
    description = clean_html(description)

    configs = []
    for card in (sl.get('configCards', {}) or {}).get('cards') or []:
        ci = card.get('configInfo', {}) or {}
        area = card.get('area', {}) or {}
        price = card.get('price', {}) or {}
        if not ci.get('label'):
            continue
        configs.append({
            'type': ci.get('label', ''),
            'carpet': area.get('display', ''),
            'total': None,
            'available': None,
            'price': price.get('label', ''),
            'movement': None,
            '_estimated': False,
        })

    amenities = []
    for t in (comp.get('facilities', {}) or {}).get('tuples') or []:
        if t.get('label'):
            amenities.append(clean_html(t['label']))

    usps = [clean_html(u) for u in ((comp.get('usp', {}) or {}).get('tuples') or [])]

    rera_block = sl.get('rera', {}) or {}
    rera = rera_block.get('registrationNumber', '') or ''
    # Some projects register multiple towers under different RERA numbers
    rera_tuples = rera_block.get('tuples') or []
    rera_all = [t.get('registrationNumber', '') for t in rera_tuples if t.get('registrationNumber')]
    # Real verification links captured from the listing — never invented
    rera_verify_url = rera_block.get('url', '') or ''
    rera_qr_url = next((t.get('qrCodeUrl', '') for t in rera_tuples if t.get('qrCodeUrl')), '')

    possession = (sl.get('completionDate', {}) or {}).get('label', '') or \
                 (sl.get('constructionStatus', {}) or {}).get('label', '')

    price_block = bd.get('price', {}) or {}
    price_range = price_block.get('label', '')

    loc = bd.get('location', {}) or {}
    latitude = loc.get('latitude')
    longitude = loc.get('longitude')
    locality_name = loc.get('localityName', '')

    competitors = []
    sim = ((comp.get('similarProjectRecommendations', {}) or {}).get('data', {}) or {}).get('recommendations') or []
    for r in sim[:5]:
        url_path = r.get('PROJECT_LANDING_URL', '')
        competitors.append({
            'name':    r.get('NAME', ''),
            'builder': '',
            'price':   r.get('PRICE_DISP', 'Price on request'),
            'sold':    None,
            'status':  r.get('POSSESSION_STATUS', 'Active'),
            'url':     f'https://www.99acres.com{url_path}' if url_path else '',
        })

    return {
        'name':         bd.get('name') or name,
        'builder':      (comp.get('builder', {}) or {}).get('name', '') or builder,
        'city':         (bd.get('location', {}) or {}).get('cityName', '') or city,
        'description':  description,
        'configs':      configs,
        'amenities':    amenities,
        'rera':         rera,
        'reraAll':      rera_all,
        'reraValidity': '',
        'reraVerifyUrl': rera_verify_url,
        'reraQrUrl':      rera_qr_url,
        'possession':   possession,
        'sold':         None,
        'units':        None,
        'priceRange':   price_range,
        'price':        price_range,
        'infra':        [],
        'usps':         usps,
        'listingUrl':   listing_url,
        'imageUrl':     '',
        'competitors':  competitors,
        'latitude':     latitude,
        'longitude':    longitude,
        'localityName': locality_name,
        '_sources':     {'primary': '99acres (local scrape)'},
        '_scraped':     True,
        '_configsEstimated':   len(configs) == 0,
        '_amenitiesEstimated': len(amenities) == 0,
        '_reraEstimated':      not rera,
    }


def main():
    req = json.loads(sys.stdin.read() or '{}')
    name = req.get('name', '') or ''
    builder = req.get('builder', '') or ''
    city = req.get('city', '') or 'Mumbai'
    known_url = req.get('listingUrl', '') or ''

    if not name:
        print(json.dumps({'_scraped': False, '_error': 'name required'}))
        return

    driver = None
    try:
        driver = make_driver()

        if known_url and 'npxid' in known_url:
            # We already have the exact project page (e.g. from a prior discovery
            # scrape) — skip the search step entirely, faster and more accurate.
            target_url = known_url
            log(f'using known listing URL, skipping search: {target_url}')
        else:
            # Omit the city/locality path segment and the numeric `city=` query param —
            # both require an exact 99acres city ID and silently override the keyword
            # with the wrong city's results when guessed wrong. A bare keyword search
            # with the city name folded into the query text is more reliable.
            query = f'{name} {city}'.strip()
            search_url = (
                'https://www.99acres.com/search/property/buy/residential-plus-others-projects'
                f'?keyword={query.replace(" ", "%20")}'
            )
            log(f'search: {search_url}')
            driver.get(search_url)
            time.sleep(6)
            src = driver.page_source

            if 'Access Denied' in src or len(src) < 2000:
                print(json.dumps({'_scraped': False, '_error': 'Blocked by 99acres (try again — non-headless bypass is not 100% reliable)'}))
                return

            links = list(dict.fromkeys(re.findall(r'href="(https://www\.99acres\.com/[^"]*npxid[^"]*)"', src, re.I)))
            if not links:
                print(json.dumps({'_scraped': False, '_error': f'Project "{name}" not found on 99acres for {city}'}))
                return

            target_url = next((l for l in links if fuzzy_match(l, name)), links[0])
            log(f'project page: {target_url}')

        driver.get(target_url)
        time.sleep(6)
        data = driver.execute_script('return window.__initialData__')
        if not data:
            print(json.dumps({'_scraped': False, '_error': 'No structured data found on project page'}))
            return

        result = extract_intel(data, name, builder, city, target_url)
        print(json.dumps(result))

    except Exception as e:
        log(f'ERROR: {e}')
        print(json.dumps({'_scraped': False, '_error': str(e)}))
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


if __name__ == '__main__':
    main()
