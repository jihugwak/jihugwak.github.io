// 관객 웹. 화면은 관객 앱(flutter/apps/audience/lib/ui)과 같게, 서버·규칙도 같게:
// - catalog.json(관리자 게시)으로 공연/구역/대기줄 → 번호로 대기줄 배정 (standing_core QueueLogic 과 동일)
// - 줄 현황: take_spot / leave_spot / line_spots RPC
// - 현장 안내: notices 테이블 최근 6시간 + Realtime
// - 공연장 위치 제한, 줄서기 시작 시각
// 블루투스 앞뒤 번호 찾기·푸시 알림·예매처 계정 연결은 앱에만 있다.
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
const $tabbar = document.getElementById('tabbar');
const $sheet = document.getElementById('sheet');

// ───────── 저장 (이 브라우저에만) ─────────

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('sq.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('sq.' + key, JSON.stringify(value)); } catch { /* 사생활 보호 모드 등 */ }
  },
};

const state = {
  events: [],
  myCodes: store.get('myEvents', []),
  /** {code, zone, queue, ticket, standing} — 구역/대기줄은 이름으로 저장. 지정석은 {code, zone, seated: true} */
  participant: store.get('participant', null),
  deviceId: store.get('deviceId', null) || newDeviceId(),
  notices: store.get('notices', []),
  noticesReadAt: store.get('noticesReadAt', 0),
  spots: [],
  spotsError: null,
  loadingSpots: false,
  onlyStanding: false,
  wholeMap: false,     // 기준 줄이 있을 때 [전체 보기]
  checking: false,     // 위치 확인 중
};
store.set('deviceId', state.deviceId);

function newDeviceId() {
  return (crypto.randomUUID && crypto.randomUUID()) || 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

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
    out.push({ name: `${i + 1}번 줄`, min: cur, max: cur + size - 1, order: i, map: null });
    cur += size;
  }
  return out;
}

function parseMap(raw) {
  if (!raw || !Array.isArray(raw.slots)) return null;
  const slots = raw.slots.filter((t) => Array.isArray(t) && t.length >= 3).map((t) => ({ x: +t[0], y: +t[1], n: +t[2] }));
  // 기준 줄: "rows" = 가로줄, "cols" = 세로줄 (관객은 내 번호가 든 줄만 먼저 본다)
  const axis = raw.axis === 'rows' || raw.axis === 'cols' ? raw.axis : null;
  return slots.length ? { cols: +raw.cols || 16, slots, axis } : null;
}

/** "location": {"lat", "lng", "radius"} → 없거나 잘못되면 null */
function parseLocation(l) {
  return l && typeof l.lat === 'number' && typeof l.lng === 'number' ? { lat: l.lat, lng: l.lng, radius: l.radius || 300 } : null;
}

function parseCatalog(text) {
  const root = JSON.parse(text);
  const events = [];
  for (const e of root.events || []) {
    const code = String(e.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code) || events.some((x) => x.code === code)) continue;
    const eventLoc = parseLocation(e.location);
    const eventEntry = e.entry ? parseDate(e.entry) : null;
    const zones = (e.zones || []).map((z) => {
      // 구역 위치 제한: 생략 = 공연 위치, "none" = 제한 없음, 좌표 = 이 구역만 따로
      const location = z.location == null ? eventLoc : z.location === 'none' ? null : parseLocation(z.location);
      // 줄서기 시작: 생략 = 공연 시각, "none" = 언제든, 시각 = 이 구역만 따로 (지정석은 줄이 없다)
      const entryAt = z.entry == null ? eventEntry : z.entry === 'none' ? null : parseDate(z.entry);
      // 입장 시작 예정 (선택) — 스태프가 현장에서 늦추거나 당긴다
      const admission = z.admission ? parseDate(z.admission) : null;
      // 지정석: 번호·대기줄 없이 구역만
      if (z.type === 'seated') return { name: z.name || '', seated: true, min: 0, max: 0, queues: [], location: null, admission };
      const zoneMap = parseMap(z.map);
      const specs = Array.isArray(z.queues)
        ? z.queues.map((q, i) => ({ name: q.name || `${i + 1}번 줄`, min: q.min, max: q.max, order: i, map: parseMap(q.map) }))
        : autoSplit(z.min, z.max, z.queueCount || 1);
      // 예전 형식: 구역 전체 배치도에서 대기줄 번호만 떼어 온다
      for (const s of specs) {
        if (!s.map && zoneMap) {
          const picked = zoneMap.slots.filter((t) => t.n >= s.min && t.n <= s.max);
          if (picked.length) {
            const top = Math.min(...picked.map((t) => t.y));
            s.map = { cols: zoneMap.cols, slots: picked.map((t) => ({ x: t.x, y: t.y - top, n: t.n })) };
          }
        }
      }
      return { name: z.name || '', min: z.min, max: z.max, queues: specs, location, entryAt, admission };
    });
    events.push({
      code, title: e.title || '', date: parseDate(e.date), entryAt: eventEntry,
      venue: e.venue || '', zones, location: eventLoc,
    });
  }
  const notices = (root.notices || []).map((n) => ({
    id: 'catalog:' + n.id, code: String(n.event || '').toUpperCase(), zone: n.zone || null, queue: n.queue || null,
    min: n.min ?? null, max: n.max ?? null, kind: n.kind || 'info', message: n.message || kind(n.kind).message,
    at: n.createdAt ? parseDate(n.createdAt).getTime() : Date.now(),
  }));
  return { events, notices };
}

function applyCatalog(text) {
  const r = parseCatalog(text);
  state.events = r.events;
  r.notices.forEach(receiveNotice);
}

async function loadCatalog() {
  const cached = store.get('catalog', null);
  if (cached && !state.events.length) { try { applyCatalog(cached); } catch { /* 깨진 캐시는 무시 */ } }
  try {
    const res = await fetch(CONFIG.catalogUrl + '?t=' + Math.floor(Date.now() / 1000), { cache: 'no-store' });
    if (!res.ok) throw new Error('서버 응답 ' + res.status);
    const text = await res.text();
    applyCatalog(text);
    store.set('catalog', text);
  } catch { /* 오프라인이면 캐시로 */ }
}

const isPast = (e) => e.date.getTime() + 24 * 3600e3 < Date.now();
const eventByCode = (code) => state.events.find((e) => e.code === String(code).trim().toUpperCase() && !isPast(e)) || null;
const zoneOf = (e, name) => e?.zones.find((z) => z.name === name) || null;
const queueOf = (z, name) => z?.queues.find((q) => q.name === name) || null;
const rangeText = (q) => `${q.min} ~ ${q.max}`;

/** 저장된 참가가 아직 유효하면 {p, e, z, q}. 지정석이면 q 는 null. */
function current() {
  const p = state.participant;
  if (!p) return null;
  const e = eventByCode(p.code), z = zoneOf(e, p.zone);
  if (!e || !z || !!z.seated !== !!p.seated) return null; // 구역 종류가 바뀌면 다시 등록
  if (z.seated) return { p, e, z, q: null };
  let q = queueOf(z, p.queue);
  // 관리자가 대기줄 범위·이름을 바꿔 다시 게시했으면 번호로 대기줄을 다시 찾는다 (store.dart _reassignQueue)
  if (!q || p.ticket < q.min || p.ticket > q.max) {
    const r = assign(p.ticket, z);
    if (r.queue) {
      q = r.queue;
      p.queue = q.name;
      saveParticipant();
    }
  }
  return q ? { p, e, z, q } : null;
}

// ───────── 번호 → 대기줄 (QueueLogic) ─────────

function parseTicket(raw) {
  const t = String(raw).trim();
  if (!t) return { error: '입장번호를 입력해 주세요.' };
  if (!/^[0-9]+$/.test(t)) return { error: '숫자만 입력할 수 있습니다.' };
  return { value: parseInt(t, 10) };
}

function assign(ticket, zone) {
  if (ticket < zone.min || ticket > zone.max) return { error: `해당 구역의 입장번호 범위는 ${zone.min}~${zone.max}번입니다.` };
  const q = [...zone.queues].sort((a, b) => a.order - b.order).find((q) => q.min <= ticket && ticket <= q.max);
  return q ? { queue: q } : { error: '이 번호에 해당하는 대기줄이 아직 설정되지 않았습니다.' };
}

// ───────── 공연장 위치 제한 (location_gate.dart 와 같은 문구) ─────────

function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 구역에 적용되는 위치(zone.location)로 확인. 통과면 null, 아니면 관객에게 보여 줄 메시지 */
function checkLocation(loc) {
  if (!loc) return Promise.resolve(null);
  if (!navigator.geolocation) return Promise.resolve('이 브라우저에서는 위치를 확인할 수 없습니다.');
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const d = distance(loc.lat, loc.lng, latitude, longitude);
        if (d - accuracy <= loc.radius) return resolve(null);
        const text = d >= 1000 ? `${(d / 1000).toFixed(1)}km` : `${Math.round(d)}m`;
        resolve(`이 공연은 공연장에서만 사용할 수 있습니다.\n현재 위치가 공연장에서 약 ${text} 떨어져 있습니다. (허용 반경 ${Math.round(loc.radius)}m · 위치 정확도 ±${Math.round(accuracy)}m)`);
      },
      (err) => resolve(err.code === err.PERMISSION_DENIED
        ? '이 공연은 공연장 안에서만 사용할 수 있어 위치 권한이 필요합니다. 설정에서 허용해 주세요.'
        : '현재 위치를 확인하지 못했습니다. 실내에서는 시간이 걸릴 수 있으니 창가나 실외에서 다시 시도해 주세요.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

// ───────── 줄 현황 서버 ─────────

let heartbeat = null, spotPoll = null;

function syncSpot() {
  clearInterval(heartbeat);
  heartbeat = null;
  if (!db) return;
  if (!current()?.q) { db.rpc('leave_spot', { p_device_id: state.deviceId }).then(() => {}, () => {}); return; }
  const report = () => {
    const c = current();
    if (!c?.q) return;
    db.rpc('take_spot', {
      p_event_code: c.e.code, p_device_id: state.deviceId, p_ticket_number: c.p.ticket,
      p_zone: c.z.name, p_queue: c.q.name, p_standing: !!c.p.standing,
    }).then(() => {}, () => {});
  };
  report();
  heartbeat = setInterval(report, 2 * 60e3);
}

async function refreshSpots() {
  const c = current();
  if (!db || !c?.q || state.loadingSpots) return;
  state.loadingSpots = true;
  if (route().name === 'line') render();
  const { data, error } = await db.rpc('line_spots', { p_event_code: c.e.code, p_zone: c.z.name, p_queue: c.q.name, p_within_seconds: 600 });
  state.loadingSpots = false;
  if (error) state.spotsError = error.message;
  else { state.spots = (data || []).map((r) => ({ n: +r.ticket_number, standing: r.standing === true })); state.spotsError = null; }
  if (route().name === 'line') render();
}

// ───────── 현장 안내 ─────────

const KINDS = {
  moveBack: { title: '뒤로 이동', message: '대기줄이 밀렸습니다. 뒤로 이동해 주세요.', icon: 'arrow_circle_left', color: 'var(--orange)' },
  moveForward: { title: '앞으로 이동', message: '앞 공간이 비었습니다. 앞으로 이동해 주세요.', icon: 'arrow_circle_right', color: 'var(--accent)' },
  entryReady: { title: '입장 준비', message: '곧 입장합니다. 티켓과 신분증을 준비해 주세요.', icon: 'meeting_room', color: 'var(--accent)' },
  entryOpen: { title: '입장 시작', message: '입장이 시작되었습니다. 티켓을 준비하고 안내에 따라 입장해 주세요.', icon: 'login', color: 'var(--accent)' },
  entryTime: { title: '입장 시간 변경', message: '', icon: 'more_time', color: 'var(--accent)' },
  entryClosed: { title: '입장 마감', message: '입장이 마감되어 더 이상 입장할 수 없습니다.', icon: 'block', color: 'var(--red)' },
  info: { title: '안내', message: '', icon: 'campaign', color: 'var(--accent)' },
};
function kind(k) { return KINDS[k] || KINDS.info; }

function targets(n, c) {
  if (!c || n.code !== c.e.code) return false;
  if (n.zone && n.zone !== c.z.name) return false;
  if (n.queue && n.queue !== c.q?.name) return false;
  if (n.min != null && n.max != null) {
    if (!c.q) return false; // 지정석은 번호가 없다
    const top = Math.max(n.min, n.max);
    if (c.p.ticket < n.min || c.p.ticket > top) return false;
  }
  return true;
}

function receiveNotice(n) {
  if (state.notices.some((x) => x.id === n.id)) return;
  state.notices.push(n);
  state.notices = state.notices.slice(-200);
  store.set('notices', state.notices);
  if (targets(n, current()) && n.at > Date.now() - 10 * 60e3) toast(n);
  render();
}

const myNotices = () => {
  const c = current();
  return c ? state.notices.filter((n) => targets(n, c)).sort((a, b) => b.at - a.at) : [];
};
// 내 대기줄의 현재 입장 상태 = 입장 시작/마감 중 가장 최근 것 (없으면 입장 전)
const myEntryState = () => myNotices().find((n) => n.kind === 'entryOpen' || n.kind === 'entryClosed') || null;

// 내 구역 입장 예정 시각(ms): 스태프가 조정한 것(가장 최근 입장 시간 변경) > 관리자가 정한 시각
function myEntryStart() {
  const c = current();
  if (!c) return null;
  const t = myNotices().find((n) => n.kind === 'entryTime' && n.entryAt);
  return t ? t.entryAt : c.z.admission ? c.z.admission.getTime() : null;
}

// home.dart EntryCountdown: "입장까지 1시간 23분 05초 · 오후 6:00 입장 예정" — 타이머처럼 1초마다 줄어든다
const countdownBig = (at) => {
  const left = at - Date.now();
  return left < 1000 ? '곧 입장이 시작됩니다' : `입장까지 ${countdownText(left)}`;
};
// 화면용 (EntryCountdown compact: false): 디지털 시계처럼 [시간]:[분]:[초] 숫자 칸, 콜론은 1초마다 깜빡인다
function clockInner(at) {
  const t = Math.max(0, Math.floor((at - Date.now()) / 1000));
  if (t < 1) return '<b class="soon">곧 입장이 시작됩니다</b>';
  const days = Math.floor(t / 86400);
  const unit = (d, label) => `<span class="u"><b>${d}</b><small>${label}</small></span>`;
  const colon = `<i class="${t % 2 ? 'dim' : ''}">:</i>`;
  return `<div class="hint lbl">입장까지</div><div class="digits" aria-label="입장까지 ${countdownText(at - Date.now())}">${days ? unit(days, '일') : ''}${unit(pad(Math.floor((t % 86400) / 3600)), '시간')}${colon}${unit(pad(Math.floor((t % 3600) / 60)), '분')}${colon}${unit(pad(t % 60), '초')}</div>`;
}

function entryCountdown(big = false) {
  const at = myEntryStart();
  if (!at) return '';
  if (big) return `<div class="entry-clock"><div data-clock="${at}">${clockInner(at)}</div><div class="hint sub">${timeShort(new Date(at))} 입장 예정 · 시작되면 알림으로 알려 드립니다</div></div>`;
  return `<div class="entry-countdown">${ic('schedule')}<b data-countdown="${at}">${countdownBig(at)}</b><span class="hint">${timeShort(new Date(at))} 입장 예정</span></div>`;
}

// home.dart countdownText: "2일 3시간 04분 05초" / "1시간 04분 05초" / "4분 05초" / "5초"
function countdownText(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  if (days) return `${days}일 ${h}시간 ${pad(m)}분 ${pad(sec)}초`;
  if (h) return `${h}시간 ${pad(m)}분 ${pad(sec)}초`;
  if (m) return `${m}분 ${pad(sec)}초`;
  return `${sec}초`;
}

// home.dart EntryStateBanner (입장 전이면 남은 시간)
function entryBanner(big = false) {
  const n = myEntryState();
  if (!n) return entryCountdown(big);
  const open = n.kind === 'entryOpen';
  const body = open ? n.message : (n.message === KINDS.entryClosed.message ? '더 이상 입장할 수 없습니다.' : n.message);
  return `<div class="entry-banner ${open ? 'open' : 'closed'}">${ic(kind(n.kind).icon)}
    <div class="t"><div class="h"><b>${open ? '입장이 시작되었습니다' : '입장이 마감되었습니다'}</b><span class="hint">${timeShort(new Date(n.at))}</span></div>
    ${body ? `<div class="m">${esc(body)}</div>` : ''}</div></div>`;
}

const unreadCount = () => myNotices().filter((n) => n.at > state.noticesReadAt).length;

let channel = null, channelCode = null;

async function syncNotices() {
  const code = current()?.e.code || null;
  if (code === channelCode) return;
  if (channel && db) { db.removeChannel(channel); channel = null; }
  channelCode = code;
  if (!db || !code) return;
  const fromRow = (r) => ({
    id: r.id, code: String(r.event_code).toUpperCase(), zone: r.zone, queue: r.queue, min: r.min_number, max: r.max_number,
    kind: r.kind, message: r.message || '', at: new Date(r.created_at).getTime(),
    entryAt: r.entry_at ? new Date(r.entry_at).getTime() : null,
  });
  const since = new Date(Date.now() - 6 * 3600e3).toISOString();
  const { data } = await db.from('notices').select().eq('event_code', code).gte('created_at', since).order('created_at', { ascending: false }).limit(100);
  (data || []).reverse().forEach((r) => receiveNotice(fromRow(r)));
  channel = db.channel('notices:' + code)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notices', filter: `event_code=eq.${code}` }, (payload) => receiveNotice(fromRow(payload.new)))
    .subscribe();
}

// ───────── 상태 바꾸기 ─────────

function rememberEvent(code) {
  if (!state.myCodes.includes(code)) { state.myCodes.push(code); store.set('myEvents', state.myCodes); }
}

function forgetEvent(code) {
  state.myCodes = state.myCodes.filter((c) => c !== code);
  store.set('myEvents', state.myCodes);
  if (state.participant?.code === code) leaveEvent();
}

function saveParticipant() {
  store.set('participant', state.participant);
  syncSpot();
  syncNotices();
}

function leaveEvent() {
  state.participant = null;
  state.spots = [];
  saveParticipant();
  render();
}

/** [줄에 섰어요] 켜기/끄기 — 줄서기 시작 전에는 막고, 위치 제한 공연은 현장에서만 (standing_toggle.dart) */
async function setStanding(on) {
  const c = current();
  if (!c) return;
  if (on) {
    if (c.z.entryAt && c.z.entryAt > Date.now()) return;
    if (c.z.location) {
      state.checking = true;
      render();
      const denied = await checkLocation(c.z.location);
      state.checking = false;
      if (denied) { render(); dialog('공연장에서만 사용할 수 있습니다', denied); return; }
    }
  }
  state.participant.standing = on;
  saveParticipant();
  refreshSpots();
  render();
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

/** 화면 아래에 잠깐 뜨는 한 줄 (앱의 SnackBar) */
let hintTimer = null;
function hint(text) {
  let el = document.getElementById('snack');
  if (!el) { el = document.createElement('div'); el.id = 'snack'; document.body.appendChild(el); }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.hidden = true; }, 1200);
}

let toastTimer = null;
function toast(n) {
  const el = document.getElementById('toast');
  const k = kind(n.kind);
  el.innerHTML = `<span style="color:${k.color}">${ic(k.icon)}</span><div><b>${esc(k.title)}</b><span class="hint">${esc(n.message)}</span></div>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/** AlertDialog. actions: [{label, id, danger}] — 누른 id 로 resolve */
function dialog(title, body, actions = [{ label: '확인', id: 'ok' }]) {
  return new Promise((resolve) => {
    $sheet.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><p>${esc(body)}</p><div class="acts">${actions
      .map((a) => `<button class="text-btn" data-dialog="${a.id}"${a.danger ? ' style="color:var(--red)"' : ''}>${esc(a.label)}</button>`).join('')}</div></div>`;
    $sheet.hidden = false;
    dialogDone = (id) => { $sheet.hidden = true; dialogDone = null; resolve(id); };
  });
}
let dialogDone = null;

/** 줄에 섰어요 토글 (StandingToggle). compact 는 카드 안 48 높이 */
function standingToggle(c, compact = false) {
  const cls = `filled big${compact ? ' compact' : ''}`;
  const left = c.z.entryAt ? c.z.entryAt.getTime() - Date.now() : 0; // 구역마다 다를 수 있다
  if (!c.p.standing && left > 0) {
    return `<button class="${cls}" disabled>${ic('schedule')}<span>줄서기 ${remainingText(left)} 뒤 시작</span></button>
      <div class="hint center" style="font-size:12px;margin-top:4px">${koreanShort(c.z.entryAt)} 부터 줄설 수 있습니다.</div>`;
  }
  if (state.checking) return `<button class="${cls}" disabled>${ic('person_pin_circle')}<span>위치 확인 중…</span></button>`;
  return c.p.standing
    ? `<button class="${cls} grey" data-action="stand-off">${ic('logout')}<span>줄에서 나왔어요</span></button>`
    : `<button class="${cls}" data-action="stand-on">${ic('person_pin_circle')}<span>줄에 섰어요</span></button>`;
}

const appbar = (title, { back, actions = '' } = {}) => `
  <header class="appbar">
    ${back ? `<button class="icon-btn lead" data-go="${back}" aria-label="뒤로">${ic('arrow_back_ios_new', '', 22)}</button>` : ''}
    <h1>${esc(title)}</h1>
    <div class="acts">${actions}</div>
  </header>`;

// ───────── 화면 (lib/ui/*.dart 를 그대로) ─────────

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'e' && parts[1]) return { name: 'entry', code: parts[1].toUpperCase(), edit: parts[2] === 'edit' };
  if (parts[0] === 'q') return { name: 'queue' };
  if (parts[0] === 'line') return { name: 'line' };
  if (parts[0] === 'account') return { name: 'account' };
  if (parts[0] === 'scan') return { name: 'scan' };
  return { name: 'home' };
}
const go = (hash) => { location.hash = hash; };

// home.dart
function viewHome() {
  const c = current();
  const my = state.myCodes.map(eventByCode).filter(Boolean).sort((a, b) => a.date - b.date);
  const unread = unreadCount();
  const cards = my.map((e) => {
    const joined = c && c.e.code === e.code;
    return `<div class="card event-card" data-card="${e.code}" data-go="${joined ? '#/q' : '#/e/' + e.code}">
      <h3>${esc(e.title)}</h3>
      <div class="meta" style="margin-top:8px">${ic('calendar_today', 'outlined')}<span>${koreanShort(e.date)}</span></div>
      <div class="meta" style="margin-top:4px">${ic('place', 'outlined')}<span>${esc(e.venue)}</span></div>
      <div style="height:14px"></div>
      ${joined && c.z.seated ? `
        ${entryBanner()}
        <div class="seat"><span><b>${esc(c.z.name)}</b>&nbsp;&nbsp;<span class="hint">지정석</span></span>
          <button class="text-btn tight" data-go="#/e/${e.code}/edit">구역 변경</button></div>`
      : joined ? `
        ${entryBanner()}
        <div class="seat"><span><span class="hint">${esc(c.z.name)} · ${esc(c.q.name)}&nbsp;&nbsp;</span><b>${c.p.ticket}번</b></span>
          <button class="text-btn tight" data-go="#/e/${e.code}/edit">번호 수정</button></div>
        <div style="height:10px"></div>
        ${standingToggle(c, true)}
        <div style="height:4px"></div>
        <div class="links"><button class="text-btn" data-go="#/line">${ic('grid_view', 'round')}내 자리 찾기</button></div>`
      : `<div style="text-align:right"><button class="filled" data-go="#/e/${e.code}">번호 입력</button></div>`}
    </div>`;
  }).join('');

  return `${appbar('입장번호', { actions: `<button class="icon-btn" data-action="notices" aria-label="알림">${ic(unread ? 'notifications_active' : 'notifications_none')}${unread ? '<span class="badge"></span>' : ''}</button>` })}
    <div class="body">
      <form class="code-row" data-form="code">
        <input id="code" class="input code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="공연 코드 6자리">
        <button class="filled" type="submit">추가</button>
      </form>
      <div id="code-error"></div>
      <div class="section">내 공연</div>
      ${cards ? `<div class="cards">${cards}</div>`
        : `<div class="empty">${ic('confirmation_number', 'outlined')}<p>공연장 QR을 스캔하거나 공연 코드를 입력하면<br>여기에 공연이 추가됩니다.</p></div>`}
    </div>`;
}

// ticket_entry.dart
let entryZone = null;
function viewEntry(r) {
  const e = eventByCode(r.code);
  if (!e) return `${appbar('번호 입력', { back: '#/' })}<div class="center" style="padding-top:40vh">공연을 찾을 수 없습니다</div>`;
  const p = state.participant?.code === e.code ? state.participant : null;
  const locked = !!p && !r.edit;
  if (entryZone == null) entryZone = p?.zone ?? (e.zones.length === 1 ? e.zones[0].name : null);
  const chips = e.zones.map((z) => `<button class="chip ${z.name === entryZone ? 'on' : ''}" data-action="zone" data-zone="${esc(z.name)}" ${locked ? 'disabled' : ''}><b>${esc(z.name)}</b><small>${z.seated ? '지정석' : `${z.min}~${z.max}`}</small></button>`).join('');
  const seated = !!zoneOf(e, entryZone)?.seated;
  return `${appbar(seated ? '구역 선택' : '번호 입력', { back: '#/' })}
    <form class="body" data-form="ticket">
      <h2 class="title-22">${esc(e.title)}</h2>
      <div class="sub-14">${koreanShort(e.date)} · ${esc(e.venue)}</div>
      <div style="height:28px"></div>
      <div class="section-title">구역</div>
      ${e.zones.length ? `<div class="chips">${chips}</div>` : '<div class="hint">아직 구역이 설정되지 않은 공연입니다.</div>'}
      <div id="seated-note" class="hint" style="font-size:13px;margin-top:16px" ${seated ? '' : 'hidden'}>지정석 구역은 입장번호 없이 구역만 고르면 됩니다. 입장이 시작되면 알려 드립니다.</div>
      <div id="ticket-block" ${seated ? 'hidden' : ''}>
        <div style="height:24px"></div>
        <div class="section-title">입장번호</div>
        <input id="ticket" class="input ticket" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="번호 입력" value="${p && !p.seated ? p.ticket : ''}" ${locked ? 'readonly' : ''}>
        <div id="preview"></div>
      </div>
      <div id="ticket-error"></div>
      <div style="height:24px"></div>
      ${locked
        ? `<div class="note">${ic('lock', 'outlined')}<span>확인한 ${seated ? '구역' : '번호'}으로 고정되어 있습니다. 바꾸려면 [수정]을 누르세요.</span></div>
           <div style="height:8px"></div>
           <button type="button" class="filled big" data-go="#/e/${e.code}/edit">${ic('edit')}<span>수정</span></button>
           <div style="height:8px"></div>
           <button type="button" class="text-btn" data-go="#/q">${ic('confirmation_number', 'outlined')}${seated ? '입장 안내 보기' : '내 대기줄 보기'}</button>`
        : `<button class="filled big" id="confirm" ${entryZone ? '' : 'disabled'}>${ic('check')}<span>확인</span></button>`}
    </form>`;
}

function updatePreview() {
  const e = eventByCode(route().code || '');
  const el = document.getElementById('preview');
  if (!e || !el) return;
  const z = zoneOf(e, entryZone);
  if (!z || z.seated) { el.innerHTML = ''; return; }
  const t = parseTicket(document.getElementById('ticket').value);
  const q = t.value != null ? assign(t.value, z).queue : null;
  el.innerHTML = `<div style="height:12px"></div>` + (q
    ? `<div class="card preview-card">${ic('check_circle')}<div><b>${esc(z.name)} · ${esc(q.name)}</b><span class="hint" style="font-size:13px">이 줄의 입장번호 ${rangeText(q)}</span></div></div>`
    : `<div class="hint" style="font-size:13px">${esc(z.name)} 번호 범위: ${z.min}~${z.max}번 · 번호를 넣으면 대기줄이 정해집니다</div>`);
}

// queue_result.dart
function viewQueue() {
  const c = current();
  if (!c) return `${appbar('대기줄 확인', { back: '#/' })}<div class="center" style="padding-top:40vh">참가 정보가 없습니다</div>`;
  if (!c.q) return viewSeated(c);
  return `${appbar('대기줄 확인', { back: '#/' })}
    <div class="body" style="padding-top:20px">
      ${entryBanner(true)}
      <div style="height:12px"></div>
      <div class="center hint" style="font-size:15px">${esc(c.e.title)}</div>
      <div class="center" style="font-size:28px;font-weight:700;margin-top:6px">${esc(c.z.name)}</div>
      <div class="center hint" style="font-size:14px;margin-top:20px">내 입장번호</div>
      <div class="big-number">${c.p.ticket}</div>
      <div style="height:24px"></div>
      <div class="card info"><div class="info-row"><span>대기줄</span><span>${esc(c.q.name)}</span></div><div class="info-row"><span>이 줄 번호</span><span>${rangeText(c.q)}</span></div></div>
      <div style="height:12px"></div>
      <div class="card"><button class="tile two" data-go="#/line"><span class="tile-icon">${ic('grid_view', 'round')}</span><span class="t"><b>내 자리 찾기</b><small>줄 모양에서 내 칸 보기</small></span>${ic('chevron_right', '', 24).replace('class="mi', 'class="chev mi')}</button></div>
    </div>
    <div class="bottom-actions">${standingToggle(c)}<button class="text-btn" data-go="#/e/${c.e.code}/edit">번호 변경</button></div>`;
}

// queue_result.dart _seated: 지정석은 내 구역과 입장 상태만
function viewSeated(c) {
  const entered = myEntryState();
  return `${appbar('입장 안내', { back: '#/' })}
    <div class="body" style="padding-top:20px">
      ${entryBanner(true)}
      <div style="height:12px"></div>
      <div class="center hint" style="font-size:15px">${esc(c.e.title)}</div>
      <div class="center hint" style="font-size:14px;margin-top:20px">내 구역</div>
      <div class="center" style="font-size:40px;font-weight:800;line-height:1.2">${esc(c.z.name)}</div>
      <div class="center hint" style="font-size:15px;margin-top:4px">지정석</div>
      <div style="height:24px"></div>
      ${entered || myEntryStart() ? '' : `<div class="card"><div class="tile two"><span class="tile-icon">${ic('notifications_active', 'outlined')}</span><span class="t"><b>입장 전입니다</b><small>입장이 시작되면 이 화면과 알림으로 알려 드립니다.</small></span></div></div>`}
    </div>
    <div class="bottom-actions"><button class="text-btn" data-go="#/e/${c.e.code}/edit">구역 변경</button></div>`;
}

// line_map.dart
function viewLine() {
  const c = current();
  if (!c?.q) return `${appbar('내 자리 찾기', { back: '#/q' })}<div class="center" style="padding-top:40vh">참가 정보가 없습니다</div>`;
  const { p, z, q } = c;
  const standing = new Set(state.spots.filter((s) => s.standing).map((s) => s.n));
  // 내 칸은 이 기기의 [줄에 섰어요] 상태를 따른다 (나온 직후 서버 줄 현황이 아직 '서 있음'이어도)
  if (p.standing) standing.add(p.ticket); else standing.delete(p.ticket);
  const isStand = (n) => (n === p.ticket ? p.standing : standing.has(n));
  const total = q.max - q.min + 1;
  const drawn = (q.map?.slots || []).filter((s) => s.n >= q.min && s.n <= q.max);
  const slot = (n) => `<div class="slot${isStand(n) ? ' stand' : ''}${n === p.ticket ? ' mine' : ''}"${n === p.ticket ? ' id="my-slot"' : ''}>${n}</div>`;
  const linear = (numbers) => `<ul class="line-list">${numbers.map((n, i) => `
    <li class="${isStand(n) ? 'stand' : ''} ${n === p.ticket ? 'mine' : ''}">
      <span class="rail"><span class="${i === 0 ? 'none' : ''}"></span><em></em><span class="${i === numbers.length - 1 ? 'none' : ''}"></span></span>
      ${slot(n)}
      ${n === p.ticket ? '<span class="tag mine">내 번호</span>' : isStand(n) ? '<span class="tag">서 있음</span>' : ''}
    </li>`).join('')}</ul>`;

  // 기준 줄: 내 번호가 든 가로줄(같은 y)/세로줄(같은 x)
  const byRows = q.map?.axis === 'rows';
  const mineSlot = q.map?.axis ? drawn.find((s) => s.n === p.ticket) : null;
  const key = (s) => (byRows ? s.y : s.x);
  const lineNums = new Set(mineSlot ? drawn.filter((s) => key(s) === key(mineSlot)).map((s) => s.n) : []);
  const lineNo = mineSlot ? new Set(drawn.filter((s) => key(s) < key(mineSlot)).map(key)).size + 1 : 0;
  const myLine = lineNums.size > 0 && !state.wholeMap; // [내 줄 보기]
  // 서 있는 사람만: 내 줄 보기면 내 줄에 선 사람만
  const standingList = [...standing].filter((n) => !myLine || lineNums.has(n)).sort((a, b) => a - b);
  // 앱 바의 켜고 끄는 아이콘 (line_map.dart _ToggleIcon): 켜지면 파란 바탕
  const toggle = (action, icon, on, onLabel, offLabel) =>
    `<button class="icon-btn toggle${on ? ' sel' : ''}" data-action="${action}" data-v="${on ? '0' : '1'}" data-on="${onLabel}" data-off="${offLabel}" aria-pressed="${on}" aria-label="${on ? onLabel : offLabel}" title="${on ? onLabel : offLabel}">${ic(icon, on ? '' : 'outlined')}</button>`;
  // 내 줄 안 순서와 앞뒤 사람 (line_map.dart _MyLineCard · 내 앞/내 뒤 꼬리표)
  const lineSorted = [...lineNums].sort((a, b) => a - b);
  const myRank = lineSorted.indexOf(p.ticket);
  const frontN = myRank > 0 ? lineSorted[myRank - 1] : null;
  const backN = myRank >= 0 && myRank < lineSorted.length - 1 ? lineSorted[myRank + 1] : null;
  const lineStanding = lineSorted.filter(isStand).length;
  const switches = myLine ? `
      <div class="line-card"><span class="ico">${ic(byRows ? 'table_rows' : 'view_week', 'round')}</span><div>
        <small>내 줄</small><b>${byRows ? '앞에서' : '왼쪽에서'} ${lineNo}번째 ${byRows ? '가로줄' : '세로줄'}</b>
        <span class="hint">${lineNums.size}칸${myRank >= 0 ? ` · 이 줄 ${myRank + 1}번째` : ''} · 서 있는 사람 ${lineStanding}명</span></div></div>` : '';
  // 내 줄 확대의 큰 칸 / 옆 줄 반쪽 칸
  const bigSlot = (n, front = frontN, back = backN) => {
    const mine = n === p.ticket, st = isStand(n);
    const tag = mine ? '내 자리' : n === front ? '내 앞' : n === back ? '내 뒤' : st ? '서 있음' : '';
    return `<div class="fslot${st ? ' stand' : ''}${mine ? ' mine' : ''}"${mine ? ' id="my-slot"' : ''}><b>${n}</b>${tag ? `<em>${tag}</em>` : ''}</div>`;
  };
  const at = new Map(drawn.map((s) => [`${s.x},${s.y}`, s.n]));
  const peek = (x, y, side) => (at.has(`${x},${y}`) ? `<div class="peek ${side}">${slot(at.get(`${x},${y}`)).replace(' id="my-slot"', '')}</div>` : '<div class="peek"></div>');
  // 내 줄 보기: 내 줄 밖 칸은 흐리게
  const cell = (n) => (myLine && !lineNums.has(n) ? `<div class="dim">${slot(n)}</div>` : slot(n));

  let body;
  // 내 줄 확대 + 서 있는 사람만: 같은 큰 칸 모양으로, 내 줄에 선 사람만 (세로줄은 위→아래, 가로줄은 옆으로)
  const si = standingList.indexOf(p.ticket);
  const bigStand = (n) => bigSlot(n, si > 0 ? standingList[si - 1] : null, si >= 0 ? standingList[si + 1] : null);
  if (myLine && drawn.length && state.onlyStanding && standingList.length) {
    body = byRows
      ? `<div class="frow-wrap"><div class="frow bigs" style="grid-template-columns:repeat(${standingList.length},minmax(84px,1fr))">${standingList.map(bigStand).join('')}</div></div>`
      : standingList.map((n) => `<div class="fcol-row"><div class="peek"></div>${bigStand(n)}<div class="peek"></div></div>`).join('');
  } else if (myLine && drawn.length && !state.onlyStanding && !byRows) {
    // 세로줄 확대: 내 세로줄이 화면 폭을 채우고, 양옆 세로줄은 가장자리에 반쯤만 흐리게
    const ys = drawn.filter((s) => lineNums.has(s.n)).map((s) => s.y);
    const rows = [];
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      const n = at.get(`${mineSlot.x},${y}`);
      rows.push(`<div class="fcol-row">${peek(mineSlot.x - 1, y, 'l')}${n == null ? '<div></div>' : bigSlot(n)}${peek(mineSlot.x + 1, y, 'r')}</div>`);
    }
    body = rows.join('');
  } else if (myLine && drawn.length && !state.onlyStanding) {
    // 가로줄 확대: 내 가로줄을 크게, 앞뒤 가로줄은 위아래에 반쯤만 (칸이 많으면 옆으로 넘긴다)
    const xs = drawn.map((s) => s.x), minX = Math.min(...xs), maxX = Math.max(...xs);
    const y = mineSlot.y, cells = [], top = [], bottom = [];
    for (let x = minX; x <= maxX; x++) {
      top.push(peek(x, y - 1, 't'));
      const n = at.get(`${x},${y}`);
      cells.push(n == null ? '<div></div>' : bigSlot(n));
      bottom.push(peek(x, y + 1, 'b'));
    }
    const grid = (items, cls) => `<div class="frow ${cls}" style="grid-template-columns:repeat(${maxX - minX + 1},minmax(84px,1fr))">${items.join('')}</div>`;
    body = `<div class="frow-wrap">${grid(top, 'peeks')}${grid(cells, 'bigs')}${grid(bottom, 'peeks')}</div>`;
  } else if (state.onlyStanding) {
    body = standingList.length ? linear(standingList) : `<div class="hint center" style="padding:30px 20px">아직 이 줄에 선 사람이 없습니다.</div>`;
  } else if (drawn.length) {
    // 주최 측이 그린 배치도 그대로 (빈 자리는 빈칸)
    const ys = drawn.map((s) => s.y), minY = Math.min(...ys), maxY = Math.max(...ys);
    const rows = [];
    for (let y = minY; y <= maxY; y++) {
      const byX = new Map(drawn.filter((s) => s.y === y).map((s) => [s.x, s.n]));
      const cells = [];
      // 내 줄 보기: 내 줄에 띠를 깔아 강조
      for (let x = 0; x < q.map.cols; x++) cells.push(`<div${myLine && !byRows && x === mineSlot.x ? ' class="my-line"' : ''}>${byX.has(x) ? cell(byX.get(x)) : ''}</div>`);
      rows.push(`<div class="map-row${myLine && byRows && y === mineSlot.y ? ' my-line' : ''}" style="grid-template-columns:repeat(${q.map.cols},1fr)">${cells.join('')}</div>`);
    }
    body = rows.join('');
  } else {
    body = linear(Array.from({ length: total }, (_, i) => q.min + i));
  }

  const actions = `${lineNums.size ? toggle('my-line', byRows ? 'table_rows' : 'view_week', !state.wholeMap, '내 줄 보기', '전체 줄 보기') : ''}${toggle('only-standing', 'person', state.onlyStanding, '서 있는 사람만', '전체 칸 보기')}<button class="icon-btn" data-action="refresh-spots" aria-label="새로고침">${state.loadingSpots ? '<span class="hint" style="font-size:12px">…</span>' : ic('refresh')}</button>`;
  return `<header class="appbar wide"><button class="icon-btn lead" data-go="#/q" aria-label="뒤로">${ic('arrow_back_ios_new', '', 22)}</button><h1>내 자리 찾기</h1><div class="acts">${actions}</div></header>
    <div class="line-head">
      <h2>${esc(z.name)} · ${esc(q.name)}</h2>
      <div class="hint">${state.onlyStanding ? `${rangeText(q)} · 서 있는 사람 ${standingList.length}명만 보는 중` : `${rangeText(q)} · ${standing.size}/${total}명 서 있음`}</div>
      ${state.spotsError ? `<div class="error">${ic('warning', 'round')}<span>줄 현황을 받지 못했습니다. ${esc(state.spotsError)}</span></div>` : ''}
      <div class="legend"><span><i style="background:var(--accent)"></i>줄에 서 있음</span><span><i style="background:var(--orange)"></i>내 번호</span><span><i style="border:1px solid color-mix(in srgb, var(--hint) 67%, transparent)"></i>빈칸</span></div>
      ${switches}
      <div class="dir">${ic('keyboard_double_arrow_up')}<span>${drawn.length && !state.onlyStanding ? '입장 방향 (줄 앞) · 주최 측이 그린 줄 배치' : '입장 방향 (줄 앞)'}</span></div>
      <div style="height:6px"></div>
    </div>
    ${body}
    <div class="dir" style="padding:10px 20px 24px">${ic('keyboard_double_arrow_down')}<span>줄 뒤</span></div>
    <div class="bottom-actions" style="padding-bottom:10px">${standingToggle(c)}
      <div class="hint center" style="font-size:12px;margin-top:4px">${p.standing ? '내 칸이 줄에 표시되고 있습니다.' : '자리를 찾아 선 뒤 [줄에 섰어요]를 누르면 내 칸이 채워집니다.'}</div>
    </div>`;
}

// account.dart
const PROVIDERS = [
  { name: 'nol', label: 'NOL 티켓', color: '#7B2FF2' },
  { name: 'yes24', label: 'YES24 티켓', color: '#1E88E5' },
  { name: 'melon', label: '멜론 티켓', color: '#00C73C' },
  { name: 'ticketlink', label: '티켓링크', color: '#E53935' },
];
function viewAccount() {
  const c = current();
  const rows = (items) => items.filter(Boolean).join('<div class="divider"></div>');
  const mine = c ? rows([
    `<div class="tile two"><span class="t"><b style="font-weight:600">${esc(c.e.title)}</b><small>${c.q ? `${esc(c.z.name)} · ${esc(c.q.name)} · ${c.p.ticket}번` : `${esc(c.z.name)} · 지정석`}</small></span></div>`,
    // 지정석은 줄이 없다
    c.q && `<label class="tile two">${ic('person_pin_circle', 'outlined')}<span class="t"><b>줄에 서 있음</b><small>켜면 줄 현황에 내 위치가 표시됩니다.</small></span>
      <span class="switch"><input type="checkbox" data-action="stand-switch" ${c.p.standing ? 'checked' : ''}><i></i></span></label>`,
    `<button class="tile" data-action="leave"><span class="mi material-icons" style="color:var(--red)">logout</span><span class="t"><b style="color:var(--red)">공연에서 나가기</b></span></button>`,
  ]) : `<div class="tile"><span class="t"><b class="hint">참가 중인 공연이 없습니다.</b></span></div>`;
  const providers = rows(PROVIDERS.map((p) => `
    <button class="tile two" data-action="provider"><span class="logo"><img src="providers/${p.name}.png" alt=""></span>
      <span class="t"><b>${p.label}</b><small>연결된 계정 없음</small></span>${ic('chevron_right', '', 20)}</button>`));
  return `${appbar('계정')}
    <div class="group-header">내 참가</div>
    <div class="card group">${mine}</div>
    <div class="group-header">예매처 계정 연결</div>
    <div class="card group">${providers}</div>
    <div class="group-footer">예매처와 API 제휴가 되면 연결한 계정의 예매 내역에서 공연·구역·입장번호가 자동으로 채워집니다. 예매처 계정 연결은 앱에서 할 수 있습니다.</div>
    <div style="height:32px"></div>`;
}

// qr_join.dart
function viewScan() {
  return `<header class="appbar"><span></span><h1>QR 스캔으로 참가</h1><div class="acts"><button class="text-btn" data-go="#/">닫기</button></div></header>
    <div class="scanner" id="scanner"><span style="padding:24px">카메라를 켜는 중…</span></div>
    <form class="body" data-form="scan" style="padding-top:20px">
      <div id="scan-error"></div>
      <div class="hint">공연장 입구의 QR 을 비추면 바로 번호 입력으로 이동합니다.</div>
      <div style="height:12px"></div>
      <div class="code-row"><input id="scan-code" class="input code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="또는 공연 코드 입력 (6자리)" style="height:44px;font-size:16px"><button class="filled">참가</button></div>
    </form>`;
}

let scanner = null;
async function startScanner() {
  if (!window.Html5Qrcode || scanner) return;
  const el = document.getElementById('scanner');
  if (!el) return;
  el.innerHTML = '';
  scanner = new window.Html5Qrcode('scanner', { verbose: false });
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 10 }, (text) => handleScan(text), () => {});
  } catch {
    scanner = null;
    el.innerHTML = '<span style="padding:24px">카메라 권한이 필요합니다. 설정에서 허용해 주세요.</span>';
  }
}
async function stopScanner() {
  if (!scanner) return;
  const s = scanner;
  scanner = null;
  try { await s.stop(); } catch { /* 이미 멈춤 */ }
}

/** QR 내용(참가 링크 또는 코드)에서 공연 코드 — root.dart JoinLink.code 와 같은 규칙 */
function joinCode(raw) {
  const text = String(raw).trim();
  try {
    const u = new URL(text);
    const s = u.protocol.replace(':', '').toLowerCase();
    const path = u.pathname.toLowerCase();
    const ok = s === 'standingqueue' ? (u.hostname.toLowerCase() === 'join' || path.startsWith('/join') || path.startsWith('//join'))
      : (s === 'https' || s === 'http') && /\/join(\/|\.html)?$/.test(path);
    const c = u.searchParams.get('code')?.toUpperCase();
    if (ok && c && c.length === 6) return c;
  } catch { /* URL 아님 */ }
  const plain = text.toUpperCase();
  return /^[A-Z0-9]{6}$/.test(plain) ? plain : null;
}

async function handleScan(raw) {
  const code = joinCode(raw);
  let e = code && eventByCode(code);
  if (code && !e) { await loadCatalog(); e = eventByCode(code); }
  const err = document.getElementById('scan-error');
  if (!e) {
    if (err) err.innerHTML = `<div class="error" style="margin:0 0 8px">${esc(code ? `공연 코드 ${code} 를 찾을 수 없습니다.` : '입장번호 앱의 참가 QR 이 아닙니다.')}</div>`;
    return;
  }
  await stopScanner();
  openEvent(e.code);
}

function viewNotices() {
  const c = current();
  const list = myNotices();
  return `<div class="sheet-body">
    ${appbar('알림', { actions: '<button class="text-btn" data-action="close-sheet">닫기</button>' })}
    ${!c ? `<div class="center" style="padding:32px"><div style="padding-top:18vh">${ic('notifications_off', 'outlined', 48).replace('class="mi', 'class="hint mi')}</div>
        <div style="font-size:18px;font-weight:600;margin-top:12px">알림이 없습니다</div>
        <div class="hint" style="margin-top:6px">공연에 참가하면 주최 측의 현장 안내(뒤로 이동, 입장 준비 등)를 여기서 받습니다.</div></div>`
      : `<div class="tile two"><span style="color:var(--accent)">${ic('confirmation_number')}</span><span class="t"><b style="font-weight:600">${esc(c.e.title)}</b><small>${c.q ? `${esc(c.q.name)} · ${rangeText(c.q)}` : `${esc(c.z.name)} · 지정석`} · ${koreanShort(c.e.date)}</small></span></div>
         <div class="divider-full"></div>
         <div class="hint" style="padding:8px 16px 4px">주최 측 안내</div>
         ${list.length ? list.map((n) => `<div class="tile two"><span style="color:${kind(n.kind).color}">${ic(kind(n.kind).icon)}</span>
            <span class="t"><span style="display:flex"><b style="font-weight:700;font-size:15px;flex:1">${kind(n.kind).title}</b><span class="hint" style="font-size:12px">${timeShort(new Date(n.at))}</span></span><small>${esc(n.message)}</small></span></div>`).join('')
          : '<div class="hint" style="padding:16px">아직 받은 안내가 없습니다.</div>'}`}
  </div>`;
}

// root.dart 하단바: 홈 · QR 스캔 · 계정
function renderTabbar() {
  const r = route().name;
  const onAccount = r === 'account';
  $tabbar.hidden = r === 'scan';
  $tabbar.innerHTML = `<div>
    <button class="tab ${onAccount ? '' : 'on'}" data-go="#/">${ic(onAccount ? 'home' : 'home', onAccount ? 'outlined' : 'round')}<span>홈</span></button>
    <button class="tab-qr" data-go="#/scan" aria-label="QR 스캔"><span>${ic('qr_code_scanner', 'round')}</span></button>
    <button class="tab ${onAccount ? 'on' : ''}" data-go="#/account">${ic('account_circle', onAccount ? '' : 'outlined')}<span>계정</span></button>
  </div>`;
}

function render() {
  const r = route();
  const focused = document.activeElement?.id;
  if (['ticket', 'code', 'scan-code'].includes(focused)) return; // 입력 중에는 다시 그리지 않는다 (포커스 유지)
  if (r.name === 'scan' && document.getElementById('scanner')) return; // 카메라를 끊지 않게
  $app.innerHTML = r.name === 'entry' ? viewEntry(r) : r.name === 'queue' ? viewQueue() : r.name === 'line' ? viewLine()
    : r.name === 'account' ? viewAccount() : r.name === 'scan' ? viewScan() : viewHome();
  renderTabbar();
  if (r.name === 'entry') updatePreview();
  if (r.name === 'scan') startScanner();
}

// ───────── 이벤트 ─────────

// 카드 길게 누르기 → 삭제 (home.dart onLongPress)
let pressTimer = null, longPressed = false;
$app.addEventListener('pointerdown', (ev) => {
  const card = ev.target.closest('[data-card]');
  if (!card || ev.target.closest('button')) return;
  longPressed = false;
  pressTimer = setTimeout(async () => {
    longPressed = true;
    const e = eventByCode(card.dataset.card);
    const id = await dialog(`${e?.title ?? ''} 삭제`, '내 공연 목록에서 지웁니다. QR이나 코드로 다시 추가할 수 있습니다.',
      [{ label: '취소', id: 'cancel' }, { label: '삭제', id: 'delete', danger: true }]);
    if (id === 'delete') { forgetEvent(card.dataset.card); render(); }
  }, 550);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => $app.addEventListener(t, () => clearTimeout(pressTimer)));
$app.addEventListener('contextmenu', (ev) => { if (ev.target.closest('[data-card]')) ev.preventDefault(); });

$app.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-go],[data-action]');
  if (!t) return;
  if (longPressed) { longPressed = false; ev.preventDefault(); return; }
  if (t.dataset.go) { ev.preventDefault(); ev.stopPropagation(); go(t.dataset.go); return; }
  const a = t.dataset.action;
  if (a === 'zone') {
    entryZone = t.dataset.zone;
    document.querySelectorAll('.chip').forEach((b) => b.classList.toggle('on', b.dataset.zone === entryZone));
    const btn = document.getElementById('confirm');
    if (btn) btn.disabled = false;
    document.getElementById('ticket-error').innerHTML = '';
    const seated = !!zoneOf(eventByCode(route().code || ''), entryZone)?.seated;
    document.getElementById('ticket-block').hidden = seated;
    document.getElementById('seated-note').hidden = !seated;
    document.querySelector('.appbar h1').textContent = seated ? '구역 선택' : '번호 입력';
    updatePreview();
    if (!seated) document.getElementById('ticket').focus();
  } else if (a === 'stand-on') {
    setStanding(true);
  } else if (a === 'stand-off') {
    setStanding(false);
  } else if (a === 'notices') {
    $sheet.innerHTML = viewNotices();
    $sheet.hidden = false;
    state.noticesReadAt = Date.now();
    store.set('noticesReadAt', state.noticesReadAt);
  } else if (a === 'only-standing') {
    state.onlyStanding = t.dataset.v === '1';
    render();
    hint(state.onlyStanding ? t.dataset.on : t.dataset.off);
  } else if (a === 'my-line') {
    state.wholeMap = t.dataset.v === '0';
    render();
    hint(state.wholeMap ? t.dataset.off : t.dataset.on);
  } else if (a === 'refresh-spots') {
    refreshSpots();
    loadCatalog().then(render); // 관리자가 방금 바꿔 게시한 배치도·기준 줄도 반영
  } else if (a === 'leave') {
    leaveEvent();
  } else if (a === 'provider') {
    dialog('예매처 계정 연결', '예매처 계정 연결은 입장번호 앱에서 할 수 있습니다.');
  }
});

$app.addEventListener('change', (ev) => {
  if (ev.target.dataset.action === 'stand-switch') {
    const on = ev.target.checked;
    ev.target.checked = !on; // 결과는 다시 그릴 때 반영
    setStanding(on);
  }
});

$sheet.addEventListener('click', (ev) => {
  const d = ev.target.closest('[data-dialog]');
  if (d && dialogDone) { dialogDone(d.dataset.dialog); return; }
  if (ev.target === $sheet || ev.target.closest('[data-action="close-sheet"]')) {
    if (dialogDone) { dialogDone('cancel'); return; }
    $sheet.hidden = true;
    render();
  }
});

$tabbar.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-go]');
  if (t) go(t.dataset.go);
});

$app.addEventListener('input', (ev) => {
  if (ev.target.id === 'ticket') {
    ev.target.value = ev.target.value.replace(/[^0-9]/g, '');
    document.getElementById('ticket-error').innerHTML = '';
    updatePreview();
  } else if (ev.target.id === 'code') {
    document.getElementById('code-error').innerHTML = '';
  }
});

const errorLine = (msg) => `<div class="error">${ic('warning', 'round')}<span>${esc(msg)}</span></div>`;

$app.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target.dataset.form;
  if (form === 'code') {
    const input = document.getElementById('code');
    const raw = input.value.trim().toUpperCase();
    const err = document.getElementById('code-error');
    if (!raw) { err.innerHTML = errorLine('공연 코드를 입력해 주세요.'); return; }
    let e = eventByCode(raw);
    if (!e) { await loadCatalog(); e = eventByCode(raw); } // 방금 게시된 공연일 수 있다
    if (!e) { err.innerHTML = errorLine(`공연 코드 '${raw}' 를 찾을 수 없습니다. 주최 측 안내를 확인해 주세요.`); return; }
    input.value = '';
    input.blur();
    rememberEvent(e.code);
    entryZone = null;
    go('#/e/' + e.code);
  } else if (form === 'scan') {
    document.getElementById('scan-code').blur();
    handleScan(document.getElementById('scan-code').value);
  } else if (form === 'ticket') {
    const e = eventByCode(route().code);
    const z = zoneOf(e, entryZone);
    const input = document.getElementById('ticket');
    const err = document.getElementById('ticket-error');
    const btn = document.getElementById('confirm');
    if (!e || !z || input.readOnly || !btn || btn.disabled) return;
    // 지정석은 번호 없이 구역만
    const t = z.seated ? {} : parseTicket(input.value);
    if (t.error) { err.innerHTML = errorLine(t.error); return; }
    const a = z.seated ? {} : assign(t.value, z);
    if (a.error) { err.innerHTML = errorLine(a.error); return; }
    if (z.location) {
      btn.disabled = true;
      btn.innerHTML = `${ic('check')}<span>위치 확인 중…</span>`;
      const denied = await checkLocation(z.location);
      btn.disabled = false;
      btn.innerHTML = `${ic('check')}<span>확인</span>`;
      if (denied) { err.innerHTML = errorLine(denied); return; }
    }
    const old = state.participant;
    if (z.seated) {
      state.participant = { code: e.code, zone: z.name, seated: true };
    } else {
      const same = old?.code === e.code && old.zone === z.name && old.queue === a.queue.name && old.ticket === t.value;
      state.participant = { code: e.code, zone: z.name, queue: a.queue.name, ticket: t.value, standing: same ? !!old.standing : false };
    }
    rememberEvent(e.code);
    saveParticipant();
    input.blur();
    go('#/q');
  }
});

/** 공연 열기: 이미 번호를 넣었으면 대기줄 확인, 아니면 번호 입력 (root.dart openEvent) */
function openEvent(code) {
  rememberEvent(code);
  entryZone = null;
  go(state.participant?.code === code && current() ? '#/q' : '#/e/' + code);
}

function scrollToMine() {
  setTimeout(() => document.getElementById('my-slot')?.scrollIntoView({ block: 'center', inline: 'center' }), 30);
}

window.addEventListener('hashchange', () => {
  const r = route();
  if (r.name !== 'entry') entryZone = null;
  if (r.name !== 'scan') stopScanner();
  clearInterval(spotPoll);
  spotPoll = null;
  if (r.name === 'line') { refreshSpots(); loadCatalog().then(render); spotPoll = setInterval(refreshSpots, 15e3); }
  document.activeElement?.blur?.();
  render();
  window.scrollTo(0, 0);
  if (r.name === 'line') scrollToMine();
});

// 입장까지 남은 시간: 1초마다 글자만 바꾼다 (화면 전체를 다시 그리지 않는다)
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdownBig(Number(el.dataset.countdown)); });
  document.querySelectorAll('[data-clock]').forEach((el) => { el.innerHTML = clockInner(Number(el.dataset.clock)); });
}, 1000);

// 줄서기 시작까지 남은 시간 갱신 (시각이 되면 자동으로 눌리게)
setInterval(() => {
  const c = current();
  if (c?.z.entryAt && !c.p.standing && c.z.entryAt > Date.now() - 2000 && ['home', 'queue', 'line'].includes(route().name)) render();
}, 1000);

// 화면을 보고 있는 동안 30초마다: 관리자가 다시 게시한 입장 시각·대기줄·배치도를 따라잡는다 (바뀌었을 때만 다시 그림)
setInterval(async () => {
  if (document.visibilityState !== 'visible') return;
  const before = store.get('catalog', null);
  await loadCatalog();
  if (store.get('catalog', null) !== before && ['home', 'queue', 'line'].includes(route().name)) render();
}, 30e3);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { loadCatalog().then(render); syncSpot(); }
});

// ───────── 시작 ─────────

(async function start() {
  render();
  await loadCatalog();
  // 참가 QR: …/join?code=XXXXXX → 그 공연으로 바로
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code) {
    const keep = location.hostname === 'localhost' && params.get('catalog') ? '?catalog=' + encodeURIComponent(params.get('catalog')) : '';
    history.replaceState(null, '', location.pathname.replace(/join(\.html)?\/?$/, '') + keep);
    const e = eventByCode(code);
    if (e) openEvent(e.code);
    else { render(); dialog('참가할 수 없습니다', 'QR 링크의 공연을 찾을 수 없습니다.'); }
  }
  syncSpot();
  syncNotices();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
})();
