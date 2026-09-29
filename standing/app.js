// 관객 웹. 앱(flutter/apps/audience)과 같은 서버·같은 규칙:
// - catalog.json(관리자 게시)으로 공연/구역/대기줄 → 번호로 대기줄 배정 (standing_core QueueLogic 과 동일)
// - 줄 현황: take_spot / leave_spot / line_spots RPC
// - 현장 안내: notices 테이블 최근 6시간 + Realtime
// - 공연장 위치 제한, 줄서기 시작 시각
// 블루투스 앞뒤 번호 찾기와 푸시 알림은 앱에만 있다.
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
  catalogNotices: [],
  myCodes: store.get('myEvents', []),
  /** {code, zone, queue, ticket, standing} — 구역/대기줄은 이름으로 저장 */
  participant: store.get('participant', null),
  deviceId: store.get('deviceId', null) || newDeviceId(),
  notices: store.get('notices', []),
  noticesReadAt: store.get('noticesReadAt', 0),
  spots: [],
  spotsError: null,
  onlyStanding: false,
};
store.set('deviceId', state.deviceId);

function newDeviceId() {
  return (crypto.randomUUID && crypto.randomUUID()) || 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ───────── 카탈로그 ─────────

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
  return slots.length ? { cols: +raw.cols || 16, slots } : null;
}

function parseCatalog(text) {
  const root = JSON.parse(text);
  const events = [];
  for (const e of root.events || []) {
    const code = String(e.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code) || events.some((x) => x.code === code)) continue;
    const zones = (e.zones || []).map((z) => {
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
      return { name: z.name || '', min: z.min, max: z.max, queues: specs };
    });
    const loc = e.location && typeof e.location.lat === 'number' && typeof e.location.lng === 'number'
      ? { lat: e.location.lat, lng: e.location.lng, radius: e.location.radius || 300 } : null;
    events.push({
      code, title: e.title || '', date: parseDate(e.date), entryAt: e.entry ? parseDate(e.entry) : null,
      venue: e.venue || '', description: e.description || '', zones, location: loc,
    });
  }
  const notices = (root.notices || []).map((n) => ({
    id: 'catalog:' + n.id, code: String(n.event || '').toUpperCase(), zone: n.zone || null, queue: n.queue || null,
    min: n.min ?? null, max: n.max ?? null, kind: n.kind || 'info', message: n.message || KINDS[n.kind]?.message || '',
    at: n.createdAt ? parseDate(n.createdAt).getTime() : Date.now(),
  }));
  return { events, notices };
}

function applyCatalog(text) {
  const r = parseCatalog(text);
  state.events = r.events;
  state.catalogNotices = r.notices;
  r.notices.forEach(receiveNotice);
}

async function loadCatalog() {
  const cached = store.get('catalog', null);
  if (cached) { try { applyCatalog(cached); } catch { /* 깨진 캐시는 무시 */ } }
  try {
    const res = await fetch(CONFIG.catalogUrl + '?t=' + Math.floor(Date.now() / 1000), { cache: 'no-store' });
    if (!res.ok) throw new Error('서버 응답 ' + res.status);
    const text = await res.text();
    applyCatalog(text);
    store.set('catalog', text);
  } catch (err) {
    if (!state.events.length) toast('공연 정보를 받지 못했습니다', '인터넷 연결을 확인하고 새로고침해 주세요.');
  }
}

const isPast = (e) => e.date.getTime() + 24 * 3600e3 < Date.now();
const eventByCode = (code) => state.events.find((e) => e.code === String(code).trim().toUpperCase() && !isPast(e)) || null;
const zoneOf = (e, name) => e?.zones.find((z) => z.name === name) || null;
const queueOf = (z, name) => z?.queues.find((q) => q.name === name) || null;
const rangeText = (q) => `${q.min} ~ ${q.max}`;

/** 저장된 참가가 아직 유효하면 {p, e, z, q} */
function current() {
  const p = state.participant;
  if (!p) return null;
  const e = eventByCode(p.code), z = zoneOf(e, p.zone), q = queueOf(z, p.queue);
  return e && z && q ? { p, e, z, q } : null;
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

// ───────── 공연장 위치 제한 ─────────

function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 통과면 null, 아니면 관객에게 보여 줄 메시지 */
function checkLocation(event) {
  const loc = event.location;
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
        ? '이 공연은 공연장 안에서만 사용할 수 있어 위치 권한이 필요합니다. 브라우저 설정에서 위치를 허용해 주세요.'
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
  const c = current();
  if (!c) { db.rpc('leave_spot', { p_device_id: state.deviceId }).then(() => {}, () => {}); return; }
  const report = () => {
    const now = current();
    if (!now) return;
    db.rpc('take_spot', {
      p_event_code: now.e.code, p_device_id: state.deviceId, p_ticket_number: now.p.ticket,
      p_zone: now.z.name, p_queue: now.q.name, p_standing: !!now.p.standing,
    }).then(() => {}, () => {});
  };
  report();
  heartbeat = setInterval(report, 2 * 60e3);
}

async function refreshSpots() {
  const c = current();
  if (!db || !c) return;
  const { data, error } = await db.rpc('line_spots', { p_event_code: c.e.code, p_zone: c.z.name, p_queue: c.q.name, p_within_seconds: 600 });
  if (error) { state.spotsError = error.message; } else { state.spots = (data || []).map((r) => ({ n: +r.ticket_number, standing: r.standing === true })); state.spotsError = null; }
  if (route().name === 'line') render();
}

// ───────── 현장 안내 ─────────

const KINDS = {
  moveBack: { title: '뒤로 이동', message: '대기줄이 밀렸습니다. 뒤로 이동해 주세요.', color: '#FF9500', icon: '⬅' },
  moveForward: { title: '앞으로 이동', message: '앞 공간이 비었습니다. 앞으로 이동해 주세요.', color: '#2F6BFF', icon: '➡' },
  entryReady: { title: '입장 준비', message: '곧 입장합니다. 티켓과 신분증을 준비해 주세요.', color: '#34C759', icon: '🚪' },
  info: { title: '안내', message: '', color: '#AF52DE', icon: '📣' },
};
const kind = (k) => KINDS[k] || KINDS.info;

function targets(n, c) {
  if (!c || n.code !== c.e.code) return false;
  if (n.zone && n.zone !== c.z.name) return false;
  if (n.queue && n.queue !== c.q.name) return false;
  if (n.min != null && n.max != null) {
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
  const c = current();
  if (targets(n, c) && n.at > Date.now() - 10 * 60e3) toast(kind(n.kind).title, n.message);
  render();
}

const myNotices = () => {
  const c = current();
  return c ? state.notices.filter((n) => targets(n, c)).sort((a, b) => b.at - a.at) : [];
};
const unreadCount = () => myNotices().filter((n) => n.at > state.noticesReadAt).length;

let channel = null, channelCode = null;

async function syncNotices() {
  const code = current()?.e.code || null;
  if (code === channelCode) return;
  if (channel) { db.removeChannel(channel); channel = null; }
  channelCode = code;
  if (!db || !code) return;
  const fromRow = (r) => ({
    id: r.id, code: String(r.event_code).toUpperCase(), zone: r.zone, queue: r.queue, min: r.min_number, max: r.max_number,
    kind: r.kind, message: r.message || '', at: new Date(r.created_at).getTime(),
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
}

function setStanding(on) {
  if (!state.participant) return;
  state.participant.standing = on;
  saveParticipant();
  refreshSpots();
  render();
}

// ───────── 화면 도우미 ─────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');
const koreanShort = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const timeShort = (d) => `${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${pad(d.getMinutes())}`;

function remainingText(ms) {
  const min = Math.floor(ms / 60e3);
  if (min < 1) return '곧';
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

function dDay(date) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const now = new Date(), b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((a - b) / 86400e3);
  return days === 0 ? 'D-DAY' : days > 0 ? `D-${days}` : `D+${-days}`;
}

let toastTimer = null;
function toast(title, body) {
  const el = document.getElementById('toast');
  el.innerHTML = `<b>${esc(title)}</b><span class="small hint">${esc(body)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function dialog(title, body) {
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><div class="hint">${esc(body)}</div><div class="actions"><button class="btn-text" data-action="close-sheet">확인</button></div></div>`;
  sheet.style.alignItems = 'center';
  sheet.hidden = false;
}

function standingButton(c) {
  const left = c.e.entryAt ? c.e.entryAt.getTime() - Date.now() : 0;
  if (!c.p.standing && left > 0) {
    return `<button class="btn-grad btn-big btn-gray" disabled>⏱ 줄서기 ${remainingText(left)} 뒤 시작</button>
      <div class="small hint center" style="margin-top:4px">${koreanShort(c.e.entryAt)} 부터 줄설 수 있습니다.</div>`;
  }
  return c.p.standing
    ? `<button class="btn-grad btn-big btn-gray" data-action="stand-off">줄에서 나왔어요</button>`
    : `<button class="btn-grad btn-big" data-action="stand-on">📍 줄에 섰어요</button>`;
}

// ───────── 화면 ─────────

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'e' && parts[1]) return { name: 'entry', code: parts[1].toUpperCase(), edit: parts[2] === 'edit' };
  if (parts[0] === 'q') return { name: 'queue' };
  if (parts[0] === 'line') return { name: 'line' };
  return { name: 'home' };
}
const go = (hash) => { location.hash = hash; };

function viewHome() {
  const c = current();
  const mine = state.myCodes.map(eventByCode).filter(Boolean).sort((a, b) => a.date - b.date);
  const tickets = mine.map((e) => {
    const joined = c && c.e.code === e.code;
    const head = `
      <div class="t-top">
        <div class="grow">
          <span class="pill">${dDay(e.date)}</span>
          <div class="t-title">${esc(e.title)}</div>
          <div class="t-sub">${koreanShort(e.date)}</div>
          ${e.venue ? `<div class="t-sub">${esc(e.venue)}</div>` : ''}
        </div>
        <div class="t-date"><small>${e.date.getMonth() + 1}월</small><b>${e.date.getDate()}</b></div>
        <button class="ticket-x" data-action="forget" data-code="${e.code}" aria-label="내 공연에서 지우기">✕</button>
      </div>`;
    const stub = joined
      ? `<div class="fields">
          <div><div class="f-label">구역</div><div class="f-value">${esc(c.z.name)}</div></div>
          <div><div class="f-label">대기줄</div><div class="f-value">${esc(c.q.name)}</div></div>
          <div><div class="f-label">입장번호</div><div class="f-big">${c.p.ticket}번</div></div>
        </div>
        ${standingButton(c)}
        <div class="row-links">
          <button class="btn-text" data-go="#/line">▦ 줄 현황 보기</button>
          <button class="btn-text muted" data-go="#/e/${e.code}/edit">번호 수정</button>
        </div>`
      : `<button class="btn-grad" style="width:100%;margin-top:6px" data-go="#/e/${e.code}">번호 입력 →</button>`;
    return `<section class="ticket">
      <div class="ticket-head ticket-tap" data-go="${joined ? '#/q' : '#/e/' + e.code}">${head}</div>
      <div class="ticket-cut"></div>
      <div class="ticket-stub">${stub}</div>
    </section>`;
  }).join('');

  return `
    <div class="topbar"><span></span>
      <button class="icon-btn" data-action="notices" aria-label="알림">🔔${unreadCount() ? '<span class="badge-dot"></span>' : ''}</button>
    </div>
    <div class="brand">입장번호</div>
    <form class="code-row" data-form="code">
      <label class="field"><span class="hint">🔍</span><input id="code" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="공연 코드 입력"></label>
      <button class="btn-grad" type="submit">추가</button>
    </form>
    <div id="code-error"></div>
    <div class="section-title">내 공연</div>
    ${tickets || `<div class="empty"><div class="orb">🎫</div><h3>아직 공연이 없어요</h3><div class="hint">공연장 QR을 스캔하거나 공연 코드를 입력하면<br>여기에 공연이 추가됩니다.</div></div>`}
    <div class="app-note">📱 앱을 설치하면 블루투스로 앞뒤 번호 관객을 찾고, 현장 안내를 알림으로 받을 수 있어요.</div>`;
}

function viewEntry(r) {
  const e = eventByCode(r.code);
  if (!e) return `<div class="topbar"><button class="icon-btn" data-go="#/">‹</button><h1>번호 입력</h1><span style="width:44px"></span></div><div class="empty"><h3>공연을 찾을 수 없습니다</h3><div class="hint">공연 코드를 확인하거나 주최 측 안내를 확인해 주세요.</div></div>`;
  const p = state.participant?.code === e.code ? state.participant : null;
  const locked = !!p && !r.edit;
  const zoneName = entryZone ?? p?.zone ?? (e.zones.length === 1 ? e.zones[0].name : null);
  entryZone = zoneName;
  const chips = e.zones.map((z) => `<button class="chip ${z.name === zoneName ? 'on' : ''}" data-action="zone" data-zone="${esc(z.name)}" ${locked ? 'disabled' : ''}><b>${esc(z.name)}</b><small>${z.min}~${z.max}</small></button>`).join('');
  return `
    <div class="topbar"><button class="icon-btn" data-go="#/" aria-label="뒤로">‹</button><h1>번호 입력</h1><span style="width:44px"></span></div>
    <div class="event-head">
      <div class="date-block"><small>${e.date.getMonth() + 1}월</small><b>${e.date.getDate()}</b></div>
      <div><h2>${esc(e.title)}</h2><div class="hint small">${koreanShort(e.date)} · ${esc(e.venue)}</div></div>
    </div>
    <div class="label">구역</div>
    ${e.zones.length ? `<div class="chips">${chips}</div>` : '<div class="hint">아직 구역이 설정되지 않은 공연입니다.</div>'}
    <div class="label">입장번호</div>
    <form data-form="ticket">
      <input id="ticket" class="number-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="번호 입력" value="${p ? p.ticket : ''}" ${locked ? 'readonly' : ''}>
      <div id="preview"></div>
      <div id="ticket-error"></div>
      ${e.location ? `<div class="small hint" style="margin-top:18px">📍 공연장 반경 ${Math.round(e.location.radius)}m 안에서만 사용할 수 있습니다.</div>` : ''}
      <div style="margin-top:18px">
        ${locked
          ? `<div class="small hint" style="margin-bottom:8px">🔒 확인한 번호로 고정되어 있습니다. 바꾸려면 [수정]을 누르세요.</div>
             <button type="button" class="btn-grad btn-big btn-gray" data-go="#/e/${e.code}/edit">수정</button>
             <div class="center"><button type="button" class="btn-text" data-go="#/q">내 대기줄 보기</button></div>`
          : `<button class="btn-grad btn-big" id="confirm" ${zoneName ? '' : 'disabled'}>✓ 확인</button>`}
      </div>
    </form>`;
}
let entryZone = null;

function updatePreview() {
  const r = route();
  const e = eventByCode(r.code || '');
  const el = document.getElementById('preview');
  if (!e || !el) return;
  const z = zoneOf(e, entryZone);
  if (!z) { el.innerHTML = ''; return; }
  const t = parseTicket(document.getElementById('ticket').value);
  const a = t.value != null ? assign(t.value, z) : null;
  el.innerHTML = a?.queue
    ? `<div class="preview"><span class="ok">✔</span><div><b>${esc(z.name)} · ${esc(a.queue.name)}</b><div class="small hint">이 줄의 입장번호 ${rangeText(a.queue)}</div></div></div>`
    : `<div class="small hint" style="margin-top:12px">${esc(z.name)} 번호 범위: ${z.min}~${z.max}번 · 번호를 넣으면 대기줄이 정해집니다</div>`;
}

function viewQueue() {
  const c = current();
  if (!c) return `<div class="topbar"><button class="icon-btn" data-go="#/">‹</button><h1>대기줄 확인</h1><span style="width:44px"></span></div><div class="empty"><h3>참가 정보가 없습니다</h3></div>`;
  return `
    <div class="topbar"><button class="icon-btn" data-go="#/" aria-label="뒤로">‹</button><h1>대기줄 확인</h1><span style="width:44px"></span></div>
    <section class="ticket">
      <div class="ticket-head center"><div class="t-sub">${esc(c.e.title)}</div><div style="font-size:30px;font-weight:700;margin-top:4px">${esc(c.z.name)}</div></div>
      <div class="ticket-cut"></div>
      <div class="ticket-stub">
        <div class="center f-label" style="margin-top:4px">당신의 번호</div>
        <div class="big-number">${c.p.ticket}</div>
        <div class="info-row"><span>대기줄</span><span>${esc(c.q.name)}</span></div>
        <div class="info-row"><span>입장번호</span><span>${rangeText(c.q)}</span></div>
      </div>
    </section>
    <div class="group">
      <button class="group-row" data-go="#/line"><span class="ico">▦</span><span class="grow"><b>줄 현황 보기</b><span class="small hint">지금 이 줄에 와 있는 번호를 보고 내 자리를 찾으세요</span></span><span class="chev">›</span></button>
    </div>
    <div class="bottom-bar">${standingButton(c)}
      <div class="center"><button class="btn-text" data-go="#/e/${c.e.code}/edit">번호 변경</button></div>
    </div>`;
}

function viewLine() {
  const c = current();
  if (!c) return `<div class="topbar"><button class="icon-btn" data-go="#/">‹</button><h1>줄 현황</h1><span style="width:44px"></span></div><div class="empty"><h3>참가 정보가 없습니다</h3></div>`;
  const { p, z, q } = c;
  const standing = new Set(state.spots.filter((s) => s.standing).map((s) => s.n));
  if (p.standing) standing.add(p.ticket);
  const isStand = (n) => (n === p.ticket ? p.standing : standing.has(n));
  const total = q.max - q.min + 1;
  const drawn = (q.map?.slots || []).filter((s) => s.n >= q.min && s.n <= q.max);
  const slot = (n) => `<div class="slot ${isStand(n) ? 'stand' : ''} ${n === p.ticket ? 'mine' : ''}" id="${n === p.ticket ? 'my-slot' : ''}">${n}</div>`;

  let body;
  if (state.onlyStanding) {
    const list = [...standing].sort((a, b) => a - b);
    body = list.length ? linear(list) : `<div class="hint center" style="padding:30px">아직 이 줄에 선 사람이 없습니다.</div>`;
  } else if (drawn.length) {
    // 주최 측이 그린 배치도 그대로 (빈 자리는 빈칸)
    const ys = drawn.map((s) => s.y), minY = Math.min(...ys), maxY = Math.max(...ys);
    const rows = [];
    for (let y = minY; y <= maxY; y++) {
      const byX = new Map(drawn.filter((s) => s.y === y).map((s) => [s.x, s.n]));
      const cells = [];
      for (let x = 0; x < q.map.cols; x++) cells.push(byX.has(x) ? slot(byX.get(x)) : '<div></div>');
      rows.push(`<div class="map-row" style="grid-template-columns:repeat(${q.map.cols},1fr)">${cells.join('')}</div>`);
    }
    body = rows.join('');
  } else {
    body = linear(Array.from({ length: total }, (_, i) => q.min + i));
  }

  function linear(numbers) {
    return `<ul class="line-list">${numbers.map((n, i) => `
      <li class="${isStand(n) ? 'stand' : ''} ${n === p.ticket ? 'mine' : ''}">
        <span class="line-rail"><span class="${i === 0 ? 'gone' : ''}"></span><em></em><span class="${i === numbers.length - 1 ? 'gone' : ''}"></span></span>
        ${slot(n)}
        ${n === p.ticket ? '<span class="slot-tag mine">내 번호</span>' : isStand(n) ? '<span class="slot-tag">서 있음</span>' : ''}
      </li>`).join('')}</ul>`;
  }

  return `
    <div class="topbar"><button class="icon-btn" data-go="#/q" aria-label="뒤로">‹</button><h1>줄 현황</h1>
      <span><button class="icon-btn" data-action="only-standing" aria-label="서 있는 사람만 보기" style="display:inline-grid;${state.onlyStanding ? 'color:var(--accent)' : ''}">👤</button><button class="icon-btn" data-action="refresh-spots" aria-label="새로고침" style="display:inline-grid">↻</button></span>
    </div>
    <div style="font-size:20px;font-weight:700">${esc(z.name)} · ${esc(q.name)}</div>
    <div class="hint">${state.onlyStanding ? `${rangeText(q)} · 서 있는 사람 ${standing.size}명만 보는 중` : `${rangeText(q)} · ${standing.size}/${total}명 서 있음`}</div>
    ${state.spotsError ? `<div class="error-box">줄 현황을 받지 못했습니다. ${esc(state.spotsError)}</div>` : ''}
    <div class="legend"><span><i class="lg-stand"></i>줄에 서 있음</span><span><i class="lg-mine"></i>내 번호</span><span><i class="lg-empty"></i>빈칸</span></div>
    <div class="dir">⇡ 입장 방향 (줄 앞)${drawn.length && !state.onlyStanding ? ' · 주최 측이 그린 줄 배치' : ''}</div>
    ${body}
    <div class="dir" style="margin-top:10px">⇣ 줄 뒤</div>
    <div class="bottom-bar">${standingButton(c)}
      <div class="small hint center" style="margin-top:4px">${p.standing ? '내 칸이 줄에 표시되고 있습니다.' : '자리를 찾아 선 뒤 [줄에 섰어요]를 누르면 내 칸이 채워집니다.'}</div>
    </div>`;
}

function viewNotices() {
  const c = current();
  const list = myNotices();
  const rows = list.map((n) => `
    <div class="notice"><span class="ico" style="background:${kind(n.kind).color}">${kind(n.kind).icon}</span>
      <div style="flex:1"><time>${timeShort(new Date(n.at))}</time><b>${kind(n.kind).title}</b><div class="small">${esc(n.message)}</div></div></div>`).join('');
  return `<div class="sheet-body">
    <div class="topbar"><span style="width:44px"></span><h1>알림</h1><button class="btn-text" data-action="close-sheet">닫기</button></div>
    ${!c ? `<div class="empty"><div class="orb">🔔</div><h3>알림이 없습니다</h3><div class="hint">공연에 참가하면 주최 측의 현장 안내(뒤로 이동, 입장 준비 등)를 여기서 받습니다.</div></div>`
      : `<div style="padding:8px 0 12px;border-bottom:1px solid var(--line)"><b>${esc(c.e.title)}</b><div class="small hint">${esc(c.q.name)} · ${rangeText(c.q)} · ${koreanShort(c.e.date)}</div></div>
         <div class="small hint" style="margin-top:12px">주최 측 안내</div>
         ${rows || '<div class="hint small" style="padding:16px 0">아직 받은 안내가 없습니다.</div>'}`}
  </div>`;
}

function render() {
  const r = route();
  const focused = document.activeElement?.id;
  if (focused === 'ticket' || focused === 'code') return; // 입력 중에는 다시 그리지 않는다 (포커스 유지)
  $app.innerHTML = r.name === 'entry' ? viewEntry(r) : r.name === 'queue' ? viewQueue() : r.name === 'line' ? viewLine() : viewHome();
  if (r.name === 'entry') updatePreview();
}

// ───────── 이벤트 ─────────

$app.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-go],[data-action]');
  if (!t) return;
  if (t.dataset.go) { ev.preventDefault(); go(t.dataset.go); return; }
  const a = t.dataset.action;
  if (a === 'forget') {
    ev.stopPropagation();
    if (confirm('내 공연 목록에서 지웁니다. QR이나 코드로 다시 추가할 수 있습니다.')) { forgetEvent(t.dataset.code); render(); }
  } else if (a === 'zone') {
    entryZone = t.dataset.zone;
    document.querySelectorAll('.chip').forEach((b) => b.classList.toggle('on', b.dataset.zone === entryZone));
    const btn = document.getElementById('confirm');
    if (btn) btn.disabled = false;
    document.getElementById('ticket-error').innerHTML = '';
    updatePreview();
    document.getElementById('ticket').focus();
  } else if (a === 'stand-off') {
    setStanding(false);
  } else if (a === 'stand-on') {
    const c = current();
    if (!c) return;
    if (c.e.location) {
      t.disabled = true;
      t.textContent = '위치 확인 중…';
      const denied = await checkLocation(c.e);
      if (denied) { render(); dialog('공연장에서만 사용할 수 있습니다', denied); return; }
    }
    setStanding(true);
  } else if (a === 'notices') {
    const sheet = document.getElementById('sheet');
    sheet.innerHTML = viewNotices();
    sheet.style.alignItems = '';
    sheet.hidden = false;
    state.noticesReadAt = Date.now();
    store.set('noticesReadAt', state.noticesReadAt);
  } else if (a === 'only-standing') {
    state.onlyStanding = !state.onlyStanding;
    render();
  } else if (a === 'refresh-spots') {
    refreshSpots();
  }
});

document.getElementById('sheet').addEventListener('click', (ev) => {
  if (ev.target.id === 'sheet' || ev.target.closest('[data-action="close-sheet"]')) {
    document.getElementById('sheet').hidden = true;
    render();
  }
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

$app.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target.dataset.form;
  if (form === 'code') {
    const input = document.getElementById('code');
    const raw = input.value.trim().toUpperCase();
    const err = document.getElementById('code-error');
    if (!raw) { err.innerHTML = '<div class="error-box">공연 코드를 입력해 주세요.</div>'; return; }
    let e = eventByCode(raw);
    if (!e) { await loadCatalog(); e = eventByCode(raw); } // 방금 게시된 공연일 수 있다
    if (!e) { err.innerHTML = `<div class="error-box">공연 코드 '${esc(raw)}' 를 찾을 수 없습니다. 주최 측 안내를 확인해 주세요.</div>`; return; }
    input.value = '';
    input.blur();
    openEvent(e.code);
  } else if (form === 'ticket') {
    const r = route();
    const e = eventByCode(r.code);
    const z = zoneOf(e, entryZone);
    const input = document.getElementById('ticket');
    const err = document.getElementById('ticket-error');
    if (!e || !z || input.readOnly) return;
    const t = parseTicket(input.value);
    if (t.error) { err.innerHTML = `<div class="error-box">${esc(t.error)}</div>`; return; }
    const a = assign(t.value, z);
    if (a.error) { err.innerHTML = `<div class="error-box">${esc(a.error)}</div>`; return; }
    const btn = document.getElementById('confirm');
    if (e.location) {
      btn.disabled = true;
      btn.textContent = '위치 확인 중…';
      const denied = await checkLocation(e);
      btn.disabled = false;
      btn.textContent = '✓ 확인';
      if (denied) { err.innerHTML = `<div class="error-box">${esc(denied)}</div>`; return; }
    }
    const keepStanding = state.participant?.code === e.code && state.participant.zone === z.name && state.participant.queue === a.queue.name && state.participant.ticket === t.value && state.participant.standing;
    state.participant = { code: e.code, zone: z.name, queue: a.queue.name, ticket: t.value, standing: !!keepStanding };
    rememberEvent(e.code);
    saveParticipant();
    input.blur();
    go('#/q');
  }
});

function openEvent(code) {
  rememberEvent(code);
  entryZone = null;
  go(state.participant?.code === code ? '#/q' : '#/e/' + code);
}

window.addEventListener('hashchange', () => {
  const r = route();
  if (r.name !== 'entry') entryZone = null;
  clearInterval(spotPoll);
  spotPoll = null;
  if (r.name === 'line') { refreshSpots(); spotPoll = setInterval(refreshSpots, 15e3); }
  document.activeElement?.blur?.();
  render();
  window.scrollTo(0, 0);
  if (r.name === 'line') setTimeout(() => document.getElementById('my-slot')?.scrollIntoView({ block: 'center' }), 50);
});

// 줄서기 시작까지 남은 시간 갱신
setInterval(() => {
  const c = current();
  if (c?.e.entryAt && !c.p.standing && c.e.entryAt > Date.now() - 2000 && route().name !== 'entry') render();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { loadCatalog().then(render); syncSpot(); }
});

// ───────── 시작 ─────────

(async function start() {
  render();
  await loadCatalog();
  // 참가 QR: …/join?code=XXXXXX → 그 공연으로 바로
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    const base = location.pathname.replace(/join(\.html)?\/?$/, '');
    history.replaceState(null, '', base);
    const e = eventByCode(code);
    if (e) { openEvent(e.code); } else { render(); dialog('참가할 수 없습니다', 'QR 링크의 공연을 찾을 수 없습니다. 이미 끝난 공연이거나 주최 측이 아직 게시하지 않았을 수 있습니다.'); }
  }
  syncSpot();
  syncNotices();
  render();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
})();
