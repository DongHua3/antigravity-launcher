const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createSettings, assertLaunchSettingsMutable } = require('../core/settings');
const { Events } = require('../core/events');
const { Session } = require('../core/session');
const { writeJson } = require('../core/storage');
const { loadDictionary } = require('../features/i18n');
const { Updater } = require('../features/updater');
const { CdpHub } = require('../adapters/desktop/cdp');
const { rendererSource } = require('../adapters/desktop/renderer');
const { createDesktopAdapter } = require('../adapters/desktop');
const { createHost } = require('./host');
const { createApi } = require('./api');

function createApplication({ rootDir, dataDir, native = false, testMode = false, fetchBytes, onClose = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const events = new Events(dataDir);
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const desktop = createDesktopAdapter(testMode);
  let dictionary = loadDictionary(rootDir, dataDir);
  const host = createHost({ native, testMode, events });
  // Loopback API capability token. It never reaches the server in a URL it logs: the panel reads it from the fragment.
  const token = randomBytes(16).toString('hex');
  let session;
  let lastStatus = '';
  const cdp = new CdpHub({
    profile: desktop.profile,
    source: () => rendererSource(dictionary, settings.get()),
    onStatus: status => {
      const key = JSON.stringify([status.cdpSockets, status.cdpTargets, status.cdpError]);
      if (key === lastStatus) return;
      lastStatus = key;
      events.publish({ status: status.cdpSockets ? '增强功能已连接' : '等待连接', ...session.snapshot(), ...status });
    }
  });
  session = new Session({ settings, desktop, cdp, events, host, testMode, onStart: ({ target }) => {
    cdp.profile = target.profile;
    cdp.target = target.id;
  } });
  const updater = new Updater({
    rootDir, dataDir, settings, events,
    ...(fetchBytes ? { fetchBytes } : {}),
    onDictionaryUpdated: async () => {
      dictionary = loadDictionary(app.rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count, ...updater.currentState() });
      return count;
    },
    onRuntimeUpdated: async nextRoot => {
      app.rootDir = nextRoot;
    }
  });
  let closing;
  const app = {
    rootDir, dataDir, events, settings, desktop, host, cdp, session, updater,
    status() {
      const currentSettings = settings.get();
      const allTargets = desktop.discoverAllTargets ? desktop.discoverAllTargets(currentSettings) : {};
      const active = session.activeTarget || (desktop.resolveTarget ? desktop.resolveTarget(currentSettings.targetApp, currentSettings) : { id: 'hub', name: 'Antigravity' });
      const bothInstalled = Boolean(allTargets.hub?.exists && allTargets.ide?.exists);
      return {
        ...currentSettings, ...session.snapshot(), ...cdp.status, ...updater.currentState(),
        dictEntries: Object.keys(dictionary).length,
        capabilities: active.capabilities || desktop.capabilities,
        targets: allTargets,
        activeTarget: active.id,
        targetName: active.name,
        bothInstalled
      };
    },
    async reloadDictionary() {
      dictionary = loadDictionary(rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count });
      return { ok: true, dictEntries: count };
    },
    async configure(input) {
      const previous = settings.get();
      assertLaunchSettingsMutable(input, previous, session.phase);
      const next = settings.update(input);
      await cdp.refresh();
      if (next.enableI18n !== previous.enableI18n) {
        events.log('I18N', next.enableI18n ? '汉化已开启' : '汉化已关闭，原文已恢复', 'tag-i18n');
        // The debugger port is only passed when the preload is needed at launch.
        if (next.enableI18n && session.phase === 'running' && !cdp.running) {
          events.log('SYSTEM', '本次启动未开调试端口，汉化将在重启 Antigravity 后生效', 'tag-warn');
        }
      }
      if (input.enableProxy !== undefined && input.enableProxy !== previous.enableProxy) {
        events.log('SYSTEM', next.enableProxy ? `免 TUN 代理已开启（127.0.0.1:${next.port}）` : '免 TUN 代理已关闭（直连模式）', 'tag-proxy');
      }
      if (input.targetApp !== undefined && input.targetApp !== previous.targetApp) {
        const target = desktop.resolveTarget ? desktop.resolveTarget(next.targetApp, next) : { name: next.targetApp };
        events.log('SYSTEM', `已切换启动目标为: ${target.fullName || target.name}`, 'tag-proxy');
        events.publish(app.status());
      }
      if (input.customHubPath !== undefined && input.customHubPath !== previous.customHubPath) {
        events.log('SYSTEM', next.customHubPath ? `已更新桌面版路径: ${next.customHubPath}` : '已恢复桌面版默认检测路径', 'tag-proxy');
        events.publish(app.status());
      }
      if (input.customIdePath !== undefined && input.customIdePath !== previous.customIdePath) {
        events.log('SYSTEM', next.customIdePath ? `已更新 IDE 路径: ${next.customIdePath}` : '已恢复 IDE 默认检测路径', 'tag-proxy');
        events.publish(app.status());
      }
      return next;
    },
    async start() {
      const port = await api.listen(native ? 0 : 19823);
      events.log('SYSTEM', `AG Launcher 桌面内核就绪，已载入 ${Object.keys(dictionary).length} 条汉化词条`, 'tag-proxy');
      if (process.env.AGL_READY_FILE) writeJson(process.env.AGL_READY_FILE, { port, pid: process.pid, token });
      if (!native && !testMode) {
        // Standalone runs have no readiness file to carry the token, so print the capability URL once.
        const panelUrl = `http://127.0.0.1:${port}/#token=${token}`;
        console.log(`AGL 面板: ${panelUrl}`);
        host.open(panelUrl);
      }
      void session.attachExisting().catch(error => events.log('SYSTEM', error.message, 'tag-warn'));
      return port;
    },
    close(reason) {
      if (closing) return closing;
      closing = (async () => {
        events.log('SYSTEM', '正在退出: ' + reason, 'tag-warn');
        const result = await session.close(reason);
        host.dispose();
        api.close();
        onClose(result);
        return result;
      })();
      return closing;
    }
  };
  const api = createApi(app, { token });
  app.api = api;
  app.token = token;
  return app;
}

module.exports = { createApplication };
