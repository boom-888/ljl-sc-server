// 统一 API 工具层 —— 三个角色工作台共用
// 自动加 Authorization header + 401 跳 /workspace

const API_BASE = '/api';

function getToken() {
  try { return localStorage.getItem('ljl_token'); } catch { return null; }
}
function setToken(t) { localStorage.setItem('ljl_token', t || ''); }
function setUser(u) { localStorage.setItem('ljl_user', JSON.stringify(u || null)); }
function getUser() { try { return JSON.parse(localStorage.getItem('ljl_user')); } catch { return null; } }
function clearAuth() {
  localStorage.removeItem('ljl_token');
  localStorage.removeItem('ljl_user');
}

function toast(type, msg, duration = 2500) {
  // 依赖全局 ElementPlus.ElMessage（CDN 引入）
  if (window.ElementPlus && window.ElementPlus.ElMessage) {
    window.ElementPlus.ElMessage({ type, message: msg, duration });
  } else {
    console.log(`[${type}] ${msg}`);
  }
}

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

  let resp;
  try {
    resp = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    toast('error', '网络错误：' + (e.message || '连接失败'));
    throw e;
  }

  if (resp.status === 401) {
    clearAuth();
    toast('warning', '登录已过期，请重新登录');
    setTimeout(() => { window.location.href = '/workspace'; }, 800);
    throw new Error('unauthorized');
  }

  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!resp.ok || (data && data.code !== undefined && data.code !== 0)) {
    const msg = (data && data.msg) || `请求失败 (${resp.status})`;
    toast('error', msg);
    const err = new Error(msg);
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  return data;
}

const api = {
  // —— 基础 HTTP 方法 ——
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),

  // —— 角色通用 ——
  me: () => api.get('/user/profile'),
  reviewsMine: (role, params) => {
    const q = new URLSearchParams({ role, ...params }).toString();
    return api.get('/reviews/mine?' + q);
  },
  notifications: (params) => {
    const q = new URLSearchParams(params || {}).toString();
    return api.get('/notifications' + (q ? '?' + q : ''));
  },
  unreadCount: () => api.get('/notifications/unread-count'),
  markRead: (ids) => api.post('/notifications/read', ids ? { ids } : { all: true }),
};

window.__api = api;
window.__getToken = getToken;
window.__getUser = getUser;
window.__toast = toast;
window.__clearAuth = clearAuth;
