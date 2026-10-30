// The API token arrives in the URL fragment (#token=…), so it is never sent to the server in a request line.
function apiToken() {
  const match = /(?:^|[#&])token=([a-f0-9]{8,128})/.exec(window.location.hash || '');
  return match ? match[1] : '';
}

export function tokenQuery() {
  const token = apiToken();
  return token ? `token=${encodeURIComponent(token)}` : '';
}

export async function request(route, { body, method = body === undefined ? 'GET' : 'POST', timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('请求超时，请检查本地代理或网络连接')), timeoutMs);
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-agl-token'] = token;
  try {
    const response = await fetch(route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `请求失败 (${response.status})`);
    return data;
  } finally { clearTimeout(timeout); }
}

export const api = {
  status: () => request('/api/status'),
  logs: () => request('/api/logs?limit=200'),
  configure: body => request('/api/config', { body }),
  browseExe: target => request('/api/browse-exe', { body: { target } }),
  setTargetPath: ({ target, path }) => request('/api/set-target-path', { body: { target, path } }),
  launch: () => request('/api/launch', { method: 'POST' }),
  checkUpdate: () => request('/api/update', { method: 'POST', timeoutMs: 60000 }),
  setTheme: theme => request('/api/theme', { body: { theme }, method: 'POST' }),
  hide: () => request('/api/hide', { method: 'POST' })
};
