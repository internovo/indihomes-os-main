import { chromium } from 'playwright'
const outDir = 'C:\\Users\\admin\\AppData\\Local\\Temp\\claude\\C--Users-admin-downloads-indihomes-os-restructured-1\\5da4903f-3de2-4462-a196-0e6532b8b49d\\scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.click('text=Project Selection')
await page.waitForTimeout(2500)
await page.screenshot({ path: `${outDir}\\debug-ps.png` })
await browser.close()
