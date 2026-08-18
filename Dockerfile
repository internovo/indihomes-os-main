FROM node:22-bookworm-slim

# ── System deps: Chrome, Python, and an Xvfb virtual display ──────────────────
# Xvfb matters here specifically: 99acres' WAF blocks --headless Chrome
# outright (confirmed during development), but accepts a normal, non-headless
# Chrome window. Xvfb gives Chrome a real (virtual) display to render into so
# it never has to run with --headless, even on a server with no monitor.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates \
    python3 python3-pip python3-venv \
    xvfb \
    fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci
# Playwright's npm package does NOT bundle the browser binary — without this,
# chromium.launch() in the MahaRERA/MagicBricks/GoogleAds scrapers throws and
# takes down the whole runScrapers() pipeline before the 99acres step even runs.
RUN npx playwright install --with-deps chromium

COPY backend/scripts/requirements.txt backend/scripts/requirements.txt
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir -r backend/scripts/requirements.txt
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHON_BIN="/opt/venv/bin/python3"

COPY . .
RUN chmod +x docker-entrypoint.sh

ENV DISPLAY=:99
ENV NODE_ENV=production

CMD ["./docker-entrypoint.sh"]
