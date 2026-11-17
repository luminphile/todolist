// 便签式查看/编辑功能验证（不依赖真实登录，注入演示数据）
const puppeteer = require('puppeteer-core')

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:8899/index.html'
let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('PASS ' + name)
  else { failed++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--ssl-no-revoke', '--lang=zh-CN'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 1500))

  // 注入演示数据 + 打开查看页
  await page.evaluate(() => {
    S.myUid = 'u1'
    S.members = [
      { id: 1, user_uid: 'u1', nickname: '我' },
      { id: 2, user_uid: 'u2', nickname: '对象' },
    ]
    S.space = { id: 1, name: '测试空间' }
    S.tasks = [{
      id: 101, space_id: 1, title: '买菜',
      notes: '☐ 牛奶\n☑ 面包\n• 水果\n备注一下',
      category: 'shopping', assignee_uid: 'u2',
      due_date: null, repeat_rule: 'none', status: 'todo',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }]
    S.noteEditing = false
    openViewSheet(101)
  })
  await new Promise(r => setTimeout(r, 300))

  // 1. 查看页渲染：无编辑记录区
  check('弹层可见', await page.evaluate(() => !document.getElementById('viewSheet').classList.contains('hidden')))
  check('编辑记录已删除', await page.evaluate(() => !document.getElementById('vLog')))
  check('标题正确', await page.evaluate(() => document.getElementById('vTitle').textContent === '买菜'))

  // 2. 清单项渲染：勾选方框 + 划线
  const r2 = await page.evaluate(() => {
    const box = document.getElementById('vContent')
    const checks = box.querySelectorAll('.vnl.vck')
    const bullets = box.querySelectorAll('.vnl.vbullet')
    const plain = box.querySelectorAll('.vnl:not(.vck):not(.vbullet)')
    const doneFirst = box.querySelector('.vnl.vck.done .vchk-text')
    const notDone = checks[0]
    return {
      nChecks: checks.length, nBullets: bullets.length, nPlain: plain.length,
      firstChkText: notDone.querySelector('.vchk-text').textContent,
      doneText: doneFirst && doneFirst.textContent,
      doneHasStrike: !!doneFirst,
      chkVisible: !!notDone.querySelector('.vchk'),
    }
  })
  check('2 个清单项', r2.nChecks === 2, String(r2.nChecks))
  check('1 个项目符号行', r2.nBullets === 1, String(r2.nBullets))
  check('1 个普通文本行', r2.nPlain === 1, String(r2.nPlain))
  check('未完成项文字 = 牛奶', r2.firstChkText === '牛奶', r2.firstChkText)
  check('已完成项文字 = 面包（划线样式类）', r2.doneText === '面包' && r2.doneHasStrike)

  // 3. 点击未完成方框 → 勾选切换（乐观更新，保存失败不影响 UI）
  await page.evaluate(() => { __errs = []; window.addEventListener('error', e => __errs.push(e.message)) })
  await page.click('.vnl.vck .vchk')
  await new Promise(r => setTimeout(r, 600))
  const r3 = await page.evaluate(() => ({
    notes: S.tasks[0].notes,
    doneCount: document.querySelectorAll('#vContent .vnl.vck.done').length,
  }))
  check('勾选后 notes 变 ☑ 牛奶', r3.notes.startsWith('☑ 牛奶'), r3.notes)
  check('勾选后渲染 2 个 done 项', r3.doneCount === 2, String(r3.doneCount))
  // 再点同一个方框取消勾选
  await page.click('#vContent .vnl.vck .vchk')
  await new Promise(r => setTimeout(r, 600))
  check('再点取消勾选', await page.evaluate(() => S.tasks[0].notes.startsWith('☐ 牛奶')))

  // 4. 点击内容框（文字区域）→ 进入编辑态
  await page.click('#vContent .vnl.vbullet')
  await new Promise(r => setTimeout(r, 300))
  const r4 = await page.evaluate(() => ({
    editing: document.getElementById('vContent').contentEditable,
    noteBarShown: !document.getElementById('noteBar').classList.contains('hidden'),
    text: document.getElementById('vContent').textContent,
  }))
  check('点击内容进入编辑态', r4.editing === 'true', r4.editing)
  check('编辑工具条出现', r4.noteBarShown)
  check('编辑态显示原始标记', r4.text.includes('☐ 牛奶') && r4.text.includes('• 水果'))

  // 5. 工具条按钮：光标放在普通行「备注一下」内插入 ☐
  await page.evaluate(() => { setCaretOffset(document.getElementById('vContent'), document.getElementById('vContent').textContent.length) })
  await page.click('#noteChkBtn')
  const r5 = await page.evaluate(() => document.getElementById('vContent').textContent)
  check('「清单项」按钮给普通行加 ☐', r5.endsWith('☐ 备注一下'), JSON.stringify(r5))

  // 6. 输入新文本 + 点「完成」→ 保存并回到预览态
  await page.evaluate(() => {
    const box = document.getElementById('vContent')
    box.textContent = '☐ 酱油\n☑ 纸巾\n• 顺便取快递'
  })
  await page.click('#noteDoneBtn')
  await new Promise(r => setTimeout(r, 600))
  const r6 = await page.evaluate(() => ({
    notes: S.tasks[0].notes,
    editing: document.getElementById('vContent').contentEditable,
    noteBarHidden: document.getElementById('noteBar').classList.contains('hidden'),
    doneCount: document.querySelectorAll('#vContent .vnl.vck.done').length,
    bulletCount: document.querySelectorAll('#vContent .vnl.vbullet').length,
  }))
  check('「完成」保存 notes', r6.notes === '☐ 酱油\n☑ 纸巾\n• 顺便取快递', JSON.stringify(r6.notes))
  check('「完成」退出编辑态', r6.editing === 'false' && r6.noteBarHidden)
  check('保存后预览渲染正确', r6.doneCount === 1 && r6.bulletCount === 1)

  // 7. 空内容 placeholder
  await page.evaluate(() => {
    S.tasks[0].notes = ''
    S.noteEditing = false
    renderNotePreview()
  })
  const r7 = await page.evaluate(() => ({
    ph: document.getElementById('vContent').classList.contains('placeholder'),
    editable: document.getElementById('vContent').contentEditable,
  }))
  check('空内容显示提示文字', r7.ph && r7.editable === 'false')

  const errs = await page.evaluate(() => __errs)
  check('无页面 JS 错误', errs.length === 0, errs.join(' ; '))

  await page.screenshot({ path: 'verify-note.png' })
  await browser.close()
  console.log(failed === 0 ? '\n=== ALL PASS ===' : `\n=== ${failed} FAILED ===`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2) })
