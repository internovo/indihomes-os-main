"""Shared helpers for locating/version-detecting Chrome across Windows + Linux."""
import os
import platform
import re
import subprocess
import sys

import undetected_chromedriver as uc


def make_chrome_options():
    """Common Chrome flags for both scrapers. 99acres' WAF blocks --headless
    Chrome outright, so we never use it — instead Chrome gets a real window
    to render into.
      - On Windows (local dev), that's a real desktop, so we push the window
        off-screen with --window-position so it doesn't visibly pop up.
      - Under Linux/Xvfb (Docker/Railway/Render), the "display" is already a
        fake virtual framebuffer nobody can see — pushing the window to
        negative coordinates outside Xvfb's single fixed-size screen has no
        equivalent "second monitor" to land on like it does on Windows, and
        was observed to make Chrome hang on page navigation. So on Linux we
        just let the window render normally inside the virtual screen.
    """
    opts = uc.ChromeOptions()
    opts.add_argument('--window-size=1366,900')
    if platform.system() == 'Windows':
        opts.add_argument('--window-position=-3000,-3000')
    if platform.system() == 'Linux':
        opts.add_argument('--no-sandbox')        # required running as root in a container
        opts.add_argument('--disable-dev-shm-usage')  # Docker's small /dev/shm crashes Chrome otherwise
    opts.add_argument('--disable-notifications')
    opts.add_argument('--mute-audio')
    return opts


def make_driver(log=lambda msg: print(msg, file=sys.stderr, flush=True)):
    opts = make_chrome_options()
    version_main = detect_chrome_major_version()
    if version_main:
        log(f'detected Chrome major version: {version_main}')
        driver = uc.Chrome(options=opts, version_main=version_main)
    else:
        driver = uc.Chrome(options=opts)
    # Without this, a stalled/slow navigation (e.g. a WAF silently throttling
    # a datacenter IP instead of returning a fast denial) hangs driver.get()
    # indefinitely with no error — we only find out via the outer process-kill
    # timeout, with zero diagnostic info about what actually happened.
    driver.set_page_load_timeout(30)
    log('driver ready, page load timeout = 30s')
    return driver


def detect_chrome_major_version():
    """Best-effort local Chrome version detection so undetected-chromedriver
    downloads the matching chromedriver build instead of guessing wrong."""
    # Linux (Docker/Railway/Render) — google-chrome-stable or chromium, no registry to query
    for cmd in ('google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'):
        try:
            out = subprocess.check_output([cmd, '--version'], stderr=subprocess.DEVNULL, timeout=10).decode()
            m = re.search(r'(\d+)\.', out)
            if m:
                return int(m.group(1))
        except Exception:
            continue

    # Windows
    candidates = [
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                import win32api  # type: ignore
                info = win32api.GetFileVersionInfo(path, '\\')
                ms = info['FileVersionMS']
                return ms >> 16
            except Exception:
                pass
            try:
                out = subprocess.check_output(
                    ['powershell', '-NoProfile', '-Command',
                     f'(Get-Item "{path}").VersionInfo.ProductVersion'],
                    stderr=subprocess.DEVNULL, timeout=10,
                ).decode().strip()
                return int(out.split('.')[0])
            except Exception:
                pass
    return None
