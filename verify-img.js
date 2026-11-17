// 图片功能验证：渲染、灯箱、上传按钮
const puppeteer = require('puppeteer-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('PASS ' + name)
  else { failed++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}
// 1x1 红色 gif
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP/yH5BAAAAALAAAAAABAAEAAAIBRAA7'
;(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--lang=zh-CN'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await page.goto('http://localhost:8899/index.html', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 1500))
  await page.evaluate(() => {
    S.myUid = 'u1'
    S.members = [{ id: 1, user_uid: 'u1', nickname: '我' }]
    S.space = { id: 1 }
    S.noteEditing = false
    S.tasks = [{ id: 201, space_id: 1, title: '买菜', notes: '☐ 牛奶\n![img](' + GIF_URL_PLACEHOLDER + ')\n• 水果', category: 'shopping', status: 'todo' }]
    openViewSheet(201)
  }).catch(() => {})
  // GIF 常量需要在 evaluate 内可用，改为传参
  await browser.close()

  // 重来：用 evaluate 参数传 URL
  failed = 0
  const browser2 = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--lang=zh-CN'] })
  const page2 = await browser2.newPage()
  await page2.setViewport({ width: 390, height: 844, isMobile: true })
  await page2.goto('http://localhost:8899/index.html', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 1500))
  await page2.evaluate((gif) => {
    S.myUid = 'u1'
    S.members = [{ id: 1, user_uid: 'u1', nickname: '我' }]
    S.space = { id: 1 }
    S.noteEditing = false
    S.tasks = [{ id: 201, space_id: 1, title: '买菜', notes: '☐ 牛奶\n![img](' + gif + ')\n• 水果', category: 'shopping', status: 'todo' }]
    openViewSheet(201)
  }, GIF)
  await new Promise(r => setTimeout(r, 300))

  check('图片按钮存在', await page2.evaluate(() => !!document.getElementById('noteImgBtn') && !document.getElementById('noteImgInput').type.includes('hidden') || !!document.getElementById('noteImgInput')))
  const r1 = await page2.evaluate(() => ({
    imgs: document.querySelectorAll('#vContent .vimg').length,
    src: document.querySelector('#vContent .vimg')?.src.slice(0, 30),
    notText: !document.getElementById('vContent').textContent.includes('![img]'),
  }))
  check('图片行渲染为 <img>', r1.imgs === 1, JSON.stringify(r1))
  check('标记文本未原样显示', r1.notText)

  // 灯箱
  await page2.click('#vContent .vimg')
  await new Promise(r => setTimeout(r, 200))
  const r2 = await page2.evaluate(() => ({
    shown: !document.getElementById('imgLb').classList.contains('hidden'),
    src: document.getElementById('lbImg').src.slice(0, 30),
  }))
  check('点击图片打开灯箱', r2.shown && r2.src.startsWith('data:image/gif'), JSON.stringify(r2))
  await page2.click('#imgLb')
  await new Promise(r => setTimeout(r, 200))
  check('点击灯箱关闭', await page2.evaluate(() => document.getElementById('imgLb').classList.contains('hidden')))

  // 编辑态中标记可见可编辑
  await page2.click('#vContent .vnl.vbullet')
  await new Promise(r => setTimeout(r, 200))
  const r3 = await page2.evaluate(() => document.getElementById('vContent').textContent.includes('![img]('))
  check('编辑态显示图片标记', r3)

  // 上传函数存在且图片标记插入逻辑（无登录态只测 insertAtCaretText）
  await page2.evaluate(() => {
    document.getElementById('vContent').textContent = 'A\nB'
    setCaretOffset(document.getElementById('vContent'), 1) // 第一行 A 后
    insertAtCaretText('\n![img](https://x/y.jpg)\n')
  })
  const r4 = await page2.evaluate(() => document.getElementById('vContent').textContent)
  check('光标处插入图片标记', r4 === 'A\n![img](https://x/y.jpg)\n\nB', JSON.stringify(r4))

  await page2.screenshot({ path: 'shot-img.png' })
  await browser2.close()
  console.log(failed === 0 ? '\n=== ALL PASS ===' : `\n=== ${failed} FAILED ===`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2) })
