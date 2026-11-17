/* ============================================================
   我们 · 双人待办  —  主逻辑
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
  formCat: 'general',
  formRepeat: 'none',
  pollTimer: null,
  // 日历视图（默认首页为日历）
  view: 'cal',
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth() + 1,
  calSelected: null,
}

const $ = (id) => document.getElementById(id)

/* ---------- 工具 ---------- */
function show(id) { $(id).classList.remove('hidden') }
function hide(id) { $(id).classList.add('hidden') }
function showOnly(...ids) {
  ['loadingScreen','loginScreen','setupScreen','inviteScreen','mainScreen'].forEach(x => {
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
  // 查我所在的第一个空间
  try {
    const rows = unwrap(await cloud.database.from('spaces').select('*').order('created_at', { ascending: true }), '读取空间')
    if (rows && rows.length) {
      S.space = rows[0]
      await enterMain()
      return
    }
  } catch (e) { /* 没有空间，去配对 */ }
  showOnly('setupScreen')
}

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
  renderTasks()
  renderCalendar()
  // 当天面板开着时同步刷新内容
  if (!$('daySheet').classList.contains('hidden') && S.calSelected) openDaySheet(S.calSelected)
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

function visibleTasks() {
  let list = S.tasks
  if (S.cat === 'mine') list = list.filter(t => t.assignee_uid === uidMe())
  else if (S.cat !== 'all') list = list.filter(t => t.category === S.cat)
  // 未完成在前，然后按截止日期
  return list.slice().sort((a,b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1
    if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date)
    if (a.due_date) return -1
    if (b.due_date) return 1
    return new Date(a.created_at) - new Date(b.created_at)
  })
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

  const list = visibleTasks()
  const wrap = $('taskList')
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><div class="e-icon">📝</div>这里还没有任务<br>点右下角 + 添加一件吧</div>`
    return
  }
  wrap.innerHTML = list.map(t => {
    const done = t.status === 'done'
    const assignee = t.assignee_uid ? `<span class="tag assign">👤 ${esc(nameOf(t.assignee_uid))}</span>` : ''
    const repeat = t.repeat_rule && t.repeat_rule !== 'none'
      ? `<span class="tag repeat">↻ ${REPEAT_LABEL[t.repeat_rule] || ''}</span>` : ''
    const lastDone = (t.repeat_rule !== 'none' && t.completed_by)
      ? `<span class="tag">上次 ${esc(nameOf(t.completed_by))} 完成</span>` : ''
    return `<div class="task ${done ? 'done' : ''}" data-id="${t.id}">
      <div class="check" data-act="toggle">${done ? '✓' : ''}</div>
      <div class="task-body" data-act="edit">
        <div class="t-title">${esc(t.title)}</div>
        ${t.notes ? `<div class="t-notes">${esc(t.notes)}</div>` : ''}
        <div class="t-meta">
          <span class="tag cat-${t.category}">${CAT_LABEL[t.category] || '通用'}</span>
          ${assignee}${dueTag(t)}${repeat}${lastDone}
        </div>
      </div>
      <div class="task-tools"><button class="mini" data-act="edit" title="编辑">✎</button></div>
    </div>`
  }).join('')
}

// 分类切换
document.querySelectorAll('#catTabs .cat').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#catTabs .cat').forEach(x => x.classList.remove('on'))
    el.classList.add('on'); S.cat = el.dataset.cat; renderTasks()
  })
})

// 任务列表点击委托
$('taskList').addEventListener('click', (e) => {
  const taskEl = e.target.closest('.task')
  if (!taskEl) return
  const id = Number(taskEl.dataset.id)
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'toggle') toggleTask(id)
  else openTaskSheet(id)
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
  $('settingsInvite').textContent = S.space?.invite_code || '------'
  show('settingsSheet')
})
function closeSettings() { hide('settingsSheet') }

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
// 点长条 → 编辑该日程；点格子其他区域 → 打开当天日程面板
$('calGrid').addEventListener('click', e => {
  const bar = e.target.closest('.cbar')
  if (bar) { openTaskSheet(Number(bar.dataset.id)); return }
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
    hide('daySheet'); openTaskSheet(id)
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
