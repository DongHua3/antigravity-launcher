const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { CdpHub, validTarget } = require('../adapters/desktop/cdp');

test('Target discovery accepts local pages only and checks the debugger endpoint', () => {
  const local = { type: 'page', url: 'http://localhost:4000/chat', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/1' };
  assert.equal(validTarget(local, 9333), true);
  assert.equal(validTarget({ ...local, url: 'https://external.example' }, 9333), false);
  assert.equal(validTarget({ ...local, type: 'iframe' }, 9333), false);
  assert.equal(validTarget({ ...local, webSocketDebuggerUrl: 'ws://external.example:9333/page' }, 9333), false);
  assert.equal(validTarget(local, 4000), false);
});

test('CDP attaches only the localisation preload, reconnects and removes owned scripts', async t => {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const calls = [];
  let current;
  let connections = 0;
  const injection = 'void 0; /* agl i18n preload */';
  const pageUrl = `http://127.0.0.1:${server.address().port}/c/11111111-1111-1111-1111-111111111111`;
  server.on('connection', socket => {
    current = socket;
    connections++;
    socket.on('message', raw => {
      const request = JSON.parse(raw);
      calls.push(request);
      let result = {};
      if (request.method === 'Page.addScriptToEvaluateOnNewDocument') result = { identifier: 'owned-' + connections };
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const target = { type: 'page', url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/page` };
  let discoveryError = false;
  const hub = new CdpHub({
    source: () => injection,
    discover: async () => { if (discoveryError) throw new Error('temporary outage'); return [target]; }
  });
  t.after(async () => {
    await hub.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  hub.running = true;
  await hub.tick();
  assert.equal(hub.status.cdpSockets, 1);
  assert.equal(hub.status.injectCount, 1);
  assert.ok(calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument' && call.params.source === injection));
  assert.ok(calls.some(call => call.method === 'Runtime.evaluate' && call.params.expression === injection));
  assert.equal(calls.some(call => call.method === 'Runtime.addBinding'), false, 'No renderer to host channel is opened');

  discoveryError = true;
  await hub.tick();
  assert.equal(hub.running, true, 'Temporary discovery failure must not end the session');

  discoveryError = false;
  const closed = once(current, 'close');
  current.terminate();
  await closed;
  await new Promise(resolve => setTimeout(resolve, 20));
  await hub.tick();
  assert.equal(connections, 2);
  assert.ok(calls.some(call => call.method === 'Page.removeScriptToEvaluateOnNewDocument' && call.params.identifier === 'owned-1'), 'Reconnect must remove the preload left by a disconnected socket');
  assert.equal(hub.status.cdpSockets, 1);
  await hub.stop();
  assert.equal(hub.status.cdpSockets, 0);
  assert.ok(calls.some(call => call.method === 'Page.removeScriptToEvaluateOnNewDocument' && call.params.identifier === 'owned-2'));
  assert.equal(calls.some(call => call.method === 'Runtime.removeBinding'), false);
});
