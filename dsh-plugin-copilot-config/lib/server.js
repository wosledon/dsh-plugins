/**
 * Token-protected local HTTP API for the Copilot configuration plugin.
 *
 * The Client half has no Host dependency: every read goes through this route on
 * the same origin, gated by the per-process bootstrap token.
 *
 * @module dsh-plugin-copilot-config/lib/server
 */

/** API mount point; a prefix match requires no trailing slash. */
export const API_PREFIX = '/plugin-copilot-config/api';

/** Header the Client sends with the bootstrap token. */
export const TOKEN_HEADER = 'x-copilot-config-token';

/** Largest accepted JSON body. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Create the route handler.
 *
 * @param {object} options
 * @param {ReturnType<import('./scan.js').createCopilotScanner>} options.scanner
 * @param {string} options.token - per-process API token
 * @param {(message: string, error?: unknown) => void} [options.log]
 * @returns {{ prefix: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }}
 */
export function createCopilotApi(options) {
  const scanner = options.scanner;
  const token = options.token;
  const log = typeof options.log === 'function' ? options.log : () => {};

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  function messageOf(error) {
    if (error instanceof Error && error.message !== '') return error.message;
    return String(error);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('request body too large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  function routeOf(url) {
    const pathname = new URL(url ?? '/', 'http://copilot-config.local').pathname;
    if (pathname === API_PREFIX) return '';
    if (pathname.startsWith(`${API_PREFIX}/`)) return pathname.slice(API_PREFIX.length + 1);
    return undefined;
  }

  async function handler(req, res) {
    const route = routeOf(req.url);
    if (route === undefined) {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    const method = req.method ?? 'GET';
    try {
      if (route === 'bootstrap' && method === 'GET') {
        sendJson(res, 200, { token, prefix: API_PREFIX });
        return;
      }
      if (req.headers[TOKEN_HEADER] !== token) {
        sendJson(res, 401, { error: { message: 'unauthorized' } });
        return;
      }
      if (route === 'config' && method === 'GET') {
        const session = new URL(req.url ?? '/', 'http://copilot-config.local').searchParams.get('session') ?? undefined;
        const snapshot = await scanner.scan({ sessionId: session });
        sendJson(res, 200, {
          root: snapshot.root,
          present: snapshot.present,
          files: snapshot.files,
          errors: snapshot.errors,
        });
        return;
      }
      if (route === 'file' && method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://copilot-config.local');
        const session = url.searchParams.get('session') ?? undefined;
        const path = url.searchParams.get('path') ?? '';
        const file = await scanner.read({ sessionId: session }, path);
        sendJson(res, 200, { file });
        return;
      }
      sendJson(res, 404, { error: { message: 'not found' } });
    } catch (error) {
      const message = messageOf(error);
      const status = message === 'unauthorized' ? 401 : 400;
      log('copilot-config: api failure', error);
      sendJson(res, status, { error: { message, code: error?.code } });
    }
  }

  return { prefix: API_PREFIX, handler };
}
