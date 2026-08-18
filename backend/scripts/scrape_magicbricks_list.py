#!/usr/bin/env python3
"""
Discover real, currently-listed projects on MagicBricks for a set of cities.
Same role as scrape_99acres_list.py but for MagicBricks — lightweight (one
search page load per city), used to seed Project Selection with real,
accurately-named, selectable projects.

Reads JSON from stdin: {"cities": ["Thane", "Mumbai", ...]}
Writes a JSON array to stdout: [{"name", "city", "listingUrl"}, ...]
"""
import sys
import json
import time
import re

from chrome_utils import make_driver


def log(msg):
    print(f'[scrape_magicbricks_list] {msg}', file=sys.stderr, flush=True)


def slug_to_name(slug):
    # e.g. "adani-codename-lit-teen-hath-naka-thane-pdpid-4d42..." -> "Adani Codename Lit"
    base = re.sub(r'-pdpid-.*$', '', slug)
    parts = base.split('-')
    # Drop trailing locality/city words (best-effort — keep first 2-4 words)
    return ' '.join(w.capitalize() for w in parts[:4])


def discover_city(driver, city):
    url = (
        'https://www.magicbricks.com/property-for-sale/residential-real-estate'
        '?proptype=Multistorey-Apartment,Builder-Floor-Apartment,Penthouse,Studio-Apartment'
        f'&cityName={city.replace(" ", "%20")}'
    )
    log(f'{city}: {url}')
    driver.get(url)
    time.sleep(6)

    state = driver.execute_script('return window.SERVER_PRELOADED_STATE_')
    results = (state or {}).get('searchResult') or []
    if not results:
        log(f'{city}: no results (blocked or empty)')
        return []

    seen = {}
    for r in results:
        slug = r.get('projectSocietyLink', '')
        if slug and slug not in seen:
            seen[slug] = True

    out = [{'name': slug_to_name(slug), 'city': city, 'listingUrl': f'https://www.magicbricks.com/{slug}'} for slug in seen]
    log(f'{city}: found {len(out)} projects')
    return out


def main():
    req = json.loads(sys.stdin.read() or '{}')
    cities = req.get('cities') or ['Mumbai', 'Thane', 'Pune', 'Navi Mumbai']

    driver = None
    all_results = []
    try:
        driver = make_driver()
        for city in cities:
            try:
                all_results.extend(discover_city(driver, city))
            except Exception as e:
                log(f'{city}: ERROR {e}')
        print(json.dumps(all_results))
    except Exception as e:
        log(f'FATAL: {e}')
        print(json.dumps([]))
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


if __name__ == '__main__':
    main()
