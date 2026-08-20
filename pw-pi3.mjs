import { chromium } from 'playwright'
const outDir = 'C:\\Users\\admin\\AppData\\Local\\Temp\\claude\\C--Users-admin-downloads-indihomes-os-restructured-1\\5da4903f-3de2-4462-a196-0e6532b8b49d\\scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('pageerror', err => errors.push(String(err)))
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.click('text=Project Selection')
await page.waitForTimeout(2000)
await page.click('button:has-text("Select & Analyse")')
await page.waitForTimeout(2500)
await page.screenshot({ path: `${outDir}\\pi-final-top.png` })

await page.evaluate((yy) => {
  const els = document.querySelectorAll('div')
  for (const el of els) {
    if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY === 'auto') { el.scrollTop = yy; return }
  }
}, 650)
await page.waitForTimeout(500)
await page.screenshot({ path: `${outDir}\\pi-final-mid.png` })

await page.evaluate((yy) => {
  const els = document.querySelectorAll('div')
  for (const el of els) {
    if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY === 'auto') { el.scrollTop = yy; return }
  }
}, 1600)
await page.waitForTimeout(500)
await page.screenshot({ path: `${outDir}\\pi-final-bottom.png` })

console.log('ERRORS:', JSON.stringify(errors))
await browser.close()
