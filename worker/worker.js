/**
 * 理发店实时状态 - 后端 API (Cloudflare Worker)
 *
 * 两个接口：
 *   GET  /status         → 顾客端读取当前状态
 *   POST /status         → 老板端更新状态（body 里要带对的 pin 才会生效）
 *
 * 需要绑定一个 KV 命名空间，变量名叫 STATUS_KV（部署步骤见 README）
 * 需要设置一个密钥环境变量 OWNER_PIN（老板端密码，部署步骤见 README）
 */

const DEFAULT_STATE = {
  shopName: '理发店',
  isOpen: true,
  status: 'idle',        // idle | busy | full
  waitingCount: 0,
  waitMinutes: 0,
  lastUpdated: Date.now()
};

const ALLOWED_FIELDS = ['shopName', 'isOpen', 'status', 'waitingCount', 'waitMinutes'];

// 允许跨域访问：GitHub Pages 域名和 Worker 域名不一样，必须加 CORS
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return handleGet(env);
    }

    if (url.pathname === '/status' && request.method === 'POST') {
      return handlePost(request, env);
    }

    return json({ error: 'NOT_FOUND' }, 404);
  }
};

async function handleGet(env) {
  const raw = await env.STATUS_KV.get('status');
  const state = raw ? JSON.parse(raw) : DEFAULT_STATE;
  if (!raw) {
    // 第一次访问，把默认值写进去
    await env.STATUS_KV.put('status', JSON.stringify(DEFAULT_STATE));
  }
  return json({ success: true, data: state });
}

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ success: false, error: 'INVALID_BODY' }, 400);
  }

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
  ALLOWED_FIELDS.forEach((field) => {
    if (updates[field] !== undefined) {
      safeUpdates[field] = updates[field];
    }
  });

  const next = { ...current, ...safeUpdates, lastUpdated: Date.now() };
  await env.STATUS_KV.put('status', JSON.stringify(next));

  return json({ success: true, data: next });
}
