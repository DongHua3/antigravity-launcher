const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { disposeSource } = require('./renderer');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) request.destroy(new Error('CDP 响应过大'));
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('CDP 不可用');
          resolve(JSON.parse(body));
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(2500, () => request.destroy(new Error('CDP 连接超时')));
  });
}

function validTarget(target, port) {
  try {
    const socket = new URL(target.webSocketDebuggerUrl);
    const page = new URL(target.url);
    const localPage = ['file:', 'vscode-file:', 'app:'].includes(page.protocol)
      || (['http:', 'https:'].includes(page.protocol) && LOOPBACK.has(page.hostname));
    return target.type === 'page' && localPage && socket.protocol === 'ws:'
      && LOOPBACK.has(socket.hostname) && Number(socket.port) === port;
  } catch { return false; }
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.pending = new Map();
    this.sequence = 0;
  }

  async open() {
    this.socket = new WebSocket(this.url, { handshakeTimeout: 3000, maxPayload: 4 * 1024 * 1024 });
    this.socket.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (!message.id) return;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result || {});
      } catch { /* Ignore malformed or unrelated renderer messages. */ }
    });
    this.socket.on('close', () => this.rejectPending());
    this.socket.on('error', () => this.rejectPending());
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
      this.socket.once('close', () => reject(new Error('CDP 已断开')));
    });
    return this;
  }

  command(method, params = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 已断开'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP 已断开'));
    }
    this.pending.clear();
  }
  close() { this.rejectPending(); this.socket?.terminate(); }
  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
}

// Attaches only for the reversible localisation preload. No renderer -> host channel remains.
class CdpHub {
  constructor({ port = 9333, profile, target = 'hub', source, onStatus = () => {}, discover }) {
    Object.assign(this, { port, profile, target, source, onStatus });
    this.discover = discover || (() => this.findTargets());
    this.sessions = new Map();
    this.running = false;
    this.pendingConnections = new Set();
    this.orphanScripts = new Map();
    this.status = { cdpTargets: 0, cdpSockets: 0, injectCount: 0, lastInjectAt: 0, cdpError: '', cdpLoopRunning: false };
  }

  async findTargets() {
    let port = this.port;
    if (this.profile) {
      try {
        const found = Number(fs.readFileSync(path.join(this.profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
        if (Number.isInteger(found) && found > 0 && found <= 65535) port = found;
      } catch { /* Launches with an explicit debug port do not always write this file. */ }
    }
    let targets;
    try { targets = await getJson(`http://127.0.0.1:${port}/json/list`); }
    catch (error) {
      if (port === this.port) throw error;
      port = this.port;
      targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    }
    if (!Array.isArray(targets)) throw new Error('无效的 CDP 页面列表');
    return targets.filter(target => {
      if (!validTarget(target, port)) return false;
      const page = new URL(target.url);
      const idePage = ['vscode-file:', 'file:'].includes(page.protocol) && /\/workbench\.html$/.test(page.pathname);
      return this.target === 'ide' ? idePage : !idePage;
    });
  }

  async inject(connection) {
    if (!this.running) throw new Error('CDP 已停止');
    const source = this.source();
    if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
    connection.script = (await connection.command('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
    if (!this.running) throw new Error('CDP 已停止');
    const result = await connection.command('Runtime.evaluate', { expression: source });
    if (result.exceptionDetails) throw new Error('AG 页面组件初始化失败');
    this.status.injectCount++;
    this.status.lastInjectAt = Date.now();
  }

  async attach(target) {
    const connection = new CdpConnection(target.webSocketDebuggerUrl);
    connection.pageUrl = target.url;
    this.pendingConnections.add(connection);
    try {
      await connection.open();
      if (!this.running) throw new Error('CDP 已停止');
      await connection.command('Page.enable');
      for (const identifier of this.orphanScripts.get(connection.url) || []) {
        try { await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
        catch { /* A re-created page may already have dropped its former preload. */ }
      }
      this.orphanScripts.delete(connection.url);
      await this.inject(connection);
      if (!this.running) throw new Error('CDP 已停止');
      return connection;
    } catch (error) {
      await this.detach(connection);
      throw error;
    } finally { this.pendingConnections.delete(connection); }
  }

  tick() {
    if (!this.running || this.busy) return this.tickPromise || Promise.resolve();
    this.tickPromise = this.runTick();
    return this.tickPromise;
  }

  async runTick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const targets = await this.discover();
      if (!this.running) return;
      this.status.cdpTargets = targets.length;
      const active = new Set(targets.map(target => target.webSocketDebuggerUrl));
      for (const [url, connection] of this.sessions) {
        if (!active.has(url) || !connection.connected) {
          await this.detach(connection);
          this.sessions.delete(url);
        }
      }
      for (const target of targets) {
        if (!this.running) break;
        if (!this.sessions.has(target.webSocketDebuggerUrl)) {
          this.sessions.set(target.webSocketDebuggerUrl, await this.attach(target));
        }
      }
      this.status.cdpError = targets.length ? '' : '等待 AG 页面';
    } catch (error) {
      this.status.cdpError = error.message;
    } finally {
      this.busy = false;
      this.status.cdpSockets = [...this.sessions.values()].filter(connection => connection.connected).length;
      this.onStatus({ ...this.status });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.status.cdpLoopRunning = true;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 2000);
    this.timer.unref();
  }

  async refresh() {
    for (const connection of this.sessions.values()) {
      try { await this.inject(connection); }
      catch (error) { this.status.cdpError = error.message; connection.close(); }
    }
  }

  async detach(connection) {
    let removed = false;
    try {
      await connection.command('Runtime.evaluate', { expression: disposeSource });
      if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
      removed = true;
    } catch { /* Renderer exit already releases its document. */ }
    if (!removed && connection.script) {
      const scripts = this.orphanScripts.get(connection.url) || new Set();
      scripts.add(connection.script);
      this.orphanScripts.set(connection.url, scripts);
    }
    connection.close();
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer);
    for (const connection of this.pendingConnections) if (!connection.connected) connection.close();
    await this.tickPromise;
    await Promise.allSettled([...this.sessions.values()].map(connection => this.detach(connection)));
    this.sessions.clear();
    Object.assign(this.status, { cdpTargets: 0, cdpSockets: 0, cdpLoopRunning: false });
    this.onStatus({ ...this.status });
  }
}

module.exports = { CdpConnection, CdpHub, validTarget, getJson };
