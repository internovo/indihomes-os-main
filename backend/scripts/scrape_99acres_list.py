#!/usr/bin/env python3
"""
Discover real, currently-listed new-launch projects on 99acres for a set of
cities. This is intentionally lightweight (one search-results page load per
city, ~10-15s each) — it exists to give Project Selection a list of REAL,
accurately-named projects to choose from. Builder/price/RERA/configs are
NOT scraped here; once a user selects a project and opens Project
Intelligence, scrape_99acres.py does the full per-project deep scrape.

Reads JSON from stdin: {"cities": ["Thane", "Mumbai", ...]}
Writes a JSON array to stdout: [{"name", "city", "listingUrl"}, ...]
"""
import sys
import json
import time
import re
import os

from chrome_utils import make_driver


def log(msg):
    print(f'[scrape_99acres_list] {msg}', file=sys.stderr, flush=True)


def slug_to_name(slug, city):
    # e.g. "metro-imperial-naupada-mumbai-thane" -> "Metro Imperial"
    # strip the trailing city/locality words 99acres appends to every slug
    parts = slug.split('-')
    city_words = set(w.lower() for w in re.split(r'\s+', city) if w)
    city_words |= {'mumbai', 'thane', 'pune', 'navi', 'west', 'east', 'north', 'south'}
    trimmed = []
    for p in parts:
        if p.lower() in city_words and len(trimmed) >= 1:
            break
        trimmed.append(p)
    if not trimmed:
        trimmed = parts[:2]
    return ' '.join(w.capitalize() for w in trimmed)


def discover_city(driver, city):
    query = f'{city} new projects'
    url = (
        'https://www.99acres.com/search/property/buy/residential-plus-others-projects'
        f'?keyword={query.replace(" ", "%20")}'
    )
    log(f'{city}: {url}')
    driver.get(url)
    time.sleep(6)
    src = driver.page_source

    if 'Access Denied' in src or len(src) < 2000:
        log(f'{city}: blocked or empty response')
        return []

    matches = re.findall(r'href="(https://www\.99acres\.com/([^"/]*npxid[^"]*))"', src, re.I)
    seen = {}
    for full_url, slug in matches:
        if full_url not in seen:
            seen[full_url] = slug
    results = []
    for full_url, slug in seen.items():
        results.append({
            'name': slug_to_name(slug, city),
            'city': city,
            'listingUrl': full_url,
        })
    log(f'{city}: found {len(results)} projects')
    return results


def main():
    req = json.loads(sys.stdin.read() or '{}')
    cities = req.get('cities') or ['Mumbai', 'Thane', 'Pune', 'Navi Mumbai']

    driver = None
    all_results = []
    try:
        driver = make_driver(log=log)
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
