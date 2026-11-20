'use strict';
/** Telegram 用戶端與訊息整理（backend/telegram.js） */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../backend/telegram.js');

const TOKEN = '123456789:AAHabcdefghijklmnopqrstuvwxyz0123456';

/**
 * 假的 fetch：依序回傳 responses，並記錄每次呼叫
 * @param {Array<{ status?: number, body: any } | Error>} responses
 */
function fakeFetch(responses) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('沒有預設回應');
    if (r instanceof Error) throw r;
    return /** @type {any} */ ({ status: r.status || 200, json: async () => r.body });
  };
  return { fn: /** @type {any} */ (fn), calls };
}

test('呼叫 API：網址含權杖、JSON 內容', async () => {
  const f = fakeFetch([{ body: { ok: true, result: { id: 1, username: 'demo_bot', first_name: 'Demo' } } }]);
  const api = T.createClient({ token: TOKEN, fetch: f.fn });
  const me = await api.getMe();
  assert.equal(me.username, 'demo_bot');
  assert.equal(f.calls[0].url, `https://api.telegram.org/bot${TOKEN}/getMe`);
  assert.equal(f.calls[0].init.method, 'POST');
});

test('自訂 API 位址（去掉結尾斜線）', async () => {
  const f = fakeFetch([{ body: { ok: true, result: true } }]);
  await T.createClient({ token: TOKEN, apiBase: 'https://tg.example.com/', fetch: f.fn }).call('getMe');
  assert.equal(f.calls[0].url, `https://tg.example.com/bot${TOKEN}/getMe`);
});

test('錯誤訊息翻成中文，且不含權杖', async () => {
  const f = fakeFetch([
    { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } },
    { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } },
    Object.assign(new Error(`fetch failed ${TOKEN}`), { cause: { code: 'ENOTFOUND' } }),
  ]);
  const api = T.createClient({ token: TOKEN, fetch: f.fn });
  await assert.rejects(api.getMe(), /Bot Token 無效/);
  await assert.rejects(api.getChat('1'), /找不到聊天室/);
  await assert.rejects(api.getMe(), (/** @type {any} */ err) => {
    assert.match(String(err.message), /無法連線到 Telegram：ENOTFOUND/);
    assert.ok(!String(err.message).includes(TOKEN));
    return true;
  });
});

test('429 依 retry_after 等待後重試一次', async () => {
  const f = fakeFetch([
    { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } } },
    { body: { ok: true, result: { message_id: 7 } } },
  ]);
  /** @type {number[]} */
  const waited = [];
  const api = T.createClient({ token: TOKEN, fetch: f.fn, sleep: async (ms) => { waited.push(ms); } });
  assert.deepEqual(await api.sendText('1', 'hi'), [7]);
  assert.deepEqual(waited, [2000]);
  assert.equal(f.calls.length, 2);
});

test('sendText 超過 4096 字自動分段', async () => {
  const f = fakeFetch([{ body: { ok: true, result: { message_id: 1 } } }, { body: { ok: true, result: { message_id: 2 } } }]);
  const api = T.createClient({ token: TOKEN, fetch: f.fn });
  const text = `${'甲'.repeat(3000)}\n${'乙'.repeat(3000)}`;
  assert.deepEqual(await api.sendText('-100', text, { silent: true }), [1, 2]);
  const bodies = f.calls.map((c) => JSON.parse(c.init.body));
  assert.equal(bodies[0].text, '甲'.repeat(3000));
  assert.equal(bodies[1].text, '乙'.repeat(3000));
  assert.equal(bodies[0].chat_id, '-100');
  assert.equal(bodies[0].disable_notification, true);
});

test('sendDocument 以 multipart 上傳', async () => {
  const f = fakeFetch([{ body: { ok: true, result: { message_id: 9 } } }]);
  const api = T.createClient({ token: TOKEN, fetch: f.fn });
  assert.deepEqual(await api.sendDocument('5', { filename: 'a.csv', content: 'x,y', mime: 'text/csv' }, { caption: '日報' }), [9]);
  const form = f.calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('chat_id'), '5');
  assert.equal(form.get('caption'), '日報');
  const file = /** @type {File} */ (form.get('document'));
  assert.equal(file.name, 'a.csv');
  assert.equal(await file.text(), 'x,y');
});

test('splitMessage：優先在換行切開，不切斷代理對', () => {
  assert.deepEqual(T.splitMessage('a\nb', 10), ['a\nb']);
  assert.deepEqual(T.splitMessage('aaaa\nbbbb\ncccc', 10), ['aaaa\nbbbb', 'cccc']);
  const emoji = '😀'.repeat(10); // 每個 2 個 UTF-16 單位
  for (const part of T.splitMessage(emoji, 5)) assert.ok(!/[\ud800-\udbff]$/.test(part));
  assert.throws(() => T.splitMessage('  \n'), /不可為空/);
});

test('splitHtml：<pre> 整段跨訊息時每段各自包起來', () => {
  const parts = T.splitHtml(`<pre>${'a'.repeat(30)}\n${'b'.repeat(30)}</pre>`, 50);
  assert.equal(parts.length, 2);
  for (const p of parts) assert.match(p, /^<pre>[ab]+<\/pre>$/);
});

test('tableToText：對齊、數字靠右、中文寬度、超過列數註明', () => {
  const table = {
    columns: [{ name: 'name', title: '姓名', type: 'string' }, { name: 'h', title: '時數', type: 'decimal' }, { name: 'j', type: 'json' }],
    rows: [['王小明', '12.5', { a: 1 }], ['Amy', '3', null], ['x', '1', null]],
  };
  const text = T.tableToText(table, { maxRows: 2 });
  const lines = text.split('\n');
  assert.equal(lines[0], '姓名   | 時數 | j');
  assert.equal(lines[2], '王小明 | 12.5 | {"a":1}');
  assert.equal(lines[3], 'Amy    |    3 |');
  assert.equal(lines[4], '…另有 1 列未顯示');
  // 每一列的分隔符號位置一致（以顯示寬度計算）
  const sep = (/** @type {string} */ l) => T.displayWidth(l.slice(0, l.indexOf('|')));
  assert.equal(sep(lines[0]), sep(lines[2]));
  assert.equal(sep(lines[2]), sep(lines[3]));
});

test('tableToText：過長的值截斷', () => {
  const text = T.tableToText({ columns: [{ name: 'a' }], rows: [['x'.repeat(100)], ['多\n行']] }, { maxCell: 10 });
  assert.match(text, /x{9}…/);
  assert.match(text, /多 行/);
});

test('tableToCsv：BOM、跳脫、null 與物件', () => {
  const csv = T.tableToCsv({ columns: [{ name: 'a', title: '欄,一' }, { name: 'b' }], rows: [['say "hi"', null], [{ x: 1 }, 2]] });
  assert.equal(csv, '﻿"欄,一",b\r\n"say ""hi""",\r\n"{""x"":1}",2\r\n');
});

test('chatsFromUpdates：去重，最新的在前，名稱取標題或姓名', () => {
  const updates = [
    { update_id: 1, message: { chat: { id: 11, type: 'private', first_name: 'Andy', last_name: 'T' } } },
    { update_id: 2, message: { chat: { id: -22, type: 'group', title: '維運群組' } } },
    { update_id: 3, message: { chat: { id: 11, type: 'private', first_name: 'Andy', last_name: 'T' } } },
    { update_id: 4, channel_post: { chat: { id: -1003, type: 'channel', title: '公告', username: 'news' } } },
    { update_id: 5, callback_query: {} },
  ];
  assert.deepEqual(T.chatsFromUpdates(updates), [
    { chatId: '-1003', name: '公告', type: 'channel' },
    { chatId: '11', name: 'Andy T', type: 'private' },
    { chatId: '-22', name: '維運群組', type: 'group' },
  ]);
});

test('格式檢查', () => {
  assert.ok(T.isToken(TOKEN));
  assert.ok(!T.isToken('abc'));
  assert.ok(T.isChatId('-1001234567890'));
  assert.ok(T.isChatId('@my_channel'));
  assert.ok(!T.isChatId('my channel'));
  assert.equal(T.safeFilename('a/b:c?'), 'a_b_c_');
  assert.equal(T.escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
});
