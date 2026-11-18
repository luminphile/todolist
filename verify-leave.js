// 退出空间功能验证
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

  // mock：可变空间列表，删除成员/空间会真实影响列表
  const setupMock = (spaces) => page.evaluate((sp) => {
    S.myUid = 'u1'
    S.session = { user: { id: 'u1' } }
    window.__calls = []
    const SPACES = sp.map(s => ({ ...s }))
    cloud.database.from = (table) => {
      if (table === 'spaces') return {
        select: () => ({ order: async () => ({ data: SPACES.map(s => ({ ...s })), error: null }) }),
        delete: () => ({ eq: async (k, v) => {
          const i = SPACES.findIndex(s => s.id === v)
          if (i >= 0) SPACES.splice(i, 1)
          __calls.push(['deleteSpace', v]); return { error: null }
        } }),
      }
      if (table === 'members') return {
        select: () => ({ eq: async () => ({ data: [{ id: 1, user_uid: 'u1', nickname: '我', space_id: SPACES[0]?.id || 1 }], error: null }) }),
        delete: () => {
          let sid = null
          return { eq: (k, v) => { sid = v; return { eq: async () => {
            const i = SPACES.findIndex(s => s.id === sid)
            if (i >= 0) SPACES.splice(i, 1)
            __calls.push(['deleteMember', sid]); return { error: null }
          } } } }
        },
      }
      return {}
    }
    cloud.database.rpc = async () => ({ data: 'u1', error: null })
    window.confirm = () => true
  }, spaces)

  const openSettings = () => page.evaluate(() => {
    S.members = [{ id: 1, user_uid: 'u1', nickname: '我' }]
    document.getElementById('settingsBtn').click()
  })

  // 场景 A：普通成员退出，还有其他空间
  await setupMock([
    { id: 1, name: '我们的小家', invite_code: 'ABC123', owner_id: 'u2', created_at: '2026-11-01' },
    { id: 2, name: '项目协作', invite_code: 'XYZ789', owner_id: 'u1', created_at: '2026-11-10' },
  ])
  await page.evaluate(() => { S.space = { id: 1, name: '我们的小家', invite_code: 'ABC123', owner_id: 'u2' } })
  await openSettings()
  await new Promise(r => setTimeout(r, 200))
  const sa = await page.evaluate(() => ({
    name: document.getElementById('settingsSpaceName').textContent,
    code: document.getElementById('settingsInvite').textContent,
  }))
  check('设置页显示当前空间与邀请码', sa.name === '我们的小家' && sa.code === 'ABC123', JSON.stringify(sa))
  await page.evaluate(() => document.getElementById('leaveSpaceBtn').click())
  await new Promise(r => setTimeout(r, 500))
  const rb = await page.evaluate(() => ({
    calls: __calls,
    picker: !document.getElementById('spacePickerScreen').classList.contains('hidden'),
    settingsClosed: document.getElementById('settingsSheet').classList.contains('hidden'),
    spaceCleared: S.space === null,
    items: document.querySelectorAll('#spaceList .space-item').length,
  }))
  check('退出仅删成员记录不动空间', rb.calls.some(c => c[0] === 'deleteMember') && !rb.calls.some(c => c[0] === 'deleteSpace'), JSON.stringify(rb.calls))
  check('退出后进空间选择器', rb.picker && rb.spaceCleared && rb.settingsClosed, JSON.stringify(rb))
  check('选择器显示剩余空间', rb.items === 1, 'items=' + rb.items)

  // 场景 B：创建者退出且只剩自己 → 连空间一起删
  await setupMock([{ id: 1, name: '我的独享', invite_code: 'QWE456', owner_id: 'u1' }])
  await page.evaluate(() => { S.space = { id: 1, name: '我的独享', invite_code: 'QWE456', owner_id: 'u1' } })
  await openSettings()
  await page.evaluate(() => document.getElementById('leaveSpaceBtn').click())
  await new Promise(r => setTimeout(r, 500))
  const rc = await page.evaluate(() => ({
    calls: __calls,
    picker: !document.getElementById('spacePickerScreen').classList.contains('hidden'),
    empty: document.getElementById('spaceList').textContent.includes('还没有加入任何空间'),
  }))
  check('创建者单人空间连空间一起删', rc.calls.some(c => c[0] === 'deleteMember') && rc.calls.some(c => c[0] === 'deleteSpace'), JSON.stringify(rc.calls))
  check('退出后选择器为空提示', rc.picker && rc.empty, JSON.stringify(rc))

  // 场景 C：拒绝确认 → 什么都不发生
  await setupMock([{ id: 1, name: '我的独享', invite_code: 'QWE456', owner_id: 'u1' }])
  await page.evaluate(() => {
    window.confirm = () => false
    S.space = { id: 1, name: '我的独享', invite_code: 'QWE456', owner_id: 'u1' }
    __calls = []
  })
  await openSettings()
  await page.evaluate(() => document.getElementById('leaveSpaceBtn').click())
  await new Promise(r => setTimeout(r, 300))
  const rd = await page.evaluate(() => ({ calls: __calls, settingsOpen: !document.getElementById('settingsSheet').classList.contains('hidden'), spaceKept: !!S.space }))
  check('取消确认不执行退出', rd.calls.length === 0 && rd.settingsOpen && rd.spaceKept, JSON.stringify(rd))

  await browser.close()
  console.log(failed === 0 ? '\n=== ALL PASS ===' : `\n=== ${failed} FAILED ===`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2) })
