// 到点提醒 + 逾期状态及时刷新验证
const puppeteer = require('puppeteer-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
let failed = 0
function check(n, c, x) { if (c) console.log('PASS ' + n); else { failed++; console.log('FAIL ' + n + (x ? ' | ' + x : '')) } }
;(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--lang=zh-CN'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await page.goto('http://localhost:8899/index.html', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 1500))

  await page.evaluate(() => {
    S.myUid = 'u1'
    S.members = [{ id: 1, user_uid: 'u1', nickname: '我' }]
    S.space = { id: 1, name: '我们的小家', invite_code: 'ABC123', owner_id: 'u1' }
    localStorage.removeItem('wbReminded')
    window.__renders = 0
    const origRender = renderTasks
    renderTasks = function () { __renders++; return origRender.apply(this, arguments) }
    cloud.database.from = (table) => {
      if (table === 'spaces') return { select: () => ({ order: async () => ({ data: [S.space], error: null }) }) }
      if (table === 'members') return { select: () => ({ eq: async () => ({ data: S.members, error: null }) }) }
      if (table === 'tasks') return { select: () => ({ eq: async () => ({ order: () => ({ order: async () => ({ data: S.tasks, error: null }) }) }) }) }
      return {}
    }
    cloud.database.rpc = async () => ({ data: 'u1', error: null })
    S.session = { user: { id: 'u1' } }
    Notification = undefined // 模拟 WebView 无通知 API，验证静默降级
  })

  // 场景 1：已逾期任务正确显示"已逾期"
  const past = new Date(Date.now() - 3600 * 1000).toISOString()
  await page.evaluate((p) => { S.tasks = [{ id: 1, space_id: 1, title: '交报告', notes: '', category: 'general', status: 'todo', due_date: p }] }, past)
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 300))
  const r1 = await page.evaluate(() => document.getElementById('taskList').innerHTML.includes('已逾期'))
  check('逾期任务显示已逾期标签', r1)

  // 场景 2：同一分钟内数据不变 → 不重绘（防闪烁仍有效）
  const before = await page.evaluate(() => __renders)
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 200))
  check('同分钟内不重绘', (await page.evaluate(() => __renders)) === before)

  // 场景 3：时间跳过一分钟（模拟跨分钟）→ 自动重绘，逾期状态更新
  await page.evaluate(() => {
    const REAL = Date.now.bind(Date)
    Date.now = () => REAL() + 61 * 1000  // 只影响时间因子，new Date() 对比用真实钟
    S.__realNow = REAL
  })
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 300))
  const r3 = await page.evaluate(() => ({ renders: __renders, realNow: S.__realNow() }))
  check('跨分钟后自动重绘', r3.renders > before, 'renders=' + r3.renders + ' before=' + before)
  await page.evaluate(() => { Date.now = S.__realNow })

  // 场景 4：刚到期的任务触发提醒（toast 一次，记录存本地）
  const justDue = new Date(Date.now() - 5 * 1000).toISOString()
  await page.evaluate((d) => {
    window.__toasts = []
    toast = (m) => __toasts.push(m)
    S.tasks = [{ id: 9, space_id: 1, title: '买菜', notes: '', category: 'shopping', status: 'todo', due_date: d }]
  }, justDue)
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 300))
  const r4 = await page.evaluate(() => ({ toasts: __toasts, saved: localStorage.getItem('wbReminded') }))
  check('到期任务弹出提醒', r4.toasts.some(m => m.includes('买菜')), JSON.stringify(r4.toasts))
  check('已提醒标记写入本地', (r4.saved || '').includes('9_'))

  // 场景 5：再次轮询不重复提醒
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 200))
  check('不重复提醒', (await page.evaluate(() => __toasts.length)) === 1)

  // 场景 6：已完成的到期任务不提醒
  await page.evaluate((d) => {
    localStorage.removeItem('wbReminded')
    S.tasks = [{ id: 10, space_id: 1, title: '已完成事项', notes: '', category: 'general', status: 'done', due_date: d }]
    __toasts = []
  }, justDue)
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 200))
  check('已完成任务不提醒', (await page.evaluate(() => __toasts.length)) === 0)

  // 场景 7：无截止时间任务 → 时间因子为 0，不引入额外重绘
  await page.evaluate(() => { S.tasks = [{ id: 11, space_id: 1, title: '无日期', notes: '', category: 'general', status: 'todo', due_date: null }] })
  await page.evaluate(() => refreshAll())
  const b7 = await page.evaluate(() => __renders)
  await page.evaluate(() => { const REAL = Date.now.bind(Date); Date.now = () => REAL() + 61 * 1000 })
  await page.evaluate(() => refreshAll())
  await page.evaluate(() => { Date.now = S.__realNow })
  check('无日期任务跨分钟不重绘', (await page.evaluate(() => __renders)) === b7)

  await browser.close()
  console.log(failed === 0 ? '\n=== ALL PASS ===' : `\n=== ${failed} FAILED ===`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2) })
