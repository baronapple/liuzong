/**
 * 理发店实时状态 + 预约系统 - 后端 API (Cloudflare Worker)
 *
 * === 状态接口 ===
 *   GET  /status                    → 顾客端读取当前状态
 *   POST /status                    → 老板端更新状态（需要 pin）
 *
 * === 预约接口（匿名，不收集姓名/手机号）===
 *   GET  /bookings?date=YYYY-MM-DD  → 读取某天已被占用的时间（只返回 date/time，不返回 id）
 *   POST /bookings                  → 预约一个时间段 { date, time, deviceId } → 返回 { id }
 *   POST /bookings/cancel           → 取消预约 { id }（id 是预约时只给预约者的秘密凭证）
 *   POST /bookings/owner-list       → 老板端查看所有预约 { pin }
 *   POST /bookings/owner-cancel     → 老板端直接取消 { pin, id }
 *
 * === 休息日设置接口 ===
 *   GET  /schedule                  → 公开读取每周固定休息日 { closedWeekdays: [2,4] }（0=周日...6=周六）
 *   POST /schedule                  → 老板端更新休息日 { pin, closedWeekdays: [2,4] }
 *
 * 需要绑定一个 KV 命名空间，变量名叫 STATUS_KV
 * 需要设置一个密钥环境变量 OWNER_PIN（老板端密码）
 */
// 店铺所在时区，按实际所在地修改（布里斯班是 Australia/Brisbane，悉尼/墨尔本是 Australia/Sydney）
const SHOP_TZ = 'Australia/Brisbane';

function nowInShop() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

const DEFAULT_STATE = {
  shopName: '理发店',
  isOpen: true,
  status: 'idle',        // idle | busy | full
  waitingCount: 0,
  waitMinutes: 0,
  lastUpdated: Date.now()
};

const ALLOWED_STATUS_FIELDS = ['shopName', 'isOpen', 'status', 'waitingCount', 'waitMinutes'];

// 默认每周休息日：周二、周四（JS 的 Date.getDay() 规则：0=周日 1=周一 ... 6=周六）
const DEFAULT_SCHEDULE = { closedWeekdays: [2, 4] };

// 营业时间 9:00 - 21:00，每 20 分钟一格（每小时 3 格），最后一格 20:40 开始（21:00 结束）
const OPEN_HOUR = 10;
const CLOSE_HOUR = 19;
const SLOT_MINUTES = [0, 20, 40];

// 同一台设备同时最多持有几个未过期预约（防止有人恶意把整天占满）
const MAX_ACTIVE_PER_DEVICE = 300;

function generateValidSlots() {
  const slots = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    SLOT_MINUTES.forEach((m) => {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    });
  }
  return slots;
}
const VALID_SLOTS = generateValidSlots();

function withCors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return resp;
}

function json(data, status = 200) {
  return withCors(new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function isValidDate(dateStr) {
  return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isValidTime(timeStr) {
  return VALID_SLOTS.includes(timeStr);
}

function dateStrDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    // ---- 状态接口 ----
    if (path === '/status' && request.method === 'GET') return handleStatusGet(env);
    if (path === '/status' && request.method === 'POST') return handleStatusPost(request, env);

    // ---- 预约接口 ----
    if (path === '/bookings' && request.method === 'GET') return handleBookingsGet(url, env);
    if (path === '/bookings' && request.method === 'POST') return handleBookingsCreate(request, env);
    if (path === '/bookings/cancel' && request.method === 'POST') return handleCancel(request, env);
    if (path === '/bookings/owner-list' && request.method === 'POST') return handleOwnerList(request, env);
    if (path === '/bookings/owner-cancel' && request.method === 'POST') return handleOwnerCancel(request, env);

    // ---- 休息日设置接口 ----
    if (path === '/schedule' && request.method === 'GET') return handleScheduleGet(env);
    if (path === '/schedule' && request.method === 'POST') return handleSchedulePost(request, env);

    return json({ error: 'NOT_FOUND' }, 404);
  }
};

/* ============ 状态相关 ============ */

async function handleStatusGet(env) {
  const raw = await env.STATUS_KV.get('status');
  const state = raw ? JSON.parse(raw) : DEFAULT_STATE;
  if (!raw) await env.STATUS_KV.put('status', JSON.stringify(DEFAULT_STATE));
  return json({ success: true, data: state });
}

async function handleStatusPost(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { pin, updates } = body;
  if (!pin || String(pin) !== String(env.OWNER_PIN)) {
    return json({ success: false, error: 'PIN_INCORRECT' }, 401);
  }
  if (!updates || typeof updates !== 'object') {
    return json({ success: false, error: 'INVALID_UPDATES' }, 400);
  }

  const raw = await env.STATUS_KV.get('status');
  const current = raw ? JSON.parse(raw) : DEFAULT_STATE;

  const safeUpdates = {};
  ALLOWED_STATUS_FIELDS.forEach((field) => {
    if (updates[field] !== undefined) safeUpdates[field] = updates[field];
  });

  const next = { ...current, ...safeUpdates, lastUpdated: Date.now() };
  await env.STATUS_KV.put('status', JSON.stringify(next));
  return json({ success: true, data: next });
}

/* ============ 预约相关 ============ */

async function getBookings(env) {
  const raw = await env.STATUS_KV.get('bookings');
  return raw ? JSON.parse(raw) : [];
}

async function saveBookings(env, bookings) {
  await env.STATUS_KV.put('bookings', JSON.stringify(bookings));
}

// 公开接口：只告诉大家"哪些时间被占了"，不返回 id，别人没法冒充取消
async function handleBookingsGet(url, env) {
  const date = url.searchParams.get('date');
  const bookings = await getBookings(env);
  const filtered = date ? bookings.filter(b => b.date === date) : bookings;
  return json({ success: true, data: filtered.map(b => ({ date: b.date, time: b.time })) });
}

async function handleBookingsCreate(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { date, time, deviceId } = body;

  if (!isValidDate(date)) return json({ success: false, error: 'INVALID_DATE' }, 400);
  if (!isValidTime(time)) return json({ success: false, error: 'INVALID_TIME' }, 400);
  if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 64) {
    return json({ success: false, error: 'INVALID_DEVICE' }, 400);
  }

  const scheduleRaw = await env.STATUS_KV.get('schedule');
  const schedule = scheduleRaw ? JSON.parse(scheduleRaw) : DEFAULT_SCHEDULE;
  const weekday = new Date(date + 'T00:00:00').getDay();
  if (schedule.closedWeekdays.includes(weekday)) {
    return json({ success: false, error: 'DAY_CLOSED' }, 400);
  }

  // 顺手清理 14 天前的旧预约，避免数据一直变大
  const keepFrom = dateStrDaysAgo(14);
  const bookings = (await getBookings(env)).filter(b => b.date >= keepFrom);

  if (bookings.some(b => b.date === date && b.time === time)) {
    return json({ success: false, error: 'SLOT_TAKEN' }, 409);
  }

  // const activeCutoff = dateStrDaysAgo(1);
  // const mine = bookings.filter(b => b.deviceId === deviceId && b.date >= activeCutoff);
  // if (mine.length >= MAX_ACTIVE_PER_DEVICE) {
  //   return json({ success: false, error: 'TOO_MANY_BOOKINGS', max: MAX_ACTIVE_PER_DEVICE }, 429);
  // }

  const now = nowInShop();
  const mine = bookings.filter(b => b.deviceId === deviceId && `${b.date} ${b.time}` > now);

  const booking = {
    id: crypto.randomUUID(),
    date,
    time,
    deviceId,
    createdAt: Date.now()
  };
  bookings.push(booking);
  await saveBookings(env, bookings);

  return json({ success: true, id: booking.id });
}

// 取消：凭 id（只有预约者的设备知道）
async function handleCancel(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { id } = body;
  if (!id) return json({ success: false, error: 'ID_REQUIRED' }, 400);

  const bookings = await getBookings(env);
  const next = bookings.filter(b => b.id !== id);
  if (next.length === bookings.length) return json({ success: false, error: 'NOT_FOUND' }, 404);

  await saveBookings(env, next);
  return json({ success: true });
}

async function handleOwnerList(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { pin } = body;
  if (!pin || String(pin) !== String(env.OWNER_PIN)) {
    return json({ success: false, error: 'PIN_INCORRECT' }, 401);
  }

  const bookings = await getBookings(env);
  const sorted = [...bookings]
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map(b => ({ id: b.id, date: b.date, time: b.time }));
  return json({ success: true, data: sorted });
}

async function handleOwnerCancel(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { pin, id } = body;
  if (!pin || String(pin) !== String(env.OWNER_PIN)) {
    return json({ success: false, error: 'PIN_INCORRECT' }, 401);
  }
  if (!id) return json({ success: false, error: 'ID_REQUIRED' }, 400);

  const bookings = await getBookings(env);
  const next = bookings.filter(b => b.id !== id);
  if (next.length === bookings.length) return json({ success: false, error: 'NOT_FOUND' }, 404);

  await saveBookings(env, next);
  return json({ success: true });
}

/* ============ 休息日设置 ============ */

async function handleScheduleGet(env) {
  const raw = await env.STATUS_KV.get('schedule');
  const schedule = raw ? JSON.parse(raw) : DEFAULT_SCHEDULE;
  if (!raw) await env.STATUS_KV.put('schedule', JSON.stringify(DEFAULT_SCHEDULE));
  return json({ success: true, data: schedule });
}

async function handleSchedulePost(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { pin, closedWeekdays } = body;
  if (!pin || String(pin) !== String(env.OWNER_PIN)) {
    return json({ success: false, error: 'PIN_INCORRECT' }, 401);
  }
  if (!Array.isArray(closedWeekdays) || !closedWeekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return json({ success: false, error: 'INVALID_WEEKDAYS' }, 400);
  }

  const schedule = { closedWeekdays: [...new Set(closedWeekdays)].sort() };
  await env.STATUS_KV.put('schedule', JSON.stringify(schedule));
  return json({ success: true, data: schedule });
}
