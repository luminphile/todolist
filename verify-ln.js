// 系统级提醒（Capacitor LocalNotifications）调度逻辑验证
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

  // mock Capacitor 原生桥
  await page.evaluate(() => {
    window.__ln = { channel: null, scheduled: [], canceled: [], permAsked: 0, tapHandlers: [] }
    window.Capacitor = {
      Plugins: {
        LocalNotifications: {
          createChannel: async (c) => { __ln.channel = c },
          checkPermissions: async () => ({ display: 'prompt' }),
          requestPermissions: async () => { __ln.permAsked++; return { display: 'granted' } },
          getPending: async () => ({
            notifications: __ln.scheduled.map(n => ({
              id: n.id,
              schedule: { at: typeof n.schedule.at === 'string' ? n.schedule.at : n.schedule.at.toISOString() },
            })),
          }),
          schedule: async ({ notifications }) => { __ln.scheduled.push(...notifications.map(n => JSON.parse(JSON.stringify(n)))); return { notifications } },
          cancel: async ({ notifications }) => {
            const ids = notifications.map(n => n.id)
            __ln.canceled.push(...ids)
            __ln.scheduled = __ln.scheduled.filter(n => !ids.includes(n.id))
          },
          addListener: (ev, cb) => { __ln.tapHandlers.push(cb); return { remove: () => {} } },
        },
      },
    }
    S.myUid = 'u1'
    S.members = [{ id: 1, user_uid: 'u1', nickname: '我' }]
    S.space = { id: 1, name: '我们的小家', invite_code: 'ABC123', owner_id: 'u1' }
    cloud.database.from = (table) => {
      if (table === 'spaces') return { select: () => ({ order: async () => ({ data: [S.space], error: null }) }) }
      if (table === 'members') return { select: () => ({ eq: async () => ({ data: S.members, error: null }) }) }
      if (table === 'tasks') return { select: () => ({ eq: async () => ({ order: () => ({ order: async () => ({ data: S.tasks, error: null }) }) }) }) }
      return {}
    }
    cloud.database.rpc = async () => ({ data: 'u1', error: null })
    S.session = { user: { id: 'u1' } }
    localStorage.removeItem('wbReminded')
    Notification = undefined
  })

  const in30min = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  await page.evaluate((d) => {
    S.tasks = [{ id: 5, space_id: 1, title: '开会', notes: '', category: 'schedule', status: 'todo', due_date: d }]
  }, in30min)

  // 进主界面：应建渠道 + 请求权限 + 注册提醒
  await page.evaluate(() => enterMain())
  await new Promise(r => setTimeout(r, 600))
  const r1 = await page.evaluate(() => ({
    channel: __ln.channel,
    perm: __ln.permAsked,
    sched: __ln.scheduled,
  }))
  check('创建高优先级通知渠道', r1.channel && r1.channel.id === 'task-alerts' && r1.channel.importance === 5, JSON.stringify(r1.channel))
  check('请求通知权限', r1.perm === 1)
  check('未来任务注册系统提醒', r1.sched.length === 1 && r1.sched[0].id === 5 &&
    Math.abs(new Date(r1.sched[0].schedule.at).getTime() - new Date(in30min).getTime()) < 2000 &&
    r1.sched[0].channelId === 'task-alerts' && r1.sched[0].schedule.allowWhileIdle === true &&
    r1.sched[0].body.includes('开会'), JSON.stringify(r1.sched))

  // 数据不变再刷新 → 不重复注册（对账跳过）
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 400))
  const r2 = await page.evaluate(() => __ln.scheduled.length)
  check('对账后不重复注册', r2 === 1, 'count=' + r2)

  // 改期 → 取消旧的 + 注册新的
  const in60min = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  await page.evaluate((d) => { S.tasks[0].due_date = d }, in60min)
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 400))
  const r3 = await page.evaluate(() => ({
    canceled: __ln.canceled, scheduled: __ln.scheduled,
  }))
  check('改期时取消旧提醒并注册新提醒', r3.canceled.includes(5) &&
    r3.scheduled.length === 1 && r3.scheduled[0].id === 5 &&
    Math.abs(new Date(r3.scheduled[0].schedule.at).getTime() - new Date(in60min).getTime()) < 2000, JSON.stringify(r3))

  // 标记完成 → 取消提醒
  await page.evaluate(() => { S.tasks[0].status = 'done' })
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 400))
  const r4 = await page.evaluate(() => ({ canceled: __ln.canceled, scheduled: __ln.scheduled }))
  check('完成后取消系统提醒', r4.scheduled.length === 0 && r4.canceled.filter(c => c === 5).length >= 2, JSON.stringify(r4))

  // 过期任务不注册（走页面内 toast）
  const past = new Date(Date.now() - 3600 * 1000).toISOString()
  await page.evaluate((d) => {
    S.tasks = [{ id: 7, space_id: 1, title: '过期事项', notes: '', category: 'general', status: 'todo', due_date: d }]
    window.__toasts = []
    toast = (m) => __toasts.push(m)
  }, past)
  await page.evaluate(() => refreshAll())
  await new Promise(r => setTimeout(r, 400))
  const r5 = await page.evaluate(() => ({ sched: __ln.scheduled.filter(n => n.id === 7), toasts: __toasts }))
  check('过期任务不注册系统提醒', r5.sched.length === 0, JSON.stringify(r5.sched))
  check('过期任务弹页面内提醒', r5.toasts.some(m => m.includes('过期事项')), JSON.stringify(r5.toasts))

  // 点通知 → 打开对应任务
  const tid = await page.evaluate(() => {
    S.tasks = [{ id: 7, space_id: 1, title: '过期事项', notes: '', category: 'general', status: 'todo', due_date: '2026-11-25T10:00:00Z' }]
    return new Promise(res => {
      __ln.tapHandlers.push(cb => cb({ notification: { extra: { taskId: 7 } } }))
      // 手动触发已注册的 handler
      setTimeout(() => { if (__ln.tapHandlers.length) __ln.tapHandlers[__ln.tapHandlers.length - 1]({ notification: { extra: { taskId: 7 } } }); res(!document.getElementById('viewSheet').classList.contains('hidden') && document.getElementById('vTitle').textContent === '过期事项') }, 100)
    })
  })
  check('点系统通知打开对应任务', tid === true)

  await browser.close()
  console.log(failed === 0 ? '\n=== ALL PASS ===' : `\n=== ${failed} FAILED ===`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2) })
