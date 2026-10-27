// 스태프 웹. 화면은 스태프 앱(flutter/apps/staff/lib/ui)과 같게, 서버·규칙도 같게:
// - catalog.json(관리자 게시)으로 공연/구역/대기줄 (standing_core catalog.dart 와 같은 해석)
// - 스태프 코드: resolve_staff_code RPC 로 공연을 찾고, 이 브라우저에만 저장
// - 안내: send_notice RPC + push-notice 함수, notices 최근 24시간 + Realtime (다른 스태프가 보낸 것도 보인다)
'use strict';

const CONFIG = {
  supabaseUrl: 'https://mmtztegnfkaypvzqtfey.supabase.co',
  supabaseKey: 'sb_publishable_z1uQaHe35HwpYPhA8pokew_Y4JeKgYn',
  catalogUrl: 'https://mmtztegnfkaypvzqtfey.supabase.co/storage/v1/object/public/catalog/catalog.json',
};
// 로컬 확인용: localhost 에서만 ?catalog=… 로 다른 catalog.json 을 쓴다
if (location.hostname === 'localhost') {
  const c = new URLSearchParams(location.search).get('catalog');
  if (c) CONFIG.catalogUrl = c;
}

const db = window.supabase ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey) : null;
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');

// ───────── 저장 (이 브라우저에만) ─────────

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('sqs.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('sqs.' + key, JSON.stringify(value)); } catch { /* 사생활 보호 모드 등 */ }
  },
};

const state = {
  events: [],
  /** 공연 코드 → 확인된 스태프 코드 */
  staffCodes: store.get('staffCodes', {}),
  lastRefresh: null,
  refreshError: null,
  /** 현재 공연의 안내 (최신순) */
  notices: [],
  noticesError: null,
  // 공연 추가
  loginError: null,
  loginBusy: false,
  // 안내 보내기 (console.dart 상태)
  kind: 'info',     // 안내 종류는 고르지 않고 항상 직접 입력 (console.dart _kind)
  zone: null,      // 구역 이름 (null = 공연 전체)
  queue: null,     // 대기줄 이름 (null = 구역 전체)
  useRange: false,
  sending: false,
  sendError: null,
  /** 아래 탭 (console.dart _tab): 'entry' = 입장 관리, 'notice' = 안내 보내기 + 보낸 안내 */
  tab: 'entry',
};

// ───────── 안내 종류 (notice.dart NoticeKind) ─────────

const KINDS = {
  moveBack: { title: '뒤로 이동', message: '대기줄이 밀렸습니다. 뒤로 이동해 주세요.', icon: 'arrow_circle_left', color: 'var(--orange)' },
  moveForward: { title: '앞으로 이동', message: '앞 공간이 비었습니다. 앞으로 이동해 주세요.', icon: 'arrow_circle_right', color: 'var(--accent)' },
  entryReady: { title: '입장 준비', message: '곧 입장합니다. 티켓과 신분증을 준비해 주세요.', icon: 'door_front', color: 'var(--accent)' },
  entryOpen: { title: '입장 시작', message: '입장이 시작되었습니다. 티켓을 준비하고 안내에 따라 입장해 주세요.', icon: 'login', color: 'var(--accent)', state: true },
  entryClosed: { title: '입장 마감', message: '입장이 마감되어 더 이상 입장할 수 없습니다.', icon: 'block', color: 'var(--red)', state: true },
  entryDone: { title: '입장 완료', message: '입장이 완료되었습니다.', icon: 'check_circle', color: 'var(--accent)', state: true, silent: true },
  entryTime: { title: '입장 시간 변경', message: '', icon: 'more_time', color: 'var(--accent)' },
  showTime: { title: '공연 시간 변경', message: '', icon: 'theater_comedy', color: 'var(--accent)' },
  info: { title: '안내', message: '', icon: 'campaign', color: 'var(--accent)' },
};
const kind = (k) => KINDS[k] || KINDS.info;

// ───────── 카탈로그 (standing_core catalog.dart 와 같은 해석) ─────────

/** "2026-10-03 18:00" / "2026-10-03" 은 한국 시간, 그 외는 ISO 8601 */
function parseDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(String(raw).trim());
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - 9, +(m[5] || 0)));
  return new Date(raw);
}

/** min~max 를 count 개로 균등 분할, 나머지는 앞 줄부터 1개씩 */
function autoSplit(min, max, count) {
  if (count <= 0 || min > max) return [];
  const total = max - min + 1, n = Math.min(count, total), base = Math.floor(total / n), extra = total % n;
  const out = [];
  let cur = min;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push({ name: `${i + 1}번 줄`, min: cur, max: cur + size - 1, order: i, admission: null });
    cur += size;
  }
  return out;
}

function parseCatalog(text) {
  const root = JSON.parse(text);
  const events = [];
  for (const e of root.events || []) {
    const code = String(e.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code) || events.some((x) => x.code === code)) continue;
    const zones = (e.zones || []).map((z) => {
      const admission = z.admission ? parseDate(z.admission) : null;
      if (z.type === 'seated') return { name: z.name || '', seated: true, min: 0, max: 0, queues: [], admission };
      const queues = Array.isArray(z.queues)
        ? z.queues.map((q, i) => ({ name: q.name || `${i + 1}번 줄`, min: q.min, max: q.max, order: i, admission: q.admission ? parseDate(q.admission) : null }))
        : autoSplit(z.min, z.max, z.queueCount || 1);
      return { name: z.name || '', seated: false, min: z.min, max: z.max, queues, admission };
    });
    events.push({ code, title: e.title || '', date: parseDate(e.date), venue: e.venue || '', zones });
  }
  return events.sort((a, b) => a.date - b.date);
}

async function refreshCatalog() {
  const cached = store.get('catalog', null);
  if (cached && !state.events.length) { try { state.events = parseCatalog(cached); } catch { /* 깨진 캐시는 무시 */ } }
  try {
    const res = await fetch(CONFIG.catalogUrl + '?t=' + Math.floor(Date.now() / 1000), { cache: 'no-store' });
    if (!res.ok) throw new Error('서버 응답 ' + res.status);
    const text = await res.text();
    state.events = parseCatalog(text);
    store.set('catalog', text);
    state.lastRefresh = new Date();
    state.refreshError = null;
  } catch (err) {
    state.refreshError = String(err.message || err);
  }
  render();
}

const eventByCode = (code) => state.events.find((e) => e.code === code);
/** 공연 시작 후 하루가 지나면 만료 (관객·스태프 앱에서 사라진다) */
const isPast = (e) => e.date.getTime() + 24 * 3600e3 < Date.now();
/** 이 브라우저에서 코드가 확인된 공연 (첫 화면 목록) */
const myEvents = () => state.events.filter((e) => state.staffCodes[e.code] && !isPast(e));

// ───────── 스태프 코드 (store.dart enter / logout) ─────────

async function enter(raw) {
  const code = raw.trim();
  if (!code) return [null, '스태프 코드를 입력해 주세요.'];
  if (!db) return [null, '안내 서버가 설정되지 않았습니다.'];
  let eventCode;
  try {
    const { data, error } = await db.rpc('resolve_staff_code', { p_staff_code: code });
    if (error) throw error;
    eventCode = typeof data === 'string' && data ? data.toUpperCase() : null;
  } catch (err) {
    return [null, `서버에 연결할 수 없습니다. (${err.message || err})`];
  }
  if (!eventCode) return [null, '스태프 코드가 맞지 않습니다.'];
  // 새로 등록된 공연이면 목록에 아직 없을 수 있다 → 한 번 새로고침
  if (!eventByCode(eventCode)) await refreshCatalog();
  const e = eventByCode(eventCode);
  if (!e) return [null, `코드는 맞지만 공연 목록에 ${eventCode} 공연이 없습니다. 잠시 후 다시 시도해 주세요.`];
  if (isPast(e)) return [null, '이미 끝난 공연입니다.'];
  state.staffCodes[eventCode] = code;
  store.set('staffCodes', state.staffCodes);
  return [eventCode, null];
}

function logout(code) {
  delete state.staffCodes[code];
  store.set('staffCodes', state.staffCodes);
  stopNotices();
}

// ───────── 안내 (store.dart startNotices / send) ─────────

let channel = null, watching = null, reconnectTimer = null;
const fromRow = (r) => ({
  id: r.id, code: String(r.event_code).toUpperCase(), zone: r.zone, queue: r.queue, min: r.min_number, max: r.max_number,
  kind: r.kind, message: r.message || '', at: new Date(r.created_at).getTime(),
  entryAt: r.entry_at ? new Date(r.entry_at).getTime() : null,
});

function insertNotice(n) {
  if (state.notices.some((x) => x.id === n.id)) return;
  state.notices.unshift(n);
  state.notices.sort((a, b) => b.at - a.at);
  renderLive();
}

/** 스태프가 취소한 안내 (Realtime DELETE 는 공연을 가려 주지 못해 id 만 온다 — 모르는 id 는 무시) */
function removeNotice(id) {
  const before = state.notices.length;
  state.notices = state.notices.filter((n) => n.id !== id);
  if (state.notices.length !== before) renderLive();
}

async function startNotices(code) {
  if (watching === code) return;
  stopNotices();
  if (!db) return;
  watching = code;
  try {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const { data, error } = await db.from('notices').select().eq('event_code', code).gte('created_at', since).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    if (watching !== code) return;
    state.notices = (data || []).map(fromRow);
    state.noticesError = null;
  } catch (err) {
    state.noticesError = String(err.message || err);
  }
  renderLive();
  if (watching !== code) return;
  channel = db.channel('notices:' + code)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notices', filter: `event_code=eq.${code}` }, (payload) => insertNotice(fromRow(payload.new)))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'notices' }, (payload) => { if (payload.old?.id) removeNotice(payload.old.id); })
    .subscribe((status) => {
      // 끊기면 5초 뒤 다시 붙는다
      if ((status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') && watching === code) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { if (watching === code) { watching = null; startNotices(code); } }, 5000);
      }
    });
}

function stopNotices() {
  watching = null;
  clearTimeout(reconnectTimer);
  if (channel && db) db.removeChannel(channel);
  channel = null;
  state.notices = [];
}

/** 안내 발송. 성공하면 목록에 바로 반영 (실시간 이벤트가 오면 중복 제거). */
async function send(e, { kind: k, message, zone = null, queue = null, min = null, max = null, entryAt = null }) {
  if (!db) throw new Error('안내 서버가 설정되지 않았습니다.');
  const staffCode = state.staffCodes[e.code];
  if (!staffCode) throw new Error('스태프 코드가 맞지 않습니다.');
  const params = { p_event_code: e.code, p_staff_code: staffCode, p_kind: k, p_message: message, p_zone: zone, p_queue: queue, p_min_number: min, p_max_number: max };
  if (entryAt) params.p_entry_at = new Date(entryAt).toISOString();
  const { data, error } = await db.rpc('send_notice', params);
  if (error) throw new Error(error.code === '28000' ? '스태프 코드가 맞지 않습니다. 주최 측에 확인해 주세요.' : error.message);
  const row = Array.isArray(data) ? data[0] : data;
  // 앱이 꺼져 있는 관객에게도 가도록 푸시를 부탁한다 (입장 완료처럼 조용한 안내는 제외)
  if (!kind(k).silent) db.functions.invoke('push-notice', { body: { notice_id: row.id } }).catch(() => {});
  insertNotice(fromRow(row));
}

/** 보낸 안내 취소 (store.dart cancel): 서버에서 지우고, 정정 안내를 쓰면 같은 대상에게 이어서 보낸다 */
async function cancelNotice(e, n, correction) {
  if (!db) throw new Error('안내 서버가 설정되지 않았습니다.');
  const staffCode = state.staffCodes[e.code];
  if (!staffCode) throw new Error('스태프 코드가 맞지 않습니다.');
  const { error } = await db.rpc('cancel_notice', { p_event_code: e.code, p_staff_code: staffCode, p_id: n.id });
  if (error) throw new Error(error.code === '28000' ? '스태프 코드가 맞지 않습니다. 주최 측에 확인해 주세요.' : error.message);
  removeNotice(n.id);
  if (correction) await send(e, { kind: 'info', message: correction, zone: n.zone, queue: n.queue, min: n.min, max: n.max });
}

// ───────── 입장 상태·시각 (store.dart entryState / entryStart / showStart) ─────────

const latest = (list) => list.reduce((a, n) => (a == null || n.at >= a.at ? n : a), null);

/** 이 대기줄(지정석이면 구역, q 는 null)의 현재 입장 상태 = 입장 시작/마감/완료 중 가장 최근 것 */
const entryState = (z, q) => latest(state.notices.filter((n) => kind(n.kind).state && (!n.zone || n.zone === z.name) && (!n.queue || n.queue === q?.name)))?.kind ?? null;

/** 관리자가 정한 입장 시각: 줄만 따로 > 구역 */
const plannedEntry = (z, q) => (q?.admission || z.admission)?.getTime() ?? null;

/** 입장 예정 시각(ms): 스태프가 조정한 것(가장 최근 입장 시간 변경) > 관리자가 정한 줄 시각 > 구역 시각 */
const entryStart = (z, q) => latest(state.notices.filter((n) => n.kind === 'entryTime' && n.entryAt && (!n.zone || n.zone === z.name) && (!n.queue || n.queue === q?.name)))?.entryAt ?? plannedEntry(z, q);

/** 대기줄마다 입장 예정 시각이 다른지 (다르면 시간 조정을 줄마다 한다) */
const entryStartsDiffer = (z) => !z.seated && new Set(z.queues.map((q) => entryStart(z, q))).size > 1;

/** 공연 시작(ms): 스태프가 조정한 것(가장 최근 공연 시간 변경) > 관리자가 정한 시각 */
const showStart = (e) => latest(state.notices.filter((n) => n.kind === 'showTime' && n.entryAt && n.code === e.code && !n.zone))?.entryAt ?? e.date.getTime();

/** "입장 시간이 10분 늦춰졌습니다. 새 입장 예정: 오후 6:10" (notice.dart entryTimeChangeText / showTimeChangeText) */
function timeChangeText(from, to, show) {
  const mins = Math.round((to - from) / 60e3);
  const amount = remainingText(Math.abs(mins) * 60e3);
  const what = show ? '공연 시간이' : '입장 시간이';
  const head = mins > 0 ? `${what} ${amount} 늦춰졌습니다.` : mins < 0 ? `${what} ${amount} 당겨졌습니다.` : `${what} 확정되었습니다.`;
  return `${head} ${show ? '새 공연 시작' : '새 입장 예정'}: ${timeShort(new Date(to))}`;
}

// ───────── 표시 도우미 ─────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
/** Material 아이콘. variant: '' (filled) · 'outlined' · 'round' */
const ic = (name, variant = '', size) => `<span class="mi material-icons${variant ? '-' + variant : ''}"${size ? ` style="font-size:${size}px"` : ''}>${name}</span>`;
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');
/** "9월 21일 (일) 18:00" (format.dart koreanShort) */
const koreanShort = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const timeShort = (d) => `${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${pad(d.getMinutes())}`;
function remainingText(ms) {
  const min = Math.floor(ms / 60e3);
  if (min < 1) return '곧';
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}
const rangeText = (q) => `${q.min} ~ ${q.max}`;
const errorLine = (text) => `<div class="error">${ic('error_outline')}<span>${esc(text)}</span></div>`;
/** "D구역 · 5번 줄 · 100~200번" / 없으면 "공연 전체" (console.dart targetText) */
function targetText(z, q, lo, hi) {
  const parts = [z, q, lo != null && hi != null ? `${lo}~${hi}번` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : '공연 전체';
}

const appbar = (title, { back, actions = '' } = {}) => `
  <header class="appbar">
    ${back ? `<button class="icon-btn lead" data-go="${back}" aria-label="뒤로">${ic('arrow_back_ios_new', '', 22)}</button>` : ''}
    <h1>${esc(title)}</h1>
    <div class="acts">${actions}</div>
  </header>`;

/** 화면 아래에 잠깐 뜨는 한 줄 (앱의 SnackBar) */
let hintTimer = null;
function hint(text) {
  let el = document.getElementById('snack');
  if (!el) { el = document.createElement('div'); el.id = 'snack'; document.body.appendChild(el); }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.hidden = true; }, 2000);
}

/** AlertDialog. html 안의 [data-dialog] 버튼을 누르면 그 값과 창 안 입력값으로 resolve. 바깥을 누르면 null. */
let dialogDone = null;
function modal(html, onInput) {
  return new Promise((resolve) => {
    $sheet.innerHTML = `<div class="dialog staff-dialog">${html}</div>`;
    $sheet.hidden = false;
    const box = $sheet.querySelector('.dialog');
    if (onInput) { box.addEventListener('input', () => onInput(box)); box.addEventListener('click', (ev) => { if (ev.target.closest('[data-step]')) onInput(box, ev.target.closest('[data-step]')); }); }
    box.querySelector('[autofocus]')?.focus();
    dialogDone = (id) => {
      const value = box.querySelector('textarea, input')?.value ?? '';
      $sheet.hidden = true;
      $sheet.innerHTML = '';
      dialogDone = null;
      resolve(id == null ? null : { id, value: value.trim(), box });
    };
  });
}
$sheet.addEventListener('click', (ev) => {
  const d = ev.target.closest('[data-dialog]');
  if (d && dialogDone) { dialogDone(d.dataset.dialog === 'cancel' ? null : d.dataset.dialog); return; }
  if (ev.target === $sheet && dialogDone) dialogDone(null);
});
const dialogActs = (items) => `<div class="acts">${items.map(([id, label, style = '']) => `<button class="text-btn" data-dialog="${id}" style="${style}">${esc(label)}</button>`).join('')}</div>`;

// ───────── 화면 (lib/ui/*.dart 를 그대로) ─────────

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'add') return { name: 'add' };
  if (parts[0] === 'e' && parts[1]) return { name: 'console', code: parts[1].toUpperCase(), sent: parts[2] === 'sent' };
  return { name: 'home' };
}
const go = (hash) => { location.hash = hash; };

// root.dart: 내 공연 + [공연 추가]
function viewHome() {
  const mine = myEvents();
  const cards = mine.map((e) => `
    <div class="card staff-event" data-go="#/e/${e.code}">
      <div class="row">${ic('verified', '', 18).replace('class="mi', 'class="ok mi')}<b>${esc(e.title)}</b>${ic('chevron_right').replace('class="mi', 'class="hint mi')}</div>
      <div class="hint" style="margin-top:6px">${koreanShort(new Date(showStart(e)))} · ${esc(e.venue)}</div>
      <div class="hint" style="font-size:13px">구역 ${e.zones.length}개 · 대기줄 ${e.zones.reduce((n, z) => n + z.queues.length, 0)}개</div>
      <div style="height:12px"></div>
      <button class="filled big" data-go="#/e/${e.code}">${ic('campaign')}<span>안내 보내기</span></button>
    </div>`).join('<div style="height:14px"></div>');
  const foot = state.refreshError
    ? `공연 정보를 갱신하지 못했습니다 (${esc(state.refreshError)}). 저장된 정보로 동작합니다.`
    : state.lastRefresh ? `마지막 업데이트 ${timeShort(state.lastRefresh)}` : '';
  return `${appbar('현장 스태프')}
    <div class="body" style="padding-top:20px">
      ${db ? '' : `${errorLine('안내 서버가 설정되지 않았습니다.')}<div style="height:16px"></div>`}
      <div class="staff-h">내 공연</div>
      ${mine.length ? cards : `<div class="card staff-empty">${ic('vpn_key', 'outlined', 44).replace('class="mi', 'class="hint mi')}
          <div style="font-size:17px;font-weight:600;margin-top:12px">아직 들어간 공연이 없습니다</div>
          <div class="hint" style="margin-top:4px">주최 측에서 받은 스태프 코드로 공연을 추가하세요.</div></div>`}
      <div style="height:${mine.length ? 22 : 20}px"></div>
      <button class="filled big${mine.length ? ' secondary' : ''}" data-go="#/add">${ic('add')}<span>공연 추가</span></button>
      <div style="height:16px"></div>
      <div class="hint" style="font-size:12px">${foot}</div>
    </div>`;
}

// login.dart: 스태프 코드만으로 공연을 찾아 들어간다
function viewAdd() {
  return `${appbar('공연 추가', { back: '#/' })}
    <div class="body" style="padding-top:20px">
      <div class="section-title" style="margin-bottom:12px">스태프 코드</div>
      <form class="card" style="padding:16px" data-form="login">
        <div class="hint">주최 측에서 받은 스태프 코드를 입력하세요. 코드만 넣으면 해당 공연으로 바로 들어갑니다.</div>
        <div style="height:14px"></div>
        <input id="staff-code" class="input staff-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="스태프 코드" autofocus>
        <div id="login-error">${state.loginError ? errorLine(state.loginError) : ''}</div>
      </form>
      <div style="height:20px"></div>
      <button class="filled big" data-action="login" ${state.loginBusy ? 'disabled' : ''}>${ic('lock_open')}<span>${state.loginBusy ? '확인 중…' : '들어가기'}</span></button>
    </div>`;
}

// console.dart: [입장 관리] 탭 = 공연 시작 · 입장 관리, [안내 보내기] 탭 = 안내 보내기 + [보낸 안내] 버튼.
// 두 탭을 모두 그려 두고 숨기기만 한다 (탭을 오가도 입력 중인 값이 남게).
// 보낸 안내(SentNoticesView)는 #/e/코드/sent — 콘솔 위에 덮는 화면이라 돌아와도 입력 중인 값이 남는다.
function viewConsole(e) {
  const tab = (id, icon, label) => `<button class="tab ${state.tab === id ? 'on' : ''}" data-action="tab" data-tab="${id}" aria-label="${label}" title="${label}">${ic(icon, state.tab === id ? '' : 'outlined')}</button>`;
  return `<div id="console-main">${appbar('현장 안내', { back: '#/', actions: `<button class="icon-btn" data-action="leave" aria-label="나가기" title="나가기">${ic('delete', 'outlined')}</button>` })}
    <nav class="tabbar console-tabs"><div>${tab('entry', 'door_front', '입장 관리')}${tab('notice', 'campaign', '안내 보내기')}</div></nav>
    <div class="body" id="page-entry" style="padding-top:20px"${state.tab === 'entry' ? '' : ' hidden'}>
      <div style="font-size:22px;font-weight:700">${esc(e.title)}</div>
      <div class="hint" id="show-sub">${koreanShort(new Date(showStart(e)))} · ${esc(e.venue)}</div>
      <div style="height:16px"></div>
      <div id="show-card">${showCard(e)}</div>
      <div style="height:16px"></div>
      <div class="staff-h" style="margin-bottom:0">입장 관리</div>
      <div class="hint" style="font-size:12px">입장 시작·마감을 누르면 그 줄(지정석은 구역) 관객 앱에 바로 표시됩니다</div>
      <div style="height:12px"></div>
      <div id="entry-cards">${e.zones.map((z) => entryCard(e, z)).join('<div style="height:10px"></div>')}</div>
      <div style="height:14px"></div>
    </div>
    <div class="body" id="page-notice" style="padding-top:20px"${state.tab === 'notice' ? '' : ' hidden'}>
      <div class="staff-h" style="margin-bottom:16px">안내 보내기</div>
      <div id="send-form">${sendForm(e)}</div>

      <div style="height:28px"></div>
      <div class="card"><button class="tile two" data-go="#/e/${esc(e.code)}/sent"><span style="color:var(--accent);display:flex">${ic('history')}</span><span class="t"><b>보낸 안내</b><small id="sent-count">${sentCount()}</small></span>${ic('chevron_right', '', 24).replace('class="mi', 'class="chev mi')}</button></div>
      <div style="height:24px"></div>
    </div></div>
    <div id="console-sent" hidden>${appbar('보낸 안내', { back: `#/e/${esc(e.code)}` })}
      <div class="body" style="padding-top:20px">
        <div class="hint" style="font-size:12px">최근 24시간 · 다른 스태프가 보낸 것도 보입니다</div>
        <div style="height:12px"></div>
        <div id="notice-list">${noticeList()}</div>
        <div style="height:24px"></div>
      </div>
    </div>`;
}

/** 공연 시작 카드: "공연 시작 오후 7:00 (처음 6:50)" + [시간 조정] */
function showCard(e) {
  const at = showStart(e);
  return `<div class="card staff-time">${ic('theater_comedy', 'outlined', 18).replace('class="mi', 'class="hint mi')}
    <span class="t"><span class="hint">공연 시작 </span><b>${timeShort(new Date(at))}</b>${at !== e.date.getTime() ? `<span class="hint small">  (처음 ${timeShort(e.date)})</span>` : ''}</span>
    <button class="text-btn" data-action="show-time" ${db ? '' : 'disabled'}>${ic('more_time')}<span>시간 조정</span></button></div>`;
}

/** 입장 예정 한 줄: "입장 예정 오후 6:30 (처음 6:20)" + [시간 조정]. q 가 있으면 그 줄만 조정한다. */
function entryTimeRow(z, q) {
  const at = entryStart(z, q), planned = plannedEntry(z, q);
  if (at == null) return '';
  return `<div class="entry-time">${ic('schedule', '', 16).replace('class="mi', 'class="hint mi')}
    <span class="t"><span class="hint">입장 예정 </span><b>${timeShort(new Date(at))}</b>${planned != null && at !== planned ? `<span class="hint small">  (처음 ${timeShort(new Date(planned))})</span>` : ''}</span>
    <button class="text-btn" data-action="entry-time" data-zone="${esc(z.name)}" data-queue="${esc(q?.name ?? '')}" ${db ? '' : 'disabled'}>${ic('more_time')}<span>시간 조정</span></button></div>`;
}

/** 구역 카드: 스탠딩은 대기줄마다, 지정석은 구역 한 줄로 현재 입장 상태 + [입장 시작|입장 완료] [입장 마감] */
function entryCard(e, z) {
  const queues = [...z.queues].sort((a, b) => a.order - b.order);
  const differ = entryStartsDiffer(z);
  // 줄마다 다르지 않으면 구역 전체 조정 (줄이 여럿이면 줄마다도 따로 조정할 수 있다)
  const head = differ ? '' : entryTimeRowZone(z, queues[0] ?? null);
  // 줄이 여럿이면 구역 전체를 한 번에 입장 시작·마감 (모든 줄에 적용, 그 뒤 줄마다 따로 바꿀 수 있다)
  const all = !z.seated && queues.length > 1 ? `${entryRow(z, null, false)}<div class="divider-full thick"></div>` : '';
  const rows = z.seated ? entryRow(z, null, false) : all + queues.map((q) => entryRow(z, q, differ || z.queues.length > 1)).join('<div class="divider-full"></div>');
  return `<div class="card staff-zone">
    <div class="zone-head"><b>${esc(z.name)}</b><span class="hint">${z.seated ? '지정석' : '스탠딩'}</span></div>
    ${head}${rows}</div>`;
}
/** 구역 머리말의 입장 예정: 첫 줄 기준 (줄마다 같을 때만 보인다) */
function entryTimeRowZone(z, q) {
  const at = entryStart(z, q), planned = plannedEntry(z, q);
  if (at == null) return '';
  return `<div class="entry-time">${ic('schedule', '', 16).replace('class="mi', 'class="hint mi')}
    <span class="t"><span class="hint">입장 예정 </span><b>${timeShort(new Date(at))}</b>${planned != null && at !== planned ? `<span class="hint small">  (처음 ${timeShort(new Date(planned))})</span>` : ''}</span>
    <button class="text-btn" data-action="entry-time" data-zone="${esc(z.name)}" data-queue="" ${db ? '' : 'disabled'}>${ic('more_time')}<span>시간 조정</span></button></div>`;
}

/** 입장 단위 한 줄 (스탠딩 대기줄 하나, 또는 지정석 구역 전체) */
function entryRow(z, q, ownTime) {
  const st = entryState(z, q);
  const [label, cls] = st === 'entryOpen' ? ['입장 중', 'open'] : st === 'entryClosed' ? ['입장 마감', 'closed'] : st === 'entryDone' ? ['입장 완료', 'done'] : ['입장 전', ''];
  const data = `data-zone="${esc(z.name)}" data-queue="${esc(q?.name ?? '')}"`;
  // 입장 중이면 [입장 완료] (관객 앱의 입장 시작 띠를 내린다). 완료하면 회색으로 꺼진 채 남는다. 아니면 [입장 시작]
  const primary = st === 'entryOpen' || st === 'entryDone'
    ? `<button class="filled green" data-action="entry-done" ${data} ${db && st === 'entryOpen' ? '' : 'disabled'}>입장 완료</button>`
    : `<button class="filled" data-action="entry-open" ${data} ${db ? '' : 'disabled'}>입장 시작</button>`;
  return `<div class="entry-row">
    <div class="row">${q ? `<b>${esc(q.name)}</b><span class="hint">${rangeText(q)}</span>` : '<span class="hint" style="font-size:15px">구역 전체</span>'}
      <span class="spacer"></span><span class="state ${cls}">${label}</span></div>
    ${q && ownTime ? entryTimeRow(z, q) : ''}
    <div class="btns">${primary}<button class="filled red" data-action="entry-close" ${data} ${db && st !== 'entryClosed' ? '' : 'disabled'}>입장 마감</button></div>
  </div>`;
}

function sendForm(e) {
  const z = e.zones.find((x) => x.name === state.zone) || null;
  const queues = z ? [...z.queues].sort((a, b) => a.order - b.order) : [];
  const chip = (attrs, title, sub, on, width) => `<button class="chip${on ? ' on' : ''}" ${attrs}${width ? ` style="width:${width}px"` : ''}><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
  return `
    <div class="section-title">대상 구역</div>
    <div class="chips">${chip('data-action="pick-zone" data-zone=""', '공연 전체', '모든 구역', !z)}${e.zones.map((x) => chip(`data-action="pick-zone" data-zone="${esc(x.name)}"`, x.name, x.seated ? '지정석' : `${x.min}~${x.max}`, z?.name === x.name)).join('')}</div>
    ${z && !z.seated ? `<div style="height:20px"></div><div class="section-title">대상 대기줄</div>
      <div class="chips">${chip('data-action="pick-queue" data-queue=""', `${z.name} 전체`, '모든 줄', !state.queue)}${queues.map((q) => chip(`data-action="pick-queue" data-queue="${esc(q.name)}"`, q.name, rangeText(q), state.queue === q.name)).join('')}</div>` : ''}
    ${!z || !z.seated ? `<div style="height:20px"></div>
      <div class="card">
        <label class="tile two" style="cursor:pointer"><span class="t"><b style="font-weight:600">번호 범위 지정</b><small>${z ? `${z.min}~${z.max} 안에서` : '특정 번호대에만 보낼 때'}</small></span>
          <span class="switch"><input type="checkbox" data-action="use-range" ${state.useRange ? 'checked' : ''}><i></i></span></label>
        ${state.useRange ? `<div style="padding:0 16px 16px"><div class="range-row"><input id="range-min" class="input range" inputmode="numeric" pattern="[0-9]*" placeholder="최소">
          <span style="font-size:20px;padding:0 12px">~</span><input id="range-max" class="input range" inputmode="numeric" pattern="[0-9]*" placeholder="최대"></div><div id="range-error"></div></div>` : ''}
      </div>` : ''}
    <div style="height:24px"></div>
    <div class="section-title">메시지</div>
    <textarea id="message" class="input message" rows="2" placeholder="관객에게 보낼 안내를 입력하세요"></textarea>
    <div id="send-error">${state.sendError ? errorLine(state.sendError) : ''}</div>
    <div style="height:20px"></div>
    <button class="filled big" id="send" data-action="send">${ic('campaign')}<span>${state.sending ? '보내는 중…' : '안내 보내기'}</span></button>
    <div class="hint center" id="send-target" style="font-size:13px;margin-top:6px"></div>`;
}

const sentCount = () => `최근 24시간 ${state.notices.length}개`;

/** 콘솔 ↔ 보낸 안내 화면 전환 (다시 그리지 않고 숨기기만). 콘솔 스크롤 위치는 돌아올 때 되돌린다 */
let consoleScroll = 0;
function showSent(on) {
  const main = document.getElementById('console-main'), sent = document.getElementById('console-sent');
  if (!main || !sent || sent.hidden === !on) return;
  if (on) consoleScroll = window.scrollY;
  main.hidden = on;
  sent.hidden = !on;
  window.scrollTo(0, on ? 0 : consoleScroll);
}

function noticeList() {
  const err = state.noticesError ? errorLine(state.noticesError) : '';
  if (!state.notices.length) return `${err}<div class="card" style="padding:16px"><span class="hint">아직 보낸 안내가 없습니다.</span></div>`;
  return err + state.notices.map((n) => {
    const k = kind(n.kind);
    const color = n.kind === 'moveBack' ? 'var(--orange)' : n.kind === 'entryClosed' ? 'var(--red)' : 'var(--accent)';
    return `<div class="card staff-notice"><span style="color:${color}">${ic(k.icon)}</span>
      <div class="t"><div class="row"><b>${esc(k.title)}</b><span class="spacer"></span><span class="hint" style="font-size:12px">${timeShort(new Date(n.at))}</span></div>
        <div style="margin-top:2px;white-space:pre-line">${esc(n.message)}</div>
        <div class="row" style="margin-top:2px"><span class="hint" style="font-size:12px;flex:1">${esc(targetText(n.zone, n.queue, n.min, n.max))}</span>
        <button class="text-btn cancel-notice" data-action="cancel-notice" data-id="${esc(n.id)}" ${db ? '' : 'disabled'}>취소</button></div></div></div>`;
  }).join('<div style="height:10px"></div>');
}

// ───────── 안내 보내기 폼 상태 (입력 중에는 화면을 다시 그리지 않고 필요한 곳만) ─────────

function formValues(e) {
  const z = e.zones.find((x) => x.name === state.zone) || null;
  const msg = document.getElementById('message')?.value.trim() ?? '';
  const text = msg; // 항상 직접 입력 (console.dart)
  let lo = null, hi = null, invalid = false;
  if (state.useRange && (!z || !z.seated)) {
    lo = parseInt(document.getElementById('range-min')?.value, 10);
    hi = parseInt(document.getElementById('range-max')?.value, 10);
    lo = Number.isNaN(lo) ? null : lo;
    hi = Number.isNaN(hi) ? null : hi;
    invalid = lo == null || hi == null || lo > hi || (z && (lo < z.min || hi > z.max));
  }
  return { z, text, lo, hi, invalid };
}

function updateSendBar(e) {
  const { z, text, lo, hi, invalid } = formValues(e);
  const btn = document.getElementById('send');
  if (btn) btn.disabled = state.sending || !text || invalid || !db;
  const target = document.getElementById('send-target');
  if (target) target.textContent = `대상: ${targetText(z?.name, state.queue, invalid ? null : lo, invalid ? null : hi)}`;
  const re = document.getElementById('range-error');
  if (re) re.innerHTML = invalid ? errorLine(z ? `${z.min}~${z.max} 안에서 최소 ≤ 최대로 입력하세요.` : '최소 ≤ 최대로 입력하세요.') : '';
}

/** 실시간으로 안내가 오면: 입력 중인 폼은 두고 공연 시작·입장 관리·보낸 안내만 다시 그린다 */
function renderLive() {
  const r = route();
  if (r.name !== 'console') return render();
  const e = eventByCode(r.code);
  if (!e || !document.getElementById('notice-list')) return render();
  document.getElementById('show-card').innerHTML = showCard(e);
  document.getElementById('show-sub').textContent = `${koreanShort(new Date(showStart(e)))} · ${e.venue}`;
  document.getElementById('entry-cards').innerHTML = e.zones.map((z) => entryCard(e, z)).join('<div style="height:10px"></div>');
  document.getElementById('notice-list').innerHTML = noticeList();
  document.getElementById('sent-count').textContent = sentCount();
}

function renderForm(e) {
  const keep = { msg: document.getElementById('message')?.value ?? '', min: document.getElementById('range-min')?.value ?? '', max: document.getElementById('range-max')?.value ?? '' };
  document.getElementById('send-form').innerHTML = sendForm(e);
  document.getElementById('message').value = keep.msg;
  if (document.getElementById('range-min')) { document.getElementById('range-min').value = keep.min; document.getElementById('range-max').value = keep.max; }
  updateSendBar(e);
}

function render() {
  const r = route();
  if (r.name === 'console') {
    const e = eventByCode(r.code);
    // 나가기(코드 삭제)했거나 지난 공연이 되면 목록으로 (root.dart EventGate)
    if (!e) { $app.innerHTML = `${appbar('', { back: '#/' })}<div class="center" style="padding-top:40vh">${state.events.length ? '공연을 찾을 수 없습니다' : '불러오는 중…'}</div>`; return; }
    if (!state.staffCodes[e.code] || isPast(e)) { go('#/'); return; }
    $app.innerHTML = viewConsole(e);
    showSent(r.sent);
    updateSendBar(e);
    startNotices(e.code);
    return;
  }
  $app.innerHTML = r.name === 'add' ? viewAdd() : viewHome();
  if (r.name === 'add') document.getElementById('staff-code')?.focus();
}

// ───────── 이벤트 ─────────

const currentEvent = () => { const r = route(); return r.name === 'console' ? eventByCode(r.code) : null; };
const zoneOf = (e, name) => e.zones.find((z) => z.name === name);
const queueOf = (z, name) => (name ? z.queues.find((q) => q.name === name) : null);

async function doLogin() {
  const input = document.getElementById('staff-code');
  state.loginBusy = true; state.loginError = null;
  const raw = input?.value ?? '';
  render();
  const [code, err] = await enter(raw);
  state.loginBusy = false;
  if (code) { go('#/e/' + code); return; }
  state.loginError = err;
  render();
  const again = document.getElementById('staff-code');
  if (again) again.value = raw;
}

/** 입장 시작/마감 확인 창 (console.dart _EntryDialog) */
async function sendEntry(e, z, q, k) {
  const target = [z.name, q?.name ?? (z.seated ? null : '전체')].filter(Boolean).join(' ');
  const open = k === 'entryOpen';
  const r = await modal(`<h3>${esc(target)} ${kind(k).title}</h3>
    <p class="hint" style="font-size:14px">${open ? '관객 앱에 입장이 시작되었다고 표시되고, 아래 메시지가 함께 나갑니다.' : '관객 앱에 입장이 마감되어 들어올 수 없다고 표시됩니다.'}</p>
    <textarea class="input message" rows="2" placeholder="${esc(kind(k).message)}" ${open ? 'autofocus' : ''}></textarea>
    ${dialogActs([['cancel', '취소'], ['ok', kind(k).title, `font-weight:700;color:${open ? 'var(--accent)' : 'var(--red)'}`]])}`);
  if (!r) return;
  try {
    await send(e, { kind: k, message: r.value || kind(k).message, zone: z.name, queue: q?.name ?? null });
    hint(`${target} ${kind(k).title}을 보냈습니다.`);
  } catch (err) { hint(err.message); }
}

/** 입장 완료: 확인만 받고 보낸다. 관객 앱에서는 입장 시작 띠가 내려간다 (알림 없음). */
async function finishEntry(e, z, q) {
  const target = [z.name, q?.name ?? (z.seated ? null : '전체')].filter(Boolean).join(' ');
  const r = await modal(`<h3>${esc(target)} 입장 완료</h3><p class="hint" style="font-size:14px">관객 앱에서 "입장이 시작되었습니다" 안내가 내려갑니다. 관객에게 알림은 가지 않습니다.</p>
    ${dialogActs([['cancel', '취소'], ['ok', '입장 완료', 'font-weight:700']])}`);
  if (!r) return;
  try {
    await send(e, { kind: 'entryDone', message: kind('entryDone').message, zone: z.name, queue: q?.name ?? null });
    hint(`${target} 입장 완료로 바꿨습니다.`);
  } catch (err) { hint(err.message); }
}

/** 시각 조정 창: −10/−5/+5/+10분으로 새 시각을 정하고, 덧붙일 말(선택)을 쓴다 (console.dart _EntryTimeDialog) */
async function adjustTime(title, current, target, show) {
  let delta = 0;
  const draw = (box) => {
    const next = current + delta * 60e3;
    box.querySelector('[data-next]').textContent = timeShort(new Date(next));
    const d = box.querySelector('[data-delta]');
    d.textContent = delta === 0 ? '변경 없음' : delta > 0 ? `${remainingText(delta * 60e3)} 늦춤` : `${remainingText(-delta * 60e3)} 당김`;
    d.style.color = delta === 0 ? 'var(--hint)' : delta > 0 ? 'var(--orange)' : 'var(--accent)';
    box.querySelector('[data-dialog="ok"]').disabled = delta === 0;
  };
  const r = await modal(`<h3>${esc(title)}</h3>
    <p class="hint" style="font-size:14px;margin-bottom:8px">지금 예정 ${timeShort(new Date(current))}</p>
    <div class="center" style="font-size:30px;font-weight:800" data-next>${timeShort(new Date(current))}</div>
    <div class="center" style="font-size:13px;font-weight:600;color:var(--hint)" data-delta>변경 없음</div>
    <div class="steps">${[-10, -5, 5, 10].map((m) => `<button class="outlined" data-step="${m}">${m > 0 ? '+' + m : m}분</button>`).join('')}</div>
    <textarea class="input message" rows="1" placeholder="덧붙일 말 (선택) 예: 무대 점검으로 늦어집니다"></textarea>
    <p class="hint" style="font-size:12px;margin-top:6px">보내면 이 ${target} 관객에게 알림이 가고, ${show ? '공연까지' : '입장까지'} 남은 시간이 바로 바뀝니다.</p>
    ${dialogActs([['cancel', '취소'], ['ok', '보내기', 'font-weight:700']])}`, (box, step) => {
    if (step) delta += Number(step.dataset.step);
    draw(box);
  });
  if (!r || delta === 0) return null;
  const next = current + delta * 60e3;
  const text = timeChangeText(current, next, show);
  return { at: next, message: r.value ? `${text}\n${r.value}` : text };
}

$app.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-go], [data-action]');
  if (!t || t.disabled) return;
  if (t.dataset.go != null && !t.dataset.action) { ev.stopPropagation(); go(t.dataset.go); return; }
  const a = t.dataset.action;
  const e = currentEvent();
  if (a === 'login') return doLogin();
  if (!e) return;
  const z = t.dataset.zone ? zoneOf(e, t.dataset.zone) : null;
  const q = z ? queueOf(z, t.dataset.queue) : null;
  if (a === 'leave') {
    const r = await modal(`<h3>이 기기에서 스태프 코드를 지웁니다.</h3>${dialogActs([['cancel', '취소'], ['ok', '나가기', 'color:var(--red)']])}`);
    if (r) { logout(e.code); go('#/'); }
  } else if (a === 'tab') {
    state.tab = t.dataset.tab;
    document.getElementById('page-entry').hidden = state.tab !== 'entry';
    document.getElementById('page-notice').hidden = state.tab !== 'notice';
    document.querySelectorAll('.console-tabs .tab').forEach((b) => {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle('on', on);
      b.querySelector('.mi').className = on ? 'mi material-icons' : 'mi material-icons-outlined';
    });
    window.scrollTo(0, 0);
  } else if (a === 'entry-open') {
    await sendEntry(e, z, q, 'entryOpen');
  } else if (a === 'entry-close') {
    await sendEntry(e, z, q, 'entryClosed');
  } else if (a === 'entry-done') {
    await finishEntry(e, z, q);
  } else if (a === 'entry-time') {
    const cur = entryStart(z, q ?? z.queues[0] ?? null);
    const title = [z.name, q?.name].filter(Boolean).join(' · ');
    const r = await adjustTime(`${title} 입장 시간 조정`, cur, q ? '줄' : '구역', false);
    if (!r) return;
    try {
      await send(e, { kind: 'entryTime', message: r.message, zone: z.name, queue: q?.name ?? null, entryAt: r.at });
      hint(`${title} 입장 예정을 ${timeShort(new Date(r.at))}로 바꿨습니다.`);
    } catch (err) { hint(err.message); }
  } else if (a === 'show-time') {
    const r = await adjustTime('공연 시간 조정', showStart(e), '공연', true);
    if (!r) return;
    try {
      await send(e, { kind: 'showTime', message: r.message, entryAt: r.at });
      hint(`공연 시작을 ${timeShort(new Date(r.at))}로 바꿨습니다.`);
    } catch (err) { hint(err.message); }
  } else if (a === 'cancel-notice') {
    // console.dart _CancelDialog: 정정 안내는 쓰고 싶을 때만 (비우면 취소만)
    const n = state.notices.find((x) => x.id === t.dataset.id);
    if (!n) return;
    const r = await modal(`<h3>이 안내를 취소할까요?</h3>
      <p style="margin:0 0 4px;font-weight:600">${esc(kind(n.kind).title)} · ${esc(targetText(n.zone, n.queue, n.min, n.max))}</p>
      <p style="margin:0 0 12px;white-space:pre-line">${esc(n.message)}</p>
      <p class="hint" style="font-size:13px">관객 앱·웹 안내 목록에서 사라지고, 입장 시작·마감·시간 변경이면 이전 상태로 돌아갑니다. 이미 뜬 알림은 지울 수 없습니다.</p>
      <textarea class="input message" rows="2" placeholder="정정 안내 (선택) — 예: 앞서 보낸 안내는 잘못 보낸 것입니다"></textarea>
      <div class="hint small" data-correction-hint style="margin-top:6px">비워 두면 취소만 합니다.</div>
      ${dialogActs([['cancel', '닫기'], ['ok', '안내 취소', 'font-weight:700;color:#C9504A']])}`,
      (box) => { box.querySelector('[data-correction-hint]').textContent = box.querySelector('textarea').value.trim() ? '같은 대상에게 이 내용으로 새 안내를 보냅니다.' : '비워 두면 취소만 합니다.'; });
    if (!r) return;
    try {
      await cancelNotice(e, n, r.value);
      hint(r.value ? '안내를 취소하고 정정 안내를 보냈습니다.' : '안내를 취소했습니다.');
    } catch (err) { hint(err.message); }
  } else if (a === 'pick-zone') {
    state.zone = t.dataset.zone || null; state.queue = null; renderForm(e);
  } else if (a === 'pick-queue') {
    state.queue = t.dataset.queue || null; renderForm(e);
  } else if (a === 'send') {
    const { z: tz, text, lo, hi, invalid } = formValues(e);
    if (!text || invalid) return;
    state.sending = true; state.sendError = null; renderForm(e);
    try {
      await send(e, { kind: state.kind, message: text, zone: tz?.name ?? null, queue: state.queue, min: lo, max: hi });
      document.getElementById('message').value = '';
      hint('안내를 보냈습니다.');
    } catch (err) {
      state.sendError = err.message;
    } finally {
      state.sending = false;
      renderForm(e);
    }
  }
});
$app.addEventListener('change', (ev) => {
  const e = currentEvent();
  if (e && ev.target.dataset.action === 'use-range') { state.useRange = ev.target.checked; renderForm(e); }
});
$app.addEventListener('input', (ev) => {
  if (ev.target.id === 'staff-code') {
    if (state.loginError) { state.loginError = null; document.getElementById('login-error').innerHTML = ''; }
    return;
  }
  const e = currentEvent();
  if (e) updateSendBar(e);
});
$app.addEventListener('submit', (ev) => { ev.preventDefault(); if (ev.target.dataset.form === 'login') doLogin(); });
$app.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'staff-code') { ev.preventDefault(); doLogin(); } });

window.addEventListener('hashchange', () => {
  const r = route();
  // 같은 공연의 콘솔 ↔ 보낸 안내: 화면을 새로 그리지 않는다 (입력 중인 값 유지)
  if (r.name === 'console' && watching === r.code && document.getElementById('console-main')) { showSent(r.sent); return; }
  if (r.name !== 'console') stopNotices();
  if (r.name === 'add') state.loginError = null;
  if (r.name === 'console' && watching !== r.code) { state.zone = null; state.queue = null; state.useRange = false; state.sendError = null; }
  render();
  window.scrollTo(0, 0);
});
// 화면으로 돌아오면 공연 정보 다시 받기 (main.dart resumed)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCatalog(); });

render();
refreshCatalog();
