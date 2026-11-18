// 多空间切换验证
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

  // mock：登录态 + 两个空间
  await page.evaluate(() => {
    S.myUid = 'u1'
    S.members = [{ id: 1, user_uid: 'u1', nickname: '我' }]
    S.tasks = []
    const SPACES = [
      { id: 1, name: '我们的小家', invite_code: 'ABC123', created_at: '2026-11-01' },
      { id: 2, name: '项目协作', invite_code: 'XYZ789', created_at: '2026-11-10' },
    ]
    cloud.database.from = (table) => {
      if (table === 'spaces') return {
        select: () => ({ order: async () => ({ data: SPACES.map(s => ({ ...s })), error: null }) }),
      }
      if (table === 'members') return {
        select: () => ({ eq: async () => ({ data: [{ id: 1, user_uid: 'u1', nickname: '我', space_id: 1 }], error: null }) }),
      }
      if (table === 'tasks') return {
        select: () => ({ eq: async () => ({ order: () => ({ order: async () => ({ data: [], error: null }) }) }) }),
      }
      return {}
    }
    cloud.database.rpc = async (fn) => {
      if (fn === 'my_uid') return { data: 'u1', error: null }
      return { data: null, error: null }
    }
    S.session = { user: { id: 'u1' } }
  })

  // 1. 多空间登录 → 进选择器
  await page.evaluate(() => afterLogin())
  await new Promise(r => setTimeout(r, 400))
  const r1 = await page.evaluate(() => ({
    pickerVisible: !document.getElementById('spacePickerScreen').classList.contains('hidden'),
    items: document.querySelectorAll('#spaceList .space-item').length,
    names: [...document.querySelectorAll('#spaceList .space-item b')].map(b => b.textContent),
  }))
  check('多空间登录进入选择器', r1.pickerVisible && r1.items === 2, JSON.stringify(r1))
  check('列表显示空间名与邀请码', r1.names.join(',') === '我们的小家,项目协作')

  // 2. 点第二个空间 → 进主界面
  await page.click('#spaceList .space-item[data-sp="2"]')
  await new Promise(r => setTimeout(r, 500))
  const r2 = await page.evaluate(() => ({
    main: !document.getElementById('mainScreen').classList.contains('hidden'),
    title: document.getElementById('spaceTitle').textContent,
  }))
  check('点击空间进入主界面', r2.main && r2.title === '项目协作', JSON.stringify(r2))

  // 3. 设置 → 切换空间
  await page.evaluate(() => { show('settingsSheet') })
  await page.evaluate(() => document.getElementById('switchSpaceBtn').click())
  await new Promise(r => setTimeout(r, 400))
  const r3 = await page.evaluate(() => ({
    picker: !document.getElementById('spacePickerScreen').classList.contains('hidden'),
    cur: document.querySelector('#spaceList .space-item.cur b')?.textContent,
  }))
  check('设置里切换空间打开选择器', r3.picker && r3.cur === '项目协作', JSON.stringify(r3))

  // 4. 选择器 → 加入其他空间 → setup（带返回键）→ 返回
  await page.evaluate(() => document.getElementById('pickJoinBtn').click())
  await new Promise(r => setTimeout(r, 200))
  const r4 = await page.evaluate(() => ({
    setup: !document.getElementById('setupScreen').classList.contains('hidden'),
    joinPane: !document.getElementById('joinPane').classList.contains('hidden'),
    back: !document.getElementById('setupBackBtn').classList.contains('hidden'),
  }))
  check('跳到加入空间页且显示返回键', r4.setup && r4.joinPane && r4.back, JSON.stringify(r4))
  await page.evaluate(() => document.getElementById('setupBackBtn').click())
  await new Promise(r => setTimeout(r, 300))
  check('返回键回到选择器', await page.evaluate(() => !document.getElementById('spacePickerScreen').classList.contains('hidden')))

  // 5. 单空间登录 → 直接进主界面（不经过选择器）
  await page.evaluate(() => {
    const ONE = [{ id: 1, name: '我们的小家', invite_code: 'ABC123', created_at: '2026-11-01' }]
    cloud.database.from = (t) => t === 'spaces'
      ? { select: () => ({ order: async () => ({ data: ONE.map(s => ({ ...s })), error: null }) }) }
      : { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
  })
  await page.evaluate(() => afterLogin())
  await new Promise(r => setTimeout(r, 400))
  const r5 = await page.evaluate(() => ({
    main: !document.getElementById('mainScreen').classList.contains('hidden'),
    title: document.getElementById('spaceTitle').textContent,
  }))
  check('单空间登录直接进主界面', r5.main && r5.title === '我们的小家', JSON.stringify(r5))

  // 6. 零空间登录 → 配对页且无返回键
  await page.evaluate(() => {
    cloud.database.from = (t) => t === 'spaces'
      ? { select: () => ({ order: async () => ({ data: [], error: null }) }) }
      : { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
  })
  await page.evaluate(() => afterLogin())
  await new Promise(r => setTimeout(r, 300))
  const r6 = await page.evaluate(() => ({
    setup: !document.getElementById('setupScreen').classList.contains('hidden'),
    back: !document.getElementById('setupBackBtn').classList.contains('hidden'),
  }))
  check('无空间进配对页且无返回键', r6.setup && !r6.back, JSON.stringify(r6))

  await page.screenshot({ path: 'shot-picker.png' })
  await browser.close()
  console.log(failed === 0 ? '\n=== ALL PASS ===' : `\n=== ${failed} FAILED ===`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2) })
