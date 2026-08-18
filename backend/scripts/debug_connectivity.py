#!/usr/bin/env python3
"""One-off diagnostic: isolates whether a hang/failure is (a) plain network
egress, (b) Selenium/Xvfb/Chrome infra, or (c) specific to 99acres' WAF."""
import sys
import time

from chrome_utils import make_driver


def log(msg):
    print(f'[debug] {msg}', file=sys.stderr, flush=True)


def main():
    results = {}

    log('1/4: plain HTTP GET to example.com via urllib...')
    try:
        import urllib.request
        t0 = time.time()
        with urllib.request.urlopen('https://example.com', timeout=10) as r:
            results['http_example'] = f'OK status={r.status} in {time.time()-t0:.1f}s'
    except Exception as e:
        results['http_example'] = f'FAIL: {e}'
    log(results['http_example'])

    log('2/4: plain HTTP GET to 99acres.com via urllib...')
    try:
        import urllib.request
        t0 = time.time()
        req = urllib.request.Request('https://www.99acres.com', headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read(500)
            results['http_99acres'] = f'OK status={r.status} in {time.time()-t0:.1f}s len={len(body)}'
    except Exception as e:
        results['http_99acres'] = f'FAIL: {e}'
    log(results['http_99acres'])

    log('3/4: Selenium driver.get(example.com)...')
    driver = None
    try:
        t0 = time.time()
        driver = make_driver(log=log)
        driver.get('https://example.com')
        results['selenium_example'] = f'OK title="{driver.title}" in {time.time()-t0:.1f}s'
    except Exception as e:
        results['selenium_example'] = f'FAIL: {type(e).__name__}: {e}'
    log(results['selenium_example'])

    log('4/5: Selenium driver.get(99acres.com)...')
    try:
        t0 = time.time()
        driver.get('https://www.99acres.com')
        results['selenium_99acres'] = f'OK title="{driver.title}" len={len(driver.page_source)} in {time.time()-t0:.1f}s'
    except Exception as e:
        results['selenium_99acres'] = f'FAIL: {type(e).__name__}: {e}'
    log(results['selenium_99acres'])

    log('5/6: Selenium driver.get(99acres search-results URL)...')
    try:
        t0 = time.time()
        url = 'https://www.99acres.com/search/property/buy/residential-plus-others-projects?keyword=Lodha%20Amara%20Thane'
        driver.get(url)
        snippet = driver.page_source[:300]
        results['selenium_99acres_search'] = f'OK title="{driver.title}" len={len(driver.page_source)} in {time.time()-t0:.1f}s'
        results['selenium_99acres_search_snippet'] = snippet
    except Exception as e:
        results['selenium_99acres_search'] = f'FAIL: {type(e).__name__}: {e}'
    log(results['selenium_99acres_search'])

    log('6/7: Selenium driver.get(known npxid project page, exact local-success URL)...')
    try:
        t0 = time.time()
        url = 'https://www.99acres.com/lodha-amara-kolshet-road-thane-npxid-r177287'
        driver.get(url)
        results['selenium_99acres_project'] = f'OK title="{driver.title}" len={len(driver.page_source)} in {time.time()-t0:.1f}s'
        results['selenium_99acres_project_has_initial_data'] = '__initialData__' in driver.page_source
    except Exception as e:
        results['selenium_99acres_project'] = f'FAIL: {type(e).__name__}: {e}'
    log(results['selenium_99acres_project'])

    log('7/7: Selenium driver.get(known MagicBricks project page, exact local-success URL)...')
    try:
        t0 = time.time()
        url = 'https://www.magicbricks.com/lodha-amara-kolshet-road-thane-pdpid-4d4235303931353233'
        driver.get(url)
        results['selenium_magicbricks_project'] = f'OK title="{driver.title}" len={len(driver.page_source)} in {time.time()-t0:.1f}s'
        results['selenium_magicbricks_has_state'] = 'SERVER_PRELOADED_STATE_' in driver.page_source
    except Exception as e:
        results['selenium_magicbricks_project'] = f'FAIL: {type(e).__name__}: {e}'
    log(results['selenium_magicbricks_project'])

    if driver:
        try:
            driver.quit()
        except Exception:
            pass

    print(__import__('json').dumps(results))


if __name__ == '__main__':
    main()
