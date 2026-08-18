#!/usr/bin/env python3
"""
Local MagicBricks scraper using undetected-chromedriver. Unlike 99acres,
MagicBricks does NOT block this Selenium technique at all (confirmed via
testing — loads full real content immediately, no WAF, no decoy pages).

Reads a JSON request from stdin: {"name": str, "builder": str, "city": str, "listingUrl": str (optional)}
Writes a JSON result to stdout in the same shape as scrape_99acres.py, so the
Node dispatcher can use either source interchangeably.
"""
import sys
import json
import time
import re
import html as html_lib

from chrome_utils import make_driver


def log(msg):
    print(f'[scrape_magicbricks] {msg}', file=sys.stderr, flush=True)


def clean_html(text):
    if not text:
        return ''
    s = str(text)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|tr|li|h[1-6])>', '\n', s)
    s = re.sub(r'(?i)<li[^>]*>', '• ', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = html_lib.unescape(s)
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n\s*\n+', '\n\n', s)
    return s.strip()


def clean_key(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def fuzzy_match(a, b):
    ca, cb = clean_key(a), clean_key(b)
    if not ca or not cb:
        return False
    return ca == cb or ca in cb or cb in ca


def parse_rera_validity(raw):
    """MagicBricks packs multi-tower RERA into one bracketed string:
    '[P51700000981|07/2022|Phase7,P51700001030|08/2022|Phase8,...]'"""
    s = (raw or '').strip().strip('[]')
    out = []
    for chunk in s.split(','):
        parts = chunk.split('|')
        code = parts[0].strip() if parts else ''
        if code:
            out.append(code)
    return out


def extract_intel(state, name, builder, city, listing_url):
    pd = state.get('projectDetailData', {}) or {}
    mb = pd.get('prjMobileBean', {}) or {}
    info = mb.get('infoBean', {}) or {}
    detail = mb.get('detailBean', {}) or {}

    description = ''
    desc_obj = mb.get('projectDescription')
    if isinstance(desc_obj, dict):
        description = clean_html(desc_obj.get('fullDesc', ''))
    elif isinstance(desc_obj, str):
        description = clean_html(desc_obj)

    rera_all = parse_rera_validity(info.get('reraValidity', ''))
    rera = rera_all[0] if rera_all else ''

    bedrooms = [b.strip() for b in (detail.get('bedroom') or '').split(',') if b.strip()]
    configs = [{
        'type': f'{b} BHK', 'carpet': '', 'total': None, 'available': None,
        'price': info.get('price', ''), 'movement': None, '_estimated': False,
    } for b in bedrooms]

    amenities = [clean_html(a.get('amenityName', '')) for a in (mb.get('amenitiesList') or []) if a.get('amenityName')]

    latitude = info.get('psmLatitude')
    longitude = info.get('psmLongitude')
    try:
        latitude = float(latitude) if latitude else None
        longitude = float(longitude) if longitude else None
    except (TypeError, ValueError):
        latitude = longitude = None

    return {
        'name':         info.get('projectName') or name,
        'builder':      info.get('devName') or builder,
        'city':         info.get('cityName') or city,
        'description':  description,
        'configs':      configs,
        'amenities':    amenities,
        'rera':         rera,
        'reraAll':      rera_all,
        'reraValidity': '',
        'reraVerifyUrl': pd.get('pdpReraUrl') or pd.get('reraUrl') or 'https://maharera.mahaonline.gov.in/',
        'reraQrUrl':    '',
        'possession':   detail.get('newHomesPossStatus', ''),
        'sold':         None,
        'units':        pd.get('availableUnits'),
        'priceRange':   info.get('price', ''),
        'price':        info.get('price', ''),
        'infra':        [],
        'usps':         [],
        'listingUrl':   listing_url,
        'imageUrl':     info.get('image', ''),
        'competitors':  [],
        'latitude':     latitude,
        'longitude':    longitude,
        'localityName': info.get('localityName', '') or info.get('lmtDName', ''),
        'launchDate':   detail.get('launchDate', ''),
        'projectArea':  detail.get('area', ''),
        '_sources':     {'primary': 'MagicBricks (local scrape)'},
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

        if known_url and 'pdpid' in known_url and 'magicbricks.com' in known_url:
            target_url = known_url
            log(f'using known listing URL, skipping search: {target_url}')
        else:
            query = f'{name} {city}'.strip()
            search_url = (
                'https://www.magicbricks.com/property-for-sale/residential-real-estate'
                f'?proptype=Multistorey-Apartment,Builder-Floor-Apartment,Penthouse,Studio-Apartment'
                f'&cityName={city.replace(" ", "%20")}&keyword={query.replace(" ", "%20")}'
            )
            log(f'search: {search_url}')
            driver.get(search_url)
            time.sleep(6)
            state = driver.execute_script('return window.SERVER_PRELOADED_STATE_')
            results = (state or {}).get('searchResult') or []
            links = []
            for r in results:
                link = r.get('projectSocietyLink', '')
                if link and link not in links:
                    links.append(link)
            if not links:
                print(json.dumps({'_scraped': False, '_error': f'Project "{name}" not found on MagicBricks for {city}'}))
                return
            target_slug = next((l for l in links if fuzzy_match(l, name)), links[0])
            target_url = f'https://www.magicbricks.com/{target_slug}'
            log(f'project page: {target_url}')

        driver.get(target_url)
        time.sleep(6)
        state = driver.execute_script('return window.SERVER_PRELOADED_STATE_')
        if not state or not state.get('projectDetailData'):
            print(json.dumps({'_scraped': False, '_error': 'No structured data found on project page'}))
            return

        result = extract_intel(state, name, builder, city, target_url)
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
