#!/usr/bin/env node
// Dictionary coverage audit.
//   node tools/audit-dict.mjs            static + live (attaches to a running Antigravity over CDP)
//   node tools/audit-dict.mjs --static   dictionary hygiene only
//
// Live mode is read-only: it walks the same nodes the translator sees and reports the
// English that is still untranslated. It never clicks, types or writes to the page.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICT_FILES = ['ui_v2.json', 'common.json'];
const ignored = 'script,style,pre,code,textarea,[contenteditable="true"],[data-testid*="message-content"]';

function loadDicts() {
  const per = {};
  for (const name of DICT_FILES) {
    const file = path.join(root, 'dicts', name);
    per[name] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  const merged = {};
  for (const name of DICT_FILES) Object.assign(merged, per[name]);
  return { per, merged };
}

function staticAudit({ per, merged }) {
  const rows = [];
  const all = Object.keys(merged);
  rows.push(['词条总数', all.length]);

  const same = all.filter(k => merged[k] === k);
  if (same.length) rows.push(['译名与原文相同（等于没翻）', same.length, same.slice(0, 5)]);

  const alreadyChinese = all.filter(k => /[\u4e00-\u9fff]/.test(k));
  if (alreadyChinese.length) rows.push(['key 本身含中文', alreadyChinese.length, alreadyChinese.slice(0, 5)]);

  const padded = all.filter(k => k !== k.trim());
  if (padded.length) rows.push(['key 首尾有空白', padded.length, padded.map(k => JSON.stringify(k)).slice(0, 5)]);

  const empty = all.filter(k => !merged[k].trim());
  if (empty.length) rows.push(['译名为空字符串（会把界面清空）', empty.length, empty.slice(0, 5)]);

  const overLong = all.filter(k => k.length > 2000 || merged[k].length > 2000);
  if (overLong.length) rows.push(['超过长度上限（会被丢弃）', overLong.length]);

  const dupes = [];
  for (const [name, dict] of Object.entries(per)) {
    for (const key of Object.keys(dict)) {
      for (const other of DICT_FILES) {
        if (other === name) continue;
        if (Object.prototype.hasOwnProperty.call(per[other], key) && per[other][key] !== dict[key]) {
          dupes.push([key, name + ':' + dict[key], other + ':' + per[other][key]]);
        }
      }
    }
  }
  const seen = new Set();
  const uniqueDupes = dupes.filter(d => { const id = d[0]; if (seen.has(id)) return false; seen.add(id); return true; });
  if (uniqueDupes.length) rows.push([`两个词典文件里同 key 不同译（后者生效：${DICT_FILES.at(-1)}）`, uniqueDupes.length, uniqueDupes.slice(0, 5)]);

  console.log('== 词典静态检查 ==');
  for (const [label, count, sample] of rows) {
    console.log(`  ${label}: ${count}`);
    if (sample) for (const s of sample) console.log('      -', Array.isArray(s) ? s.join('  =>  ') : s);
  }
  return { rows, total: all.length };
}

function readPorts() {
  const ports = [];
  const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Antigravity', 'DevToolsActivePort');
  try {
    const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
    const port = Number(first);
    if (Number.isInteger(port) && port > 0) ports.push(port);
  } catch { /* no discovery file */ }
  for (const port of [9333, 9222]) if (!ports.includes(port)) ports.push(port);
  return ports;
}

const getJson = (port, route) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 2000 }, res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
});

const COLLECTOR = `(() => {
  const ignored = ${JSON.stringify(ignored)};
  const out = new Map();
  const english = s => /[A-Za-z]/.test(s) && !/[\\u4e00-\\u9fff]/.test(s) && s.length >= 2 && s.length <= 160;
  const where = el => {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    const testid = el.getAttribute('data-testid');
    const role = el.getAttribute('role');
    return tag + (testid ? '[' + testid + ']' : '') + (role ? '[' + role + ']' : '');
  };
  const add = (raw, kind, el) => {
    if (!raw) return;
    const text = String(raw).trim().replace(/\\s+/g, ' ');
    if (!english(text)) return;
    const id = kind + ' | ' + text;
    const rec = out.get(id) || { text, kind, count: 0, where: new Set() };
    rec.count++;
    const w = where(el);
    if (w && rec.where.size < 3) rec.where.add(w);
    out.set(id, rec);
  };
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest(ignored) || !visible(parent)) continue;
    add(node.nodeValue, 'text', parent);
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
    if (el.closest(ignored) || !visible(el)) continue;
    for (const name of ['placeholder', 'title', 'aria-label']) {
      const value = el.getAttribute(name);
      if (value) add(value, name, el);
    }
  }
  const items = [...out.values()].map(r => ({ text: r.text, kind: r.kind, count: r.count, where: [...r.where] }));
  items.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  return { url: location.href, title: document.title, items };
})()`;

async function liveAudit({ merged }) {
  let lastError = 'no endpoint';
  for (const port of readPorts()) {
    let targets;
    try { targets = await getJson(port, '/json/list'); } catch (error) { lastError = `port ${port}: ${error.message}`; continue; }
    const page = (Array.isArray(targets) ? targets : []).find(t => t.type === 'page' && /^(https?:\/\/(127\.0\.0\.1|localhost)|file:|vscode-file:|app:)/.test(t.url));
    if (!page) { lastError = `port ${port}: no local page target`; continue; }

    const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 8 * 1024 * 1024 });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('evaluate timeout')), 10000);
      socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: COLLECTOR, returnByValue: true, awaitPromise: true } }));
    });
    socket.close();
    if (result.exceptionDetails) throw new Error('collector failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 200));
    const data = result.result.value;
    if (!data) throw new Error('collector returned nothing');

    const missing = data.items.filter(item => !Object.prototype.hasOwnProperty.call(merged, item.text));
    const inDictButEnglish = data.items.filter(item => Object.prototype.hasOwnProperty.call(merged, item.text));

    console.log('\n== 在线检查（只读 attach） ==');
    console.log(`  页面: ${data.url}`);
    console.log(`  当前可视但仍是英文的片段: ${data.items.length} 条（去重后）`);
    console.log(`    其中词典里已有、却没被替换: ${inDictButEnglish.length} 条  ← 说明注入被跳过或节点在排除区`);
    console.log(`    词典里没有（真正的缺口）: ${missing.length} 条`);

    if (inDictButEnglish.length) {
      console.log('\n  -- 有词条但仍是英文（优先查这里） --');
      for (const item of inDictButEnglish.slice(0, 20)) console.log(`    [${item.count}x] ${item.text}   (${item.where.join(', ')})`);
    }
    if (missing.length) {
      console.log('\n  -- 未命中的英文（按出现次数） --');
      for (const item of missing.slice(0, 60)) console.log(`    [${item.count}x] ${item.text}   (${item.kind}; ${item.where.join(', ')})`);
    }
    const outFile = path.join(root, 'tools', 'missing-dict-candidates.json');
    fs.writeFileSync(outFile, JSON.stringify(missing.map(i => ({ text: i.text, kind: i.kind, count: i.count, where: i.where, translation: '' })), null, 2) + '\n', 'utf8');
    console.log(`\n  候选清单已写入 ${path.relative(root, outFile)}（translation 留空，避免空字符串清空界面）`);
    return { port, total: data.items.length, missing, inDictButEnglish };
  }
  console.log('\n== 在线检查 ==');
  console.log(`  连不上运行中的 Antigravity（${lastError}）。先把 AG 打开再跑，或只用 --static。`);
  return null;
}

const dicts = loadDicts();
staticAudit(dicts);
if (!process.argv.includes('--static')) await liveAudit(dicts);
