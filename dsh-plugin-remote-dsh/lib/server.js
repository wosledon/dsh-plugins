/**
 * 远端 DSH 主机的本地 HTTP API。
 *
 * 路由全部挂在 `/plugin-remote-dsh/api/` 下，和 DSH 页面同源。除 `bootstrap`
 * 外都要求 `x-remote-dsh-token`：token 由宿主进程启动时随机生成，只通过同源
 * `bootstrap` 交给本地页面。侧栏里加载的远端网页属于另一个 origin，读不到这个
 * token；它也无法在不触发 CORS 预检的情况下伪造自定义请求头。
 *
 * 路径是手写的，不依赖 DSH 的 Remote 生成器：这个插件没有构建步骤，也不想把
 * 第三方插件的操作暴露成新的全局 RPC namespace。
 */

const PREFIX = '/plugin-remote-dsh/api/';
const MAX_BODY = 1024 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function errorOf(error) {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`);
  return value;
}

export function createApi(options) {
  const manager = options.manager;
  const token = options.token;

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: { message: 'invalid request URL' } });
      return;
    }
    const pathname = url.pathname;
    if (!pathname.startsWith(PREFIX)) {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    const route = pathname.slice(PREFIX.length).replace(/\/+$/, '');
    const method = req.method ?? 'GET';

    if (route === 'bootstrap' && method === 'GET') {
      sendJson(res, 200, { token, version: 1 });
      return;
    }

    if (req.headers['x-remote-dsh-token'] !== token) {
      sendJson(res, 401, { error: { message: 'unauthorized' } });
      return;
    }

    try {
      if (route === 'hosts' && method === 'GET') {
        sendJson(res, 200, await manager.loadHosts());
        return;
      }

      if (route === 'settings' && method === 'POST') {
        const body = await readJson(req);
        sendJson(res, 200, { settings: await manager.setSettings(body) });
        return;
      }

      if (route === 'hosts' && method === 'POST') {
        const body = await readJson(req);
        const host = await manager.addManualHost(body.host);
        sendJson(res, 200, { host });
        return;
      }

      if (route.startsWith('hosts/') && method === 'DELETE') {
        const id = decodeURIComponent(route.slice('hosts/'.length));
        sendJson(res, 200, await manager.removeManualHost(id));
        return;
      }

      if (route === 'probe' && method === 'POST') {
        const body = await readJson(req);
        const host = await manager.findHost(requireString(body.id, 'id'));
        sendJson(res, 200, { probe: await manager.probe(host) });
        return;
      }

      if (route === 'install' && method === 'POST') {
        const body = await readJson(req);
        const host = await manager.findHost(requireString(body.id, 'id'));
        sendJson(res, 200, { install: await manager.install(host, body.spec, body.registry) });
        return;
      }

      if (route === 'start' && method === 'POST') {
        const body = await readJson(req);
        const host = await manager.findHost(requireString(body.id, 'id'));
        sendJson(res, 200, await manager.start(host, {
          port: body.port,
          mode: body.mode,
          spec: body.spec,
          registry: body.registry,
          force: body.force === true,
        }));
        return;
      }

      if (route === 'stop' && method === 'POST') {
        const body = await readJson(req);
        const host = await manager.findHost(requireString(body.id, 'id'));
        sendJson(res, 200, await manager.stop(host));
        return;
      }

      if (route === 'open' && method === 'POST') {
        const body = await readJson(req);
        const host = await manager.findHost(requireString(body.id, 'id'));
        sendJson(res, 200, await manager.open(host));
        return;
      }

      if (route === 'logs' && method === 'POST') {
        const body = await readJson(req);
        const host = await manager.findHost(requireString(body.id, 'id'));
        sendJson(res, 200, await manager.logs(host, body.lines));
        return;
      }

      sendJson(res, 404, { error: { message: 'not found' } });
    } catch (error) {
      const message = errorOf(error);
      const status = /unknown host/.test(message) ? 404 : 400;
      const body = { error: { message } };
      if (typeof error?.code === 'string' && error.code !== '') body.error.code = error.code;
      sendJson(res, status, body);
    }
  }

  return { handler, prefix: '/plugin-remote-dsh' };
}
