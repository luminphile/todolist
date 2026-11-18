/* ============================================================
   我们 · 共享待办  —  主逻辑
   基于 WorkBuddy Cloud SDK（Auth + Database）
   ============================================================ */

const cfg = window.APP_CONFIG
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: cfg.endpoint,
  oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
  publishableKey: cfg.publishableKey,
})

// 全局状态
const S = {
  session: null,
  myUid: null,
  space: null,        // { id, name, invite_code, owner_id }
  members: [],        // [{ id, user_uid, nickname, role }]
  tasks: [],          // 任务数组
  cat: 'all',
  pendingOtp: null,   // { phone, verificationId, isExistingUser }
  editId: null,
  noteEditing: false,  // 查看页内容框是否处于编辑态
  imgCache: new Map(), // 便签图片对象路径 → blob URL
  mySpaces: [],        // 我加入的全部空间
  formCat: 'general',
  formRepeat: 'none',
  pollTimer: null,
  // 日历视图（默认首页为日历）
  view: 'cal',
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth() + 1,
  calSelected: null,
  viewId: null,       // 查看弹层当前任务 id
  lastSnap: '',       // 上次渲染的数据快照（防闪烁）
}

const $ = (id) => document.getElementById(id)

/* ---------- 工具 ---------- */
function show(id) { $(id).classList.remove('hidden') }
function hide(id) { $(id).classList.add('hidden') }
function showOnly(...ids) {
  ['loadingScreen','loginScreen','setupScreen','inviteScreen','spacePickerScreen','mainScreen'].forEach(x => {
    if (ids.includes(x)) show(x); else hide(x)
  })
}
let toastTimer
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200)
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}
function uidMe() { return S.myUid }
function nameOf(uid) {
  const m = S.members.find(x => x.user_uid === uid)
  if (!m) return uid === uidMe() ? '我' : '伙伴'
  return m.nickname || (uid === uidMe() ? '我' : '伙伴')
}
function unwrap(res, label) {
  if (res && res.error) { throw new Error(res.error.message || (label + '失败')) }
  return res && res.data
}

/* ============================================================
   启动：会话恢复
   ============================================================ */
async function boot() {
  // 处理 OAuth 回调（微信 / WorkBuddy），虽然主用手机号登录，仍兼容
  const url = new URL(location.href)
  if (url.searchParams.has('code')) {
    const provider = url.searchParams.get('provider')
    const handler = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback
      : provider === 'wechat' ? cloud.auth.handleWechatWebCallback : null
    if (handler) {
      try {
        const r = await handler.call(cloud.auth)
        if (r && r.data) {
          for (const k of ['code','state','provider']) url.searchParams.delete(k)
          history.replaceState(null, '', url.pathname + url.search + url.hash)
        }
      } catch (e) { /* 交给下面 getSession 处理 */ }
    }
  }
  await restoreSession()
}

async function restoreSession() {
  try {
    const { data: session, error } = await cloud.auth.getSession()
    if (error || !session) { showOnly('loginScreen'); return }
    S.session = session
    await afterLogin()
  } catch (e) {
    showOnly('loginScreen')
  }
}

async function afterLogin() {
  // 取当前 uid
  try {
    const r = await cloud.database.rpc('my_uid')
    S.myUid = (r.data || '').toString()
  } catch (e) {
    S.myUid = (S.session.user && S.session.user.id) || ''
  }
  // 查我加入的所有空间（RLS 只返回我是成员的）
  let rows = null
  try {
    rows = unwrap(await cloud.database.from('spaces').select('*').order('created_at', { ascending: true }), '读取空间')
  } catch (e) { rows = null }
  if (rows && rows.length === 1) {
    S.space = rows[0]
    await enterMain()
    return
  }
  if (rows && rows.length > 1) {
    await openPicker()
    return
  }
  $('setupBackBtn').classList.add('hidden')
  showOnly('setupScreen')
}

/* ============================================================
   空间选择（多空间切换）
   ============================================================ */
async function openPicker() {
  stopPolling()
  try {
    S.mySpaces = unwrap(await cloud.database.from('spaces').select('*').order('created_at', { ascending: true }), '读取空间') || []
  } catch (e) { S.mySpaces = S.space ? [S.space] : [] }
  $('spaceList').innerHTML = S.mySpaces.length
    ? S.mySpaces.map(sp => `
      <div class="space-item${S.space && sp.id === S.space.id ? ' cur' : ''}" data-sp="${sp.id}">
        <div><b>${esc(sp.name || '我们的清单')}</b><div class="code">邀请码 ${esc(sp.invite_code || '------')}</div></div>
        <span class="arrow">›</span>
      </div>`).join('')
    : '<div class="hint">还没有加入任何空间</div>'
  showOnly('spacePickerScreen')
}

$('spaceList').addEventListener('click', async (e) => {
  const it = e.target.closest('.space-item')
  if (!it) return
  const sp = S.mySpaces.find(x => String(x.id) === it.dataset.sp)
  if (!sp) return
  S.space = sp
  await enterMain()
})
$('pickCreateBtn').addEventListener('click', () => {
  $('setupBackBtn').classList.remove('hidden')
  document.querySelector('[data-setup="create"]').click()
  showOnly('setupScreen')
})
$('pickJoinBtn').addEventListener('click', () => {
  $('setupBackBtn').classList.remove('hidden')
  document.querySelector('[data-setup="join"]').click()
  showOnly('setupScreen')
})
$('setupBackBtn').addEventListener('click', () => openPicker())

/* ============================================================
   登录（手机号验证码）
   ============================================================ */
$('sendCodeBtn').addEventListener('click', async () => {
  const phone = $('phoneInput').value.trim()
  if (!/^1\d{10}$/.test(phone)) { $('loginErr').textContent = '请输入正确的 11 位手机号'; return }
  const btn = $('sendCodeBtn'); const old = btn.textContent
  btn.disabled = true
  try {
    const sent = await cloud.auth.sendOtp({ phone })
    if (sent.error) { $('loginErr').textContent = sent.error.message || '发送失败'; return }
    S.pendingOtp = { phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser }
    $('loginErr').textContent = ''
    toast('验证码已发送')
    let n = 60
    btn.textContent = n + 's'
    const iv = setInterval(() => {
      n--; if (n <= 0) { clearInterval(iv); btn.disabled = false; btn.textContent = '重新获取' }
      else btn.textContent = n + 's'
    }, 1000)
  } catch (e) {
    $('loginErr').textContent = e.message || '发送失败'
    btn.disabled = false; btn.textContent = old
  }
})

$('loginBtn').addEventListener('click', async () => {
  const phone = $('phoneInput').value.trim()
  const code = $('codeInput').value.trim()
  if (!/^1\d{10}$/.test(phone)) { $('loginErr').textContent = '请输入正确的 11 位手机号'; return }
  if (!S.pendingOtp || S.pendingOtp.phone !== phone) {
    $('loginErr').textContent = '请先获取验证码'; return
  }
  if (!code) { $('loginErr').textContent = '请输入验证码'; return }
  $('loginBtn').disabled = true; $('loginErr').textContent = ''
  try {
    const done = await cloud.auth.verifyOtp({
      phone: S.pendingOtp.phone,
      verificationId: S.pendingOtp.verificationId,
      isExistingUser: S.pendingOtp.isExistingUser,
      token: code,
    })
    if (done.error) { $('loginErr').textContent = done.error.message || '登录失败'; return }
    S.pendingOtp = null
    const { data: session } = await cloud.auth.getSession()
    S.session = session
    await afterLogin()
  } catch (e) {
    $('loginErr').textContent = e.message || '登录失败'
  } finally {
    $('loginBtn').disabled = false
  }
})

/* ============================================================
   配对：创建 / 加入空间
   ============================================================ */
document.querySelectorAll('[data-setup]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-setup]').forEach(t => t.classList.remove('on'))
    tab.classList.add('on')
    const isCreate = tab.dataset.setup === 'create'
    if (isCreate) { show('createPane'); hide('joinPane') }
    else { hide('createPane'); show('joinPane') }
    $('setupErr').textContent = ''
  })
})

$('createSpaceBtn').addEventListener('click', async () => {
  const name = $('spaceName').value.trim() || '我们的清单'
  const nick = $('createNickname').value.trim()
  $('createSpaceBtn').disabled = true; $('setupErr').textContent = ''
  try {
    const r = await cloud.database.rpc('create_space', { p_name: name, p_nickname: nick })
    if (r.error) throw new Error(r.error.message || '创建失败')
    const row = (r.data || [])[0]
    S.space = { id: row.space_id, name: name, invite_code: row.invite_code }
    $('showInviteCode').textContent = row.invite_code
    showOnly('inviteScreen')
  } catch (e) {
    $('setupErr').textContent = e.message || '创建失败'
  } finally { $('createSpaceBtn').disabled = false }
})

$('joinSpaceBtn').addEventListener('click', async () => {
  const code = $('inviteInput').value.trim().toUpperCase()
  const nick = $('joinNickname').value.trim()
  if (code.length < 4) { $('setupErr').textContent = '请输入有效的邀请码'; return }
  $('joinSpaceBtn').disabled = true; $('setupErr').textContent = ''
  try {
    const r = await cloud.database.rpc('join_space', { p_invite_code: code, p_nickname: nick })
    if (r.error) throw new Error(r.error.message || '加入失败')
    const row = (r.data || [])[0]
    S.space = { id: row.space_id, name: row.space_name, invite_code: code }
    await enterMain()
  } catch (e) {
    $('setupErr').textContent = e.message || '加入失败'
  } finally { $('joinSpaceBtn').disabled = false }
})

$('copyInviteBtn').addEventListener('click', async () => {
  const code = $('showInviteCode').textContent
  try {
    await navigator.clipboard.writeText(code)
    toast('邀请码已复制')
  } catch (e) {
    toast('请手动复制：' + code)
  }
})
$('goMainBtn').addEventListener('click', () => enterMain())

/* ============================================================
   进入主界面 + 数据加载
   ============================================================ */
async function enterMain() {
  showOnly('mainScreen')
  $('spaceTitle').textContent = S.space.name || '我们的清单'
  $('topInvite').textContent = S.space.invite_code || '------'
  await refreshAll()
  startPolling()
}

async function refreshAll() {
  await Promise.all([loadMembers(), loadTasks()])
  // 数据没变化就跳过重绘，避免每 4 秒闪烁
  const snap = JSON.stringify([S.tasks, S.members, S.cat])
  if (snap !== S.lastSnap) {
    S.lastSnap = snap
    const st = $('taskList').scrollTop
    renderTasks()
    renderCalendar()
    $('taskList').scrollTop = st
    // 弹层开着时同步刷新内容
    if (!$('daySheet').classList.contains('hidden') && S.calSelected) openDaySheet(S.calSelected)
    if (!$('viewSheet').classList.contains('hidden') && S.viewId && !S.noteEditing) openViewSheet(S.viewId)
  }
  $('memberInfo').textContent = S.members.length + ' 位成员'
}

async function loadMembers() {
  try {
    const rows = unwrap(await cloud.database.from('members').select('*').eq('space_id', S.space.id), '读取成员')
    S.members = rows || []
  } catch (e) { /* 静默，保留旧数据 */ }
}

async function loadTasks() {
  try {
    const rows = unwrap(await cloud.database.from('tasks').select('*')
      .eq('space_id', S.space.id).order('created_at', { ascending: true }), '读取任务')
    S.tasks = rows || []
  } catch (e) { /* 静默，保留旧数据 */ }
}

// 准实时：轮询同步（每 4 秒），页面隐藏时跳过
function startPolling() {
  stopPolling()
  S.pollTimer = setInterval(() => {
    if (document.hidden) return
    refreshAll()
  }, 4000)
}
function stopPolling() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null } }
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.space) refreshAll()
})

/* ============================================================
   任务渲染
   ============================================================ */
function fmtDue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hhmm = d.toTimeString().slice(0,5)
  if (sameDay) return '今天 ' + hhmm
  const tmr = new Date(now); tmr.setDate(tmr.getDate()+1)
  if (d.toDateString() === tmr.toDateString()) return '明天 ' + hhmm
  return (d.getMonth()+1) + '/' + d.getDate() + ' ' + hhmm
}
function dueTag(t) {
  if (!t.due_date || t.status === 'done') return ''
  const d = new Date(t.due_date), now = new Date()
  const diff = d - now
  let cls = '', txt = fmtDue(t.due_date)
  if (diff < 0) { cls = 'due-over'; txt = '已逾期 · ' + txt }
  else if (diff < 24*3600*1000) { cls = 'due-soon'; txt = '即将到期 · ' + txt }
  return `<span class="tag ${cls}">◷ ${esc(txt)}</span>`
}
const REPEAT_LABEL = { none:'', daily:'每天', weekly:'每周', monthly:'每月' }
const CAT_LABEL = { general:'通用', shopping:'购物', schedule:'日程' }

function filteredTasks() {
  let list = S.tasks
  if (S.cat === 'mine') list = list.filter(t => t.assignee_uid === uidMe())
  else if (S.cat !== 'all') list = list.filter(t => t.category === S.cat)
  return list
}

/* 日期分组的友好标签：今天 / 明天 / 本周四（11月19日）/ 下周五（11月20日），
   超过两周直接显示日期 */
const WEEK_CN = '日一二三四五六'
function groupLabel(key) {
  const p = key.split('-').map(Number)
  const d = new Date(p[0], p[1] - 1, p[2])
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const md = p[1] + '月' + p[2] + '日'
  const wd = '周' + WEEK_CN[d.getDay()]
  if (d.getTime() === today.getTime()) return '今天（' + md + '）'
  const tmr = new Date(today); tmr.setDate(tmr.getDate() + 1)
  if (d.getTime() === tmr.getTime()) return '明天（' + md + '）'
  if (d < today) return '已逾期（' + md + '）'
  const dow = (today.getDay() + 6) % 7   // 周一=0
  const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - dow)
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6)
  const nextEnd = new Date(weekEnd); nextEnd.setDate(nextEnd.getDate() + 7)
  if (d <= weekEnd) return '本周' + WEEK_CN[d.getDay()] + '（' + md + '）'
  if (d <= nextEnd) return '下周' + WEEK_CN[d.getDay()] + '（' + md + '）'
  const yr = p[0] !== today.getFullYear() ? p[0] + '年' : ''
  return yr + md + '（' + wd + '）'
}

function taskCardHtml(t) {
  const done = t.status === 'done'
  const assignee = t.assignee_uid ? `<span class="tag assign">👤 ${esc(nameOf(t.assignee_uid))}</span>` : ''
  const repeat = t.repeat_rule && t.repeat_rule !== 'none'
    ? `<span class="tag repeat">↻ ${REPEAT_LABEL[t.repeat_rule] || ''}</span>` : ''
  const lastDone = (t.repeat_rule !== 'none' && t.completed_by)
    ? `<span class="tag">上次 ${esc(nameOf(t.completed_by))} 完成</span>` : ''
  return `<div class="task ${done ? 'done' : ''}" data-id="${t.id}">
      <div class="check" data-act="toggle">${done ? '✓' : ''}</div>
      <div class="task-body" data-act="view">
        <div class="t-title">${esc(t.title)}</div>
        ${t.notes ? `<div class="t-notes">${esc(t.notes)}</div>` : ''}
        <div class="t-meta">
          <span class="tag cat-${t.category}">${CAT_LABEL[t.category] || '通用'}</span>
          ${assignee}${dueTag(t)}${repeat}${lastDone}
        </div>
      </div>
      <div class="task-tools"><button class="mini" data-act="edit" title="编辑">✎</button></div>
    </div>`
}

function renderTasks() {
  // 更新分类计数
  document.querySelectorAll('#catTabs .cat').forEach(el => {
    const c = el.dataset.cat
    let n = S.tasks.length
    if (c === 'mine') n = S.tasks.filter(t => t.assignee_uid === uidMe() && t.status !== 'done').length
    else if (c !== 'all') n = S.tasks.filter(t => t.category === c && t.status !== 'done').length
    else n = S.tasks.filter(t => t.status !== 'done').length
    const base = el.childNodes[0].textContent.replace(/\s*\d+$/,'')
    el.childNodes[0].textContent = base + ' '
    let badge = el.querySelector('.n')
    if (!badge) { badge = document.createElement('span'); badge.className = 'n'; el.appendChild(badge) }
    badge.textContent = n
  })

  const list = filteredTasks()
  const wrap = $('taskList')
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><div class="e-icon">📝</div>这里还没有任务<br>点右下角 + 添加一件吧</div>`
    return
  }

  // 按日期分组：逾期/有日期的按天分组，无日期、已完成单独成组
  const byDate = new Map()
  const noDate = [], doneList = []
  list.forEach(t => {
    if (t.status === 'done') { doneList.push(t); return }
    const k = t.due_date ? dateKeyOf(t.due_date) : ''
    if (!k) { noDate.push(t); return }
    if (!byDate.has(k)) byDate.set(k, [])
    byDate.get(k).push(t)
  })
  const sortByDue = arr => arr.sort((a, b) =>
    (a.due_date ? new Date(a.due_date) : 0) - (b.due_date ? new Date(b.due_date) : 0) ||
    new Date(a.created_at) - new Date(b.created_at))
  byDate.forEach(sortByDue); sortByDue(noDate); sortByDue(doneList)

  const groups = [...byDate.keys()].sort().map(k => ({
    label: groupLabel(k), overdue: groupLabel(k).startsWith('已逾期'), items: byDate.get(k)
  }))
  if (noDate.length) groups.push({ label: '无日期', overdue: false, items: noDate })
  if (doneList.length) groups.push({ label: '已完成', overdue: false, items: doneList })

  wrap.innerHTML = groups.map(g =>
    `<div class="group-head${g.overdue ? ' overdue' : ''}"><span>${esc(g.label)}</span><span class="n">${g.items.length} 项</span></div>`
    + g.items.map(taskCardHtml).join('')
  ).join('')
}

// 分类切换
document.querySelectorAll('#catTabs .cat').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#catTabs .cat').forEach(x => x.classList.remove('on'))
    el.classList.add('on'); S.cat = el.dataset.cat; renderTasks()
  })
})

// 任务列表点击委托：勾选=切换完成，✎=直接编辑，其他区域=查看
$('taskList').addEventListener('click', (e) => {
  const taskEl = e.target.closest('.task')
  if (!taskEl) return
  const id = Number(taskEl.dataset.id)
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'toggle') toggleTask(id)
  else if (act === 'edit') openTaskSheet(id)
  else openViewSheet(id)
})

/* ============================================================
   查看任务弹层（便签式内容：点击内容框直接编辑，支持清单勾选）
   内容存储为纯文本 notes，行首标记：
   「☐ 」= 未完成清单项，「☑ 」= 已完成清单项，「• 」= 项目符号
   ============================================================ */
function renderNotePreview() {
  const t = S.tasks.find(x => x.id === S.viewId)
  if (!t) return
  const box = $('vContent')
  box.classList.remove('editing')
  box.contentEditable = 'false'
  const notes = t.notes || ''
  if (!notes.trim()) {
    box.innerHTML = '<div class="v-note-tip">点这里写点补充内容～<br>输入「☐ +空格」开头可创建清单项，<br>完成后点前面的方框勾选划掉</div>'
    box.classList.add('placeholder')
    return
  }
  box.classList.remove('placeholder')
  box.innerHTML = notes.split('\n').map((line, i) => {
    const m = line.match(/^([☐☑•])\s?(.*)$/)
    if (!m) {
      const im = line.match(/^!\[img\]\((.+)\)$/)
      if (im) return `<div class="vnl vimg-row"><img class="vimg" data-src="${esc(im[1])}" alt="图片"></div>`
      return `<div class="vnl">${esc(line) || '<br>'}</div>`
    }
    if (m[1] === '•') return `<div class="vnl vbullet">• ${esc(m[2]) || '<br>'}</div>`
    const done = m[1] === '☑'
    return `<div class="vnl vck${done ? ' done' : ''}">` +
      `<span class="vchk" data-line="${i}">${done ? '✓' : ''}</span>` +
      `<span class="vchk-text">${esc(m[2]) || '（空）'}</span></div>`
  }).join('')
  // 图片加载：http/data 直接显示；对象路径经 SDK 鉴权下载为 blob
  box.querySelectorAll('.vimg[data-src]').forEach(el => {
    const ref = el.dataset.src
    if (/^(https?:|data:)/.test(ref)) { el.src = ref; el.classList.add('ok') }
    else loadNoteImage(ref, el)
  })
}

function enterNoteEdit() {
  const t = S.tasks.find(x => x.id === S.viewId)
  if (!t) return
  S.noteEditing = true
  const box = $('vContent')
  box.classList.add('editing')
  box.classList.remove('placeholder')
  box.contentEditable = 'true'
  box.textContent = t.notes || ''
  $('noteBar').classList.remove('hidden')
  box.focus()
  setCaretOffset(box, box.textContent.length)
}

// 退出编辑态；save=true 时把当前文本保存到数据库
function exitNoteEdit(save) {
  if (!S.noteEditing) return
  S.noteEditing = false
  const t = S.tasks.find(x => x.id === S.viewId)
  const box = $('vContent')
  const notes = box.textContent.replace(/\u00a0/g, ' ').replace(/\n+$/, '')
  box.contentEditable = 'false'
  $('noteBar').classList.add('hidden')
  if (t && save && notes !== (t.notes || '')) {
    saveNoteText(t, notes)
  } else {
    renderNotePreview()
  }
}

async function saveNoteText(t, notes) {
  t.notes = notes // 乐观更新本地，立即重绘
  renderNotePreview()
  try {
    const r = await cloud.database.from('tasks')
      .update({ notes, updated_at: new Date().toISOString() }).eq('id', t.id).select()
    if (r.error) throw new Error(r.error.message)
    await refreshAll()
  } catch (e) { toast(e.message || '保存失败') }
  // refreshAll 后若查看页还开着，保持预览态
  if (!$('viewSheet').classList.contains('hidden')) renderNotePreview()
}

// 勾选 / 取消勾选清单项（不影响任务整体完成状态）
async function toggleNoteLine(lineIdx) {
  const t = S.tasks.find(x => x.id === S.viewId)
  if (!t) return
  const lines = (t.notes || '').split('\n')
  const m = lines[lineIdx] && lines[lineIdx].match(/^([☐☑])\s?(.*)$/)
  if (!m) return
  lines[lineIdx] = (m[1] === '☑' ? '☐' : '☑') + ' ' + m[2]
  await saveNoteText(t, lines.join('\n'))
}

// 光标偏移工具（编辑态工具条用）
function caretOffset(el) {
  const sel = window.getSelection()
  if (!sel.rangeCount) return -1
  const r = sel.getRangeAt(0).cloneRange()
  r.selectNodeContents(el)
  r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset)
  return r.toString().length
}
function setCaretOffset(el, off) {
  const sel = window.getSelection()
  if (!sel.rangeCount) return
  const r = document.createRange()
  let cur = 0
  let done = false
  const walk = (node) => {
    if (done) return
    if (node.nodeType === 3) {
      if (cur + node.length >= off) {
        r.setStart(node, off - cur); r.collapse(true); done = true
      } else cur += node.length
    } else {
      for (const c of node.childNodes) walk(c)
    }
  }
  walk(el)
  if (!done) { r.selectNodeContents(el); r.collapse(false) }
  sel.removeAllRanges(); sel.addRange(r)
}

// 在光标处插入任意文本（支持多行，如图片标记）
function insertAtCaretText(str) {
  const box = $('vContent')
  if (!S.noteEditing) enterNoteEdit()
  box.focus()
  let off = caretOffset(box)
  if (off < 0) off = box.textContent.length
  const text = box.textContent
  const newText = text.slice(0, off) + str + text.slice(off)
  box.textContent = newText
  setCaretOffset(box, off + str.length)
}

// 在光标所在行行首插入标记（清单 ☐ / 项目符号 •）
function insertNoteMark(mark) {
  const box = $('vContent')
  if (!S.noteEditing) enterNoteEdit()
  box.focus()
  let off = caretOffset(box)
  if (off < 0) off = box.textContent.length
  const text = box.textContent
  const lineStart = text.lastIndexOf('\n', Math.max(0, off - 1)) + 1
  let lineEnd = text.indexOf('\n', off)
  if (lineEnd < 0) lineEnd = text.length
  const line = text.slice(lineStart, lineEnd)
  const content = line.replace(/^[☐☑•]\s?/, '')
  const newLine = mark + (content ? ' ' + content : '')
  const newText = text.slice(0, lineStart) + newLine + text.slice(lineEnd)
  box.textContent = newText
  setCaretOffset(box, lineStart + mark.length + 1)
}

/* 图片上传：压缩后传到云存储 task-images，插入 ![img](url) 标记 */
async function compressImage(file) {
  if (file.type === 'image/gif' || file.size < 400 * 1024) return file
  const img = await new Promise((res, rej) => {
    const url = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => { URL.revokeObjectURL(url); res(im) }
    im.onerror = rej
    im.src = url
  })
  const MAX = 1280
  let w = img.width, h = img.height
  if (Math.max(w, h) > MAX) { const k = MAX / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k) }
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  cv.getContext('2d').drawImage(img, 0, 0, w, h)
  return await new Promise(res => cv.toBlob(b => res(b || file), 'image/jpeg', 0.75))
}

async function uploadNoteImage(file, isRetry) {
  if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return }
  const btn = $('noteImgBtn'); btn.disabled = true
  if (!isRetry) toast('图片上传中…')
  try {
    const blob = await compressImage(file)
    const ext = blob.type === 'image/png' ? 'png' : 'jpg'
    const name = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext
    // 平台存储只支持 runtime 桶：shared/<uid>/... 所有登录成员可读，仅本人可写
    const path = cloud.storage.sharedPath(uidMe(), 'notes/' + name)
    const up = await cloud.storage.upload(path, blob, { contentType: blob.type })
    if (up.error) throw new Error(up.error.message || '上传失败')
    // 本地立即显示
    S.imgCache.set(path, URL.createObjectURL(blob))
    // 独立成行插入（notes 存对象路径，查看时经 SDK 鉴权下载）
    insertAtCaretText('\n![img](' + path + ')\n')
    toast('图片已插入')
  } catch (e) {
    const msg = e.message || ''
    // 网络抖动自动重试一次
    if (!isRetry && /fetch|network|abort/i.test(msg)) {
      toast('网络不稳，自动重试…')
      await new Promise(r => setTimeout(r, 1200))
      btn.disabled = false
      return uploadNoteImage(file, true)
    }
    if (/fetch|network/i.test(msg)) toast('网络请求失败，请检查电脑的网络/代理设置后重试')
    else toast(msg || '图片上传失败')
  }
  finally { btn.disabled = false }
}

// 渲染时把图片标记加载为可显示的 blob URL
async function loadNoteImage(path, el) {
  if (S.imgCache.has(path)) { el.src = S.imgCache.get(path); el.classList.add('ok'); return }
  try {
    const r = await cloud.storage.download(path)
    if (r.error || !r.data) return
    const url = URL.createObjectURL(r.data)
    S.imgCache.set(path, url)
    el.src = url
    el.classList.add('ok')
  } catch (e) { /* 保持占位样式 */ }
}

function openViewSheet(id) {
  if (S.noteEditing) exitNoteEdit(true) // 打开前先保存未完成的编辑
  const t = S.tasks.find(x => x.id === id)
  if (!t) return
  S.viewId = id
  $('vTitle').textContent = t.title
  renderNotePreview()
  const metaRows = [
    ['分类', CAT_LABEL[t.category] || '通用'],
    ['指派给', t.assignee_uid
      ? `<span style="color:${colorOf(t.assignee_uid)};font-weight:600">● ${esc(nameOf(t.assignee_uid))}</span>`
      : '<span style="color:var(--muted)">未指派</span>'],
    ['截止', t.due_date ? `${esc(groupLabel(dateKeyOf(t.due_date)))} ${esc(new Date(t.due_date).toTimeString().slice(0,5))}` : '不限定'],
    ['重复', t.repeat_rule && t.repeat_rule !== 'none' ? REPEAT_LABEL[t.repeat_rule] : '不重复'],
    ['状态', t.status === 'done' ? '已完成' : '进行中'],
  ]
  $('vMeta').innerHTML = metaRows.map(([k, v]) =>
    `<div class="k">${k}</div><div class="v">${v}</div>`).join('')

  const toggleBtn = $('vToggle')
  toggleBtn.textContent = t.status === 'done' ? '取消完成' : '标记完成'
  toggleBtn.classList.toggle('ghost', t.status !== 'done')
  show('viewSheet')
}

// 查看页点击：灯箱放大图片 → 勾选方框 → toggle；其他内容区域 → 进入编辑
$('viewSheet').addEventListener('click', (e) => {
  const img = e.target.closest('.vimg')
  if (img && img.src) { $('lbImg').src = img.src; show('imgLb'); return }
  const chk = e.target.closest('.vchk')
  if (chk) { toggleNoteLine(Number(chk.dataset.line)); return }
  if (e.target.closest('#vContent') && !S.noteEditing) { enterNoteEdit(); return }
  if (e.target.closest('#noteBar')) return
  if (e.target.closest('#vToggle') || e.target.closest('#vEdit')) return
  closeOnMask(e)
})
$('imgLb').addEventListener('click', () => hide('imgLb'))

// 编辑工具条：按钮用 mousedown 阻止失焦，点击后再操作
$('noteChkBtn').addEventListener('mousedown', e => e.preventDefault())
$('noteChkBtn').addEventListener('click', () => insertNoteMark('☐'))
$('noteBulletBtn').addEventListener('mousedown', e => e.preventDefault())
$('noteBulletBtn').addEventListener('click', () => insertNoteMark('•'))
$('noteImgBtn').addEventListener('click', () => $('noteImgInput').click())
$('noteImgInput').addEventListener('change', () => {
  const f = $('noteImgInput').files[0]
  $('noteImgInput').value = ''
  if (f) uploadNoteImage(f)
})
$('noteDoneBtn').addEventListener('click', () => exitNoteEdit(true))

// 失焦自动保存（焦点移出弹层时）
$('vContent').addEventListener('blur', () => {
  if (!S.noteEditing) return
  setTimeout(() => {
    if (!S.noteEditing) return
    const ae = document.activeElement
    if (ae && $('viewSheet').contains(ae)) return
    exitNoteEdit(true)
  }, 150)
})

// 粘贴时只保留纯文本
$('vContent').addEventListener('paste', (e) => {
  e.preventDefault()
  const text = (e.clipboardData || window.clipboardData).getData('text/plain')
  const sel = window.getSelection()
  if (sel.rangeCount) {
    sel.getRangeAt(0).deleteContents()
    sel.getRangeAt(0).insertNode(document.createTextNode(text))
  }
})

$('vEdit').addEventListener('click', () => {
  if (S.noteEditing) exitNoteEdit(true)
  hide('viewSheet'); openTaskSheet(S.viewId)
})
$('vToggle').addEventListener('click', async () => {
  if (S.noteEditing) exitNoteEdit(true)
  await toggleTask(S.viewId)
  if (!$('viewSheet').classList.contains('hidden')) openViewSheet(S.viewId)
})

/* ============================================================
   任务编辑弹层
   ============================================================ */
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const off = d.getTimezoneOffset() * 60000
  return new Date(d - off).toISOString().slice(0,16)
}
function openTaskSheet(id) {
  S.editId = id || null
  $('taskSheetTitle').textContent = id ? '编辑任务' : '添加任务'
  const t = id ? S.tasks.find(x => x.id === id) : null
  $('fTitle').value = t ? t.title : ''
  $('fNotes').value = t ? (t.notes || '') : ''
  $('fDue').value = t ? toLocalInput(t.due_date) : ''
  // 指派下拉
  const sel = $('fAssignee')
  sel.innerHTML = '<option value="">不指派</option>' + S.members.map(m =>
    `<option value="${esc(m.user_uid)}">${esc(m.nickname || (m.user_uid === uidMe() ? '我' : '伙伴'))}${m.user_uid === uidMe() ? '（我）' : ''}</option>`
  ).join('')
  sel.value = t ? (t.assignee_uid || '') : (uidMe() || '')
  // 分类 / 重复
  S.formCat = t ? t.category : 'general'
  S.formRepeat = t ? (t.repeat_rule || 'none') : 'none'
  document.querySelectorAll('#catSeg .opt').forEach(o => o.classList.toggle('on', o.dataset.v === S.formCat))
  document.querySelectorAll('#repeatSeg .opt').forEach(o => o.classList.toggle('on', o.dataset.v === S.formRepeat))
  $('deleteTaskBtn').classList.toggle('hidden', !id)
  show('taskSheet')
}
function closeTaskSheet() { hide('taskSheet'); S.editId = null }

function closeOnMask(e) {
  if (e.target.classList.contains('sheet-mask')) e.target.classList.add('hidden')
}
$('taskSheet').addEventListener('click', closeOnMask)
$('settingsSheet').addEventListener('click', closeOnMask)

document.querySelectorAll('#catSeg .opt').forEach(o => o.addEventListener('click', () => {
  S.formCat = o.dataset.v
  document.querySelectorAll('#catSeg .opt').forEach(x => x.classList.toggle('on', x === o))
}))
document.querySelectorAll('#repeatSeg .opt').forEach(o => o.addEventListener('click', () => {
  S.formRepeat = o.dataset.v
  document.querySelectorAll('#repeatSeg .opt').forEach(x => x.classList.toggle('on', x === o))
}))

$('fabBtn').addEventListener('click', () => {
  openTaskSheet(null)
  if (S.view === 'cal' && S.calSelected) $('fDue').value = S.calSelected + 'T09:00'
})

$('saveTaskBtn').addEventListener('click', async () => {
  const title = $('fTitle').value.trim()
  if (!title) { toast('请输入任务内容'); return }
  const payload = {
    title,
    notes: $('fNotes').value.trim(),
    category: S.formCat,
    assignee_uid: $('fAssignee').value || null,
    due_date: $('fDue').value ? new Date($('fDue').value).toISOString() : null,
    repeat_rule: S.formRepeat,
    updated_at: new Date().toISOString(),
  }
  const btn = $('saveTaskBtn'); btn.disabled = true
  try {
    if (S.editId) {
      const r = await cloud.database.from('tasks').update(payload).eq('id', S.editId).select()
      if (r.error) throw new Error(r.error.message)
    } else {
      payload.space_id = S.space.id
      const r = await cloud.database.from('tasks').insert(payload).select()
      if (r.error) throw new Error(r.error.message)
    }
    closeTaskSheet(); toast('已保存'); await refreshAll()
  } catch (e) { toast(e.message || '保存失败') }
  finally { btn.disabled = false }
})

$('deleteTaskBtn').addEventListener('click', async () => {
  if (!S.editId) return
  if (!confirm('确定删除这条任务吗？')) return
  try {
    const r = await cloud.database.from('tasks').delete().eq('id', S.editId).select()
    if (r.error) throw new Error(r.error.message)
    closeTaskSheet(); toast('已删除'); await refreshAll()
  } catch (e) { toast(e.message || '删除失败') }
})

// 完成 / 取消完成；循环任务完成后自动推进到下一个周期
function nextDue(iso, rule) {
  const base = iso ? new Date(iso) : new Date()
  const d = new Date(base)
  if (rule === 'daily') d.setDate(d.getDate() + 1)
  else if (rule === 'weekly') d.setDate(d.getDate() + 7)
  else if (rule === 'monthly') d.setMonth(d.getMonth() + 1)
  else return null
  return d.toISOString()
}

async function toggleTask(id) {
  const t = S.tasks.find(x => x.id === id)
  if (!t) return
  const now = new Date().toISOString()
  let payload
  if (t.status === 'done') {
    payload = { status: 'todo', completed_at: null, completed_by: null, updated_at: now }
  } else if (t.repeat_rule && t.repeat_rule !== 'none') {
    // 循环任务：记录本次完成，并推进截止日到下一周期，回到未完成
    payload = { completed_at: now, completed_by: uidMe(), due_date: nextDue(t.due_date, t.repeat_rule), updated_at: now }
    toast('完成啦！下次已自动安排')
  } else {
    payload = { status: 'done', completed_at: now, completed_by: uidMe(), updated_at: now }
  }
  // 乐观更新
  Object.assign(t, payload)
  renderTasks()
  try {
    const r = await cloud.database.from('tasks').update(payload).eq('id', id).select()
    if (r.error) throw new Error(r.error.message)
  } catch (e) { toast(e.message || '操作失败'); await refreshAll() }
}

/* ============================================================
   设置
   ============================================================ */
$('settingsBtn').addEventListener('click', () => {
  $('nickInput').value = (S.members.find(m => m.user_uid === uidMe())?.nickname) || ''
  $('settingsSpaceName').textContent = S.space?.name || '------'
  $('settingsInvite').textContent = S.space?.invite_code || '------'
  show('settingsSheet')
})
function closeSettings() { hide('settingsSheet') }

$('switchSpaceBtn').addEventListener('click', () => {
  closeSettings()
  openPicker()
})

$('leaveSpaceBtn').addEventListener('click', async () => {
  if (!S.space) return
  if (!confirm(`确定退出空间「${S.space.name}」吗？\n退出后将不再看到该空间的清单和日程，重新加入需要邀请码。`)) return
  try {
    const r = await cloud.database.from('members').delete()
      .eq('space_id', S.space.id).eq('user_uid', uidMe())
    if (r.error) throw new Error(r.error.message || '退出失败')
    // 我是创建者且成员只剩我一个 → 连空间一起删除，不留空壳
    if (S.space.owner_id === uidMe() && S.members.length <= 1) {
      try {
        await cloud.database.from('spaces').delete().eq('id', S.space.id)
      } catch (e) { /* 删除空间失败不影响退出 */ }
    }
    stopPolling()
    S.space = null
    S.tasks = []
    S.members = []
    S.lastSnap = null
    closeSettings()
    toast('已退出空间')
    await openPicker()
  } catch (e) { toast(e.message || '退出失败') }
})

$('saveNickBtn').addEventListener('click', async () => {
  const nick = $('nickInput').value.trim()
  if (!nick) { toast('请输入昵称'); return }
  try {
    const r = await cloud.database.from('members')
      .update({ nickname: nick }).eq('space_id', S.space.id).eq('user_uid', uidMe()).select()
    if (r.error) throw new Error(r.error.message)
    await loadMembers(); closeSettings(); toast('昵称已更新')
  } catch (e) { toast(e.message || '保存失败') }
})

$('logoutBtn').addEventListener('click', async () => {
  if (!confirm('确定退出登录吗？')) return
  stopPolling()
  try { await cloud.auth.signOut() } catch (e) {}
  location.reload()
})

/* ============================================================
   日历视图（农历 / 节气 / 节假日 / 调休 / 负责人配色）
   ============================================================ */
const MEMBER_COLORS = ['#6366f1','#ec4899','#14b8a6','#f59e0b','#8b5cf6','#ef4444','#0ea5e9']

function colorOf(uid) {
  if (!uid) return '#cbd5e1'
  const i = S.members.findIndex(m => m.user_uid === uid)
  return MEMBER_COLORS[(i < 0 ? 0 : i) % MEMBER_COLORS.length]
}
function pad2(n) { return String(n).padStart(2, '0') }
function dateKeyOf(v) {
  if (!v) return ''
  const d = new Date(v)
  if (isNaN(d.getTime())) return ''
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// 单日的农历 / 节日 / 调休信息（来自 lunar-javascript）
function dayInfo(y, m, d) {
  let solar, lunar, holiday
  try {
    solar = Solar.fromYmd(y, m, d)
    lunar = solar.getLunar()
    holiday = HolidayUtil.getHoliday(y, m, d)
  } catch (e) {
    return { label: '', badge: '', fest: false, weekend: false }
  }
  const week = solar.getWeek() % 7  // 0=周日
  const weekend = week === 0 || week === 6
  let label = '', fest = false
  if (holiday && !holiday.isWork()) {
    label = holiday.getName() || '节假日'; fest = true
  } else if (holiday && holiday.isWork()) {
    // 调休上班日照常显示农历，角标标"班"
    label = lunar.getMonthInChinese() + '月' + lunar.getDayInChinese()
  } else {
    const lf = lunar.getFestivals() || []
    const sf = solar.getFestivals() || []
    const jq = lunar.getJieQi() || ''
    if (lf.length) { label = lf[0]; fest = true }
    else if (sf.length) { label = sf[0]; fest = true }
    else if (jq) { label = jq; fest = true }
    else {
      const ld = lunar.getDayInChinese()
      label = ld === '初一' ? (lunar.getMonthInChinese() + '月') : ld
    }
  }
  let badge = ''
  if (holiday) badge = holiday.isWork() ? '班' : '休'
  return { label, badge, fest, weekend }
}

function tasksOn(key) { return S.tasks.filter(t => dateKeyOf(t.due_date) === key) }

function renderCalendar() {
  const grid = $('calGrid')
  if (!grid) return
  const y = S.calYear, m = S.calMonth
  $('calTitle').textContent = y + '年' + m + '月'
  const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7  // 周一 = 0
  const days = new Date(y, m, 0).getDate()
  const prevDays = new Date(y, m - 1, 0).getDate()
  const cells = Math.ceil((firstDow + days) / 7) * 7
  const todayKey = dateKeyOf(new Date().toISOString())
  let html = ''
  for (let i = 0; i < cells; i++) {
    let yy = y, mm = m, dd, inMonth = true
    if (i < firstDow) {
      dd = prevDays - firstDow + 1 + i; mm = m - 1
      if (mm < 1) { mm = 12; yy-- }
      inMonth = false
    } else if (i >= firstDow + days) {
      dd = i - firstDow - days + 1; mm = m + 1
      if (mm > 12) { mm = 1; yy++ }
      inMonth = false
    } else dd = i - firstDow + 1

    const key = yy + '-' + pad2(mm) + '-' + pad2(dd)
    const info = dayInfo(yy, mm, dd)
    const list = tasksOn(key)
    // 飞书式彩色长条：显示日程名，按负责人着色
    const bars = list.slice(0, 2).map(t =>
      `<div class="cbar${t.status === 'done' ? ' done' : ''}" style="background:${colorOf(t.assignee_uid)}" title="${esc(t.title)}" data-id="${t.id}">${esc(t.title)}</div>`
    ).join('') + (list.length > 2 ? `<div class="more-bar">+${list.length - 2} 项</div>` : '')
    const numStyle = (info.fest || info.weekend) ? ' style="color:#dc2626"' : ''
    html += `<div class="cal-cell${inMonth ? '' : ' out'}${key === todayKey ? ' today' : ''}" data-date="${key}">
      <div class="cell-top"><span class="dnum"${numStyle}>${dd}</span>${info.badge ? `<span class="hbadge ${info.badge === '休' ? 'rest' : 'work'}">${info.badge}</span>` : ''}</div>
      <div class="lunar${info.fest ? ' fest' : ''}">${esc(info.label)}</div>
      ${bars}
    </div>`
  }
  grid.innerHTML = html

  // 图例按成员配色
  $('calLegend').innerHTML = S.members.map(m =>
    `<span class="lg"><i style="background:${colorOf(m.user_uid)}"></i>${esc(m.nickname || (m.user_uid === uidMe() ? '我' : '伙伴'))}</span>`
  ).join('') + '<span class="lg"><i style="background:#cbd5e1"></i>未指派</span>'
}

function shiftMonth(n) {
  let m = S.calMonth + n, y = S.calYear
  if (m < 1) { m = 12; y-- }
  if (m > 12) { m = 1; y++ }
  S.calMonth = m; S.calYear = y
  renderCalendar()
}

function setView(v) {
  S.view = v
  document.querySelectorAll('#bottomNav .nav-item').forEach(x => x.classList.toggle('on', x.dataset.view === v))
  $('listView').classList.toggle('hidden', v !== 'list')
  $('calView').classList.toggle('hidden', v !== 'cal')
  if (v === 'cal') renderCalendar()
  else hide('daySheet')
}

// 当天日程面板：列表可勾选/编辑，底部可添加
function openDaySheet(key) {
  S.calSelected = key
  const p = key.split('-').map(Number)
  const info = dayInfo(p[0], p[1], p[2])
  let weekTxt = ''
  try { weekTxt = ' · 周' + '日一二三四五六'[Solar.fromYmd(p[0], p[1], p[2]).getWeek() % 7] } catch (e) {}
  $('daySheetTitle').textContent = p[1] + '月' + p[2] + '日' + weekTxt + (info.badge ? ' · ' + info.badge : '')
  const list = tasksOn(key)
  $('dayTaskList').innerHTML = list.length ? list.map(t => {
    const done = t.status === 'done'
    return `<div class="day-task" data-id="${t.id}">
      <div class="dt-check${done ? ' done' : ''}" data-act="toggle">${done ? '✓' : ''}</div>
      <div class="dt-body" data-act="edit">
        <div class="dt-bar" style="background:${colorOf(t.assignee_uid)}">${esc(t.assignee_uid ? nameOf(t.assignee_uid) : '未指派')}</div>
        <div class="dt-title${done ? ' done' : ''}">${esc(t.title)}</div>
        ${t.notes ? `<div class="dt-meta">${esc(t.notes)}</div>` : ''}
      </div>
    </div>`
  }).join('') : '<div class="empty" style="padding:34px 20px">这一天还没有安排</div>'
  show('daySheet')
}

// 日历事件绑定
document.querySelectorAll('#bottomNav .nav-item').forEach(el => {
  el.addEventListener('click', () => setView(el.dataset.view))
})
$('calPrev').addEventListener('click', () => shiftMonth(-1))
$('calNext').addEventListener('click', () => shiftMonth(1))
$('calToday').addEventListener('click', () => {
  const d = new Date(); S.calYear = d.getFullYear(); S.calMonth = d.getMonth() + 1; renderCalendar()
})
// 点长条 → 查看该日程；点格子其他区域 → 打开当天日程面板
$('calGrid').addEventListener('click', e => {
  const bar = e.target.closest('.cbar')
  if (bar) { openViewSheet(Number(bar.dataset.id)); return }
  const cell = e.target.closest('.cal-cell')
  if (!cell) return
  openDaySheet(cell.dataset.date)
})
$('daySheet').addEventListener('click', closeOnMask)
$('dayTaskList').addEventListener('click', async e => {
  const row = e.target.closest('.day-task')
  if (!row) return
  const id = Number(row.dataset.id)
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'toggle') {
    await toggleTask(id)
    if (S.calSelected) openDaySheet(S.calSelected)
  } else if (act === 'edit') {
    hide('daySheet'); openViewSheet(id)
  }
})
$('addTaskForDay').addEventListener('click', () => {
  hide('daySheet'); openTaskSheet(null)
  if (S.calSelected) $('fDue').value = S.calSelected + 'T09:00'
})

/* ============================================================
   启动
   ============================================================ */
boot()
