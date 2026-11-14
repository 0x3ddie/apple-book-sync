import { Pool } from 'pg';
import { configuration } from './config.mjs';
import { createAuth } from './auth.mjs';
import { PostgresStore } from './store.mjs';
import { HttpError, fields, identifier, jsonBody, position, snapshot, string, transferRequest, transferAnswer } from './validation.mjs';

export function json(status, body) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  } });
}

function privateResponse(response) {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export function createHandler({ store, auth, origin }) {
  return async function handle(request) {
    let sessionCookies = [];
    function reply(status, body) {
      const response = json(status, body);
      for (const cookie of sessionCookies) response.headers.append('Set-Cookie', cookie);
      return response;
    }
    try {
      const url = new URL(request.url);
      if (url.origin !== origin) throw new HttpError(403, 'Unrecognized application origin.');
      const path = url.pathname;
      const method = request.method;
      const nativeRoute = path === '/api/devices/claim' || path.startsWith('/api/companion/');
      if (!['GET', 'POST'].includes(method)) throw new HttpError(405, 'Method not allowed.');
      if (nativeRoute && request.headers.has('origin')) throw new HttpError(403, 'Use the Mac companion to make this request.');
      if (method === 'POST' && !nativeRoute && request.headers.get('origin') !== origin) {
        throw new HttpError(403, 'This request must come from your Books web app.');
      }

      if (path.startsWith('/api/auth/')) {
        if (method === 'POST') {
          const body = await jsonBody(request);
          request = new Request(request.url, { method, headers: request.headers, body: JSON.stringify(body) });
        }
        return privateResponse(await auth.handler(request));
      }

      if (path === '/api/devices/claim' && method === 'POST') {
        const body = await jsonBody(request);
        fields(body, ['token', 'name'], 'pairing');
        string(body.token, 60, 'pairing code', { pattern: /^pair_[A-Za-z0-9_-]{43}$/ });
        string(body.name, 100, 'device name');
        return reply(200, await store.claimPairing(body.token, body.name));
      }

      if (path.startsWith('/api/companion/')) {
        const credential = request.headers.get('authorization')?.match(/^Bearer (device_[A-Za-z0-9_-]{43})$/)?.[1];
        if (!credential) throw new HttpError(401, 'Link your Mac companion first.');
        const device = await store.authenticateDevice(credential);
        if (path === '/api/companion/snapshot' && method === 'POST') {
          return reply(200, await store.importSnapshot(device, snapshot(await jsonBody(request, 1_048_576))));
        }
        if (path === '/api/companion/positions' && method === 'GET') return reply(200, await store.positions(device));
        if (path === '/api/companion/transfers' && method === 'GET') return reply(200, await store.pendingTransfers(device));
        const answerMatch = path.match(/^\/api\/companion\/transfers\/([^/]+)$/);
        if (answerMatch && method === 'POST') return reply(200, await store.answerTransfer(device,
          identifier(decodeURIComponent(answerMatch[1]), 'transfer identifier'), transferAnswer(await jsonBody(request, 40_960))));
        throw new HttpError(404, 'Endpoint not found.');
      }

      const { response: session, headers } = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
      // Forward renewal and expiry cookies even when a private route returns an error.
      sessionCookies = headers.getSetCookie();
      if (!session?.user?.id) throw new HttpError(401, 'Sign in to see your private library.');
      const owner = session.user.id;
      if (path === '/api/session' && method === 'GET') {
        return reply(200, { mode: 'cloud', user: { id: owner, email: session.user.email, name: session.user.name } });
      }
      if (request.headers.get('x-books-account') !== owner) {
        throw new HttpError(401, 'Your signed-in account changed. Reopen your library before continuing.', { code: 'ACCOUNT_CHANGED' });
      }
      if (path === '/api/library' && method === 'GET') return reply(200, await store.library(owner));
      if (path === '/api/devices' && method === 'GET') return reply(200, await store.devices(owner));
      if (path === '/api/devices/pairing' && method === 'POST') return reply(200, await store.createPairing(owner));
      if (path === '/api/transfers' && method === 'POST') return reply(200, await store.createTransfer(owner, transferRequest(await jsonBody(request, 40_960))));
      const transferMatch = path.match(/^\/api\/transfers\/([^/]+)(?:\/(close))?$/);
      if (transferMatch) {
        const id = identifier(decodeURIComponent(transferMatch[1]), 'transfer identifier');
        if (!transferMatch[2] && method === 'GET') return reply(200, await store.transfer(owner, id));
        if (transferMatch[2] === 'close' && method === 'POST') {
          fields(await jsonBody(request), [], 'transfer close');
          return reply(200, await store.closeTransfer(owner, id));
        }
      }
      const revokeMatch = path.match(/^\/api\/devices\/([^/]+)\/revoke$/);
      if (revokeMatch && method === 'POST') return reply(200, await store.revokeDevice(owner, identifier(decodeURIComponent(revokeMatch[1]), 'device identifier')));
      const bookMatch = path.match(/^\/api\/books\/([^/]+)(?:\/(position))?$/);
      if (bookMatch) {
        const bookId = identifier(decodeURIComponent(bookMatch[1]));
        if (!bookMatch[2] && method === 'GET') return reply(200, await store.book(owner, bookId));
        if (bookMatch[2] === 'position' && method === 'POST') return reply(200, await store.savePosition(owner, bookId, position(await jsonBody(request))));
      }
      // There are deliberately no EPUB, cover, local-path, or upload routes.
      throw new HttpError(404, 'Endpoint not found.');
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, { error: error.message, ...error.details });
      if (error instanceof URIError) return reply(400, { error: 'Invalid URL.' });
      // Do not put private book data, SQL, credentials, or email links in responses/logs.
      console.error('Books cloud request failed:', error.name);
      return reply(503, { error: 'Private sync is temporarily unavailable. Your device keeps its saved books and reading position.' });
    }
  };
}

export function createCloudHandler(env = process.env) {
  let runtime;
  return async function handle(request) {
    const config = configuration(env);
    if (!config.ready) return json(503, { error: 'Cloud sign-in and private sync are not configured yet.', code: 'CLOUD_NOT_CONFIGURED' });
    if (!runtime) {
      const pool = new Pool({ connectionString: config.databaseURL, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 20_000 });
      const auth = createAuth(config, pool);
      runtime = createHandler({ store: new PostgresStore(pool), auth, origin: config.origin });
    }
    return runtime(request);
  };
}

export default createCloudHandler();
