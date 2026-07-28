/**
 * 理发店实时状态 + 预约系统 - 后端 API (Cloudflare Worker)
 *
 * === 状态接口 ===
 *   GET  /status                    → 顾客端读取当前状态
 *   POST /status                    → 老板端更新状态（需要 pin）
 *
 * === 预约接口 ===
 *   GET  /bookings?date=YYYY-MM-DD  → 读取某一天已被占用的时间段（不含姓名手机号，公开安全）
 *   POST /bookings                  → 顾客新建预约 { date, time, name, phone }
 *   GET  /bookings/lookup?id=xxx    → 用预约id查看这条预约的信息（取消链接用）
 *   POST /bookings/cancel-by-link   → 凭id直接取消（专属链接用，不需要手机号）{ id }
 *   POST /bookings/cancel-by-phone  → 在日历上点击已订格子取消，需验证手机号 { id, phone }
 *   POST /bookings/owner-list       → 老板端查看所有预约（含姓名手机号）{ pin }
 *   POST /bookings/owner-cancel     → 老板端直接取消 { pin, id }
 *
 * 需要绑定一个 KV 命名空间，变量名叫 STATUS_KV
 * 需要设置一个密钥环境变量 OWNER_PIN（老板端密码）
 */

const DEFAULT_STATE = {
  shopName: '理发店',
  isOpen: true,
  status: 'idle',        // idle | busy | full
  waitingCount: 0,
  waitMinutes: 0,
  lastUpdated: Date.now()
};

const ALLOWED_STATUS_FIELDS = ['shopName', 'isOpen', 'status', 'waitingCount', 'waitMinutes'];

// 营业时间 9:00 - 21:00，每 30 分钟一格，最后一格 20:30 开始（21:00 结束）
const OPEN_HOUR = 9;
const CLOSE_HOUR = 21;

function generateValidSlots() {
  const slots = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    slots.push(`${String(h).padStart(2, '0')}:00`);
    slots.push(`${String(h).padStart(2, '0')}:30`);
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

function isValidPhone(phone) {
  return typeof phone === 'string' && /^04\d{8}$/.test(phone.trim());
}

function isValidDate(dateStr) {
  return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isValidTime(timeStr) {
  return VALID_SLOTS.includes(timeStr);
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
    if (path === '/bookings/lookup' && request.method === 'GET') return handleBookingsLookup(url, env);
    if (path === '/bookings/cancel-by-link' && request.method === 'POST') return handleCancelByLink(request, env);
    if (path === '/bookings/cancel-by-phone' && request.method === 'POST') return handleCancelByPhone(request, env);
    if (path === '/bookings/owner-list' && request.method === 'POST') return handleOwnerList(request, env);
    if (path === '/bookings/owner-cancel' && request.method === 'POST') return handleOwnerCancel(request, env);

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

// 公开接口：只返回时间段是否被占用，不返回姓名手机号
async function handleBookingsGet(url, env) {
  const date = url.searchParams.get('date');
  const bookings = await getBookings(env);
  const filtered = date ? bookings.filter(b => b.date === date) : bookings;
  const publicSafe = filtered.map(b => ({ id: b.id, date: b.date, time: b.time }));
  return json({ success: true, data: publicSafe });
}

async function handleBookingsCreate(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { date, time, name, phone } = body;
  const trimmedName = (name || '').trim();

  if (!isValidDate(date)) return json({ success: false, error: 'INVALID_DATE' }, 400);
  if (!isValidTime(time)) return json({ success: false, error: 'INVALID_TIME' }, 400);
  if (!trimmedName) return json({ success: false, error: 'NAME_REQUIRED' }, 400);
  if (trimmedName.length > 40) return json({ success: false, error: 'NAME_TOO_LONG' }, 400);
  if (!isValidPhone(phone)) return json({ success: false, error: 'INVALID_PHONE' }, 400);

  const bookings = await getBookings(env);

  const clash = bookings.find(b => b.date === date && b.time === time);
  if (clash) return json({ success: false, error: 'SLOT_TAKEN' }, 409);

  const booking = {
    id: crypto.randomUUID(),
    date,
    time,
    name: trimmedName,
    phone: phone.trim(),
    createdAt: Date.now()
  };
  bookings.push(booking);
  await saveBookings(env, bookings);

  return json({ success: true, id: booking.id });
}

async function handleBookingsLookup(url, env) {
  const id = url.searchParams.get('id');
  if (!id) return json({ success: false, error: 'ID_REQUIRED' }, 400);

  const bookings = await getBookings(env);
  const booking = bookings.find(b => b.id === id);
  if (!booking) return json({ success: false, error: 'NOT_FOUND' }, 404);

  return json({ success: true, data: { date: booking.date, time: booking.time, name: booking.name } });
}

async function handleCancelByLink(request, env) {
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

async function handleCancelByPhone(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, error: 'INVALID_BODY' }, 400); }

  const { id, phone } = body;
  if (!id || !phone) return json({ success: false, error: 'MISSING_FIELDS' }, 400);

  const bookings = await getBookings(env);
  const target = bookings.find(b => b.id === id);
  if (!target) return json({ success: false, error: 'NOT_FOUND' }, 404);

  if (target.phone !== phone.trim()) {
    return json({ success: false, error: 'PHONE_MISMATCH' }, 401);
  }

  const next = bookings.filter(b => b.id !== id);
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
  const sorted = [...bookings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
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
