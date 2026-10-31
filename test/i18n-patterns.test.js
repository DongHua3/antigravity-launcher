const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { translatePattern, installI18n, loadDictionary } = require('../features/i18n');

test('Number-carrying UI text is translated by pattern', () => {
  const cases = new Map([
    ['Worked for 7m', '工作了 7 分钟'],
    ['Worked for 1m 30s', '工作了 1 分钟 30 秒'],
    ['Thinking for 12s', '思考中 12 秒'],
    ['Thought for 4s', '思考了 4 秒'],
    ['3h ago', '3 小时前'],
    ['15m ago', '15 分钟前'],
    ['just now', '刚刚'],
    ['5 files changed', '5 个文件已更改'],
    ['1 file changed', '1 个文件已更改'],
    ['Open external link: https://example.com/x', '打开外部链接：https://example.com/x']
  ]);
  for (const [input, expected] of cases) assert.equal(translatePattern(input), expected, input);
});

test('Patterns stay anchored and never rewrite ordinary sentences', () => {
  for (const input of [
    'Worked for 7m extra',   // trailing words
    'I worked for 7 months', // different verb and unit
    '7m',                    // bare duration is ambiguous
    'Worked for ever',
    '3h ago ago',
    'hello world',
    '',
    'files changed'
  ]) {
    assert.equal(translatePattern(input), null, input);
  }
  assert.equal(translatePattern(undefined), null);
  assert.equal(translatePattern(42), null);
});

test('A dictionary hit still wins over a pattern', () => {
  const dictionary = { 'just now': '方才' };
  const calls = [];
  const window = {
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4 }
  };
  const body = { nodeType: 1, isConnected: true, closest: () => null, querySelectorAll: () => [], getAttribute: () => null, setAttribute() {} };
  const node = { nodeType: 3, nodeValue: 'just now', parentElement: body, isConnected: true };
  const document = {
    body,
    documentElement: body,
    createTreeWalker() { let index = -1; return { nextNode() { index += 1; return index < 1; }, get currentNode() { return node; } }; }
  };
  installI18n(window, document, dictionary, true, text => { calls.push(text); return '刚刚'; });
  assert.equal(node.nodeValue, '方才', 'Exact dictionary entry takes precedence');
  assert.deepEqual(calls, [], 'The pattern is not consulted when an exact entry exists');
});

test('Pattern translations are reverted like dictionary ones', () => {
  const window = {
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4 }
  };
  const body = { nodeType: 1, isConnected: true, closest: () => null, querySelectorAll: () => [], getAttribute: () => null, setAttribute() {} };
  const node = { nodeType: 3, nodeValue: 'Worked for 21m', parentElement: body, isConnected: true };
  const document = {
    body,
    documentElement: body,
    createTreeWalker() { let index = -1; return { nextNode() { index += 1; return index < 1; }, get currentNode() { return node; } }; }
  };
  const runtime = installI18n(window, document, {}, true, translatePattern);
  assert.equal(node.nodeValue, '工作了 21 分钟');
  runtime.dispose();
  assert.equal(node.nodeValue, 'Worked for 21m');
});

test('The shipped payload carries the pattern table into the page', () => {
  const { rendererSource } = require('../adapters/desktop/renderer');
  const source = rendererSource(loadDictionary(path.resolve(__dirname, '..')), { enableI18n: true });
  assert.ok(source.includes('translatePattern') || source.includes('Worked for'), 'pattern table must be embedded');
  assert.ok(source.length < 1024 * 1024, 'payload stays injectable');
});
