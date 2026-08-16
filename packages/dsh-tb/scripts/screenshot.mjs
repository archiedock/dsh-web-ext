import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const OUT = 'img'
mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1.6'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1680, height: 950, deviceScaleFactor: 1.6 })
await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 60000 })

// sidebar entry appears once the shell mounts
await page.waitForSelector('[data-dsh-atb-entry]', { timeout: 30000 })
await page.click('[data-dsh-atb-entry]')
await page.waitForSelector('.dsh-atb-board', { timeout: 15000 })
// let SSE state + workspaces land
await page.waitForSelector('.dsh-atb-card', { timeout: 15000 })
await new Promise(r => setTimeout(r, 800))
await page.screenshot({ path: `${OUT}/board.png` })
console.log('board.png done')

// detail: click the in-review card (has a comment)
const cards = await page.$$('.dsh-atb-card')
let clicked = false
for (const c of cards) {
  const t = await c.evaluate(el => el.textContent)
  if (t.includes('深色主题适配')) { await c.click(); clicked = true; break }
}
if (!clicked && cards.length > 0) await cards[0].click()
await page.waitForSelector('.dsh-atb-detail', { timeout: 10000 })
await new Promise(r => setTimeout(r, 500))
await page.screenshot({ path: `${OUT}/detail.png` })
console.log('detail.png done')

// new-task modal
await page.click('.dsh-atb-detail-close')
await page.evaluate(() => document.querySelector('[data-pane="conversation"]').scrollTo(0, 0))
await new Promise(r => setTimeout(r, 300))
const btns = await page.$$('.dsh-atb-toolbar .dsh-atb-btn')
for (const b of btns) {
  const t = await b.evaluate(el => el.textContent)
  if (t.includes('新建任务')) { await b.click(); break }
}
await page.waitForSelector('.dsh-atb-modal', { timeout: 10000 })
await new Promise(r => setTimeout(r, 400))
// switch to scheduled to show cron presets
const modeBtns = await page.$$('.dsh-atb-mode-opt')
for (const b of modeBtns) {
  const t = await b.evaluate(el => el.textContent)
  if (t.includes('定时')) { await b.click(); break }
}
await new Promise(r => setTimeout(r, 300))
await page.screenshot({ path: `${OUT}/modal.png` })
console.log('modal.png done')

await browser.close()