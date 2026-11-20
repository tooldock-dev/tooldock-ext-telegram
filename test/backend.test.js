'use strict';
/** 後端（backend/index.js）：以假的 ctx 與假的 Telegram API 測試流程 */
const test = require('node:test');
const assert = require('node:assert/strict');

const TOKEN = '123456789:AAHabcdefghijklmnopqrstuvwxyz0123456';

/** 假的 Telegram：記錄收到的方法與參數 */
function fakeTelegram() {
  /** @type {{ method: string, body: any }[]} */
  const calls = [];
  let nextId = 100;
  /** @type {Record<string, any>} */
  const chatsById = {
    '-22': { id: -22, type: 'group', title: '維運群組' },
    '11': { id: 11, type: 'private', first_name: 'Andy' },
  };
  global.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    const method = url.split('/').pop() || '';
    const body = init.body instanceof FormData ? init.body : JSON.parse(init.body);
    calls.push({ method, body });
    const ok = (/** @type {any} */ result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (!url.includes(TOKEN)) return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) };
    if (method === 'getMe') return ok({ id: 1, username: 'demo_bot', first_name: 'Demo' });
    if (method === 'getChat') {
      const c = chatsById[body.chat_id];
      return c ? ok(c) : { status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) };
    }
    if (method === 'getUpdates') return ok([{ update_id: 1, message: { chat: chatsById['-22'] } }]);
    return ok({ message_id: nextId++ });
  });
  return calls;
}

/** 假的 ctx：handler、指令、storage、secrets、事件 */
function fakeCtx() {
  /** @type {Record<string, Function>} */
  const handlers = {};
  /** @type {Record<string, Function>} */
  const commands = {};
  /** @type {Record<string, any>} */
  const store = {};
  /** @type {Record<string, string>} */
  const secrets = {};
  /** @type {{ name: string, data: any }[]} */
  const events = [];
  const ctx = {
    log: { info() {}, warn() {}, error() {} },
    storage: { get: (/** @type {string} */ k, /** @type {any} */ d) => (k in store ? store[k] : d), set: (/** @type {string} */ k, /** @type {any} */ v) => { store[k] = v; } },
    secrets: {
      available: async () => true,
      get: async (/** @type {string} */ k) => secrets[k] ?? null,
      set: async (/** @type {string} */ k, /** @type {string} */ v) => { secrets[k] = v; },
      delete: async (/** @type {string} */ k) => { delete secrets[k]; },
    },
    settings: { get: () => undefined },
    ui: { handle: (/** @type {string} */ n, /** @type {Function} */ f) => { handlers[n] = f; }, emit: (/** @type {string} */ name, /** @type {any} */ data) => events.push({ name, data }) },
    commands: { register: (/** @type {string} */ n, /** @type {Function} */ f) => { commands[n] = f; return { dispose() {} }; } },
    window: { openView: async () => true },
    subscriptions: /** @type {any[]} */ ([]),
  };
  return { ctx, handlers, commands, store, secrets, events };
}

function load() {
  delete require.cache[require.resolve('../backend/index.js')];
  return require('../backend/index.js');
}

/** 假的匯入資訊 */
function fakeInfo() {
  /** @type {Function[]} */
  const listeners = [];
  return {
    origin: 'share', producer: { extId: 'oracle-sql', name: 'Oracle SQL 工具' }, cancelled: false,
    onCancel: (/** @type {Function} */ fn) => { listeners.push(fn); return { dispose() {} }; },
    cancel: () => listeners.forEach((fn) => fn()),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('設定 Token：驗證後存進 secrets；格式錯誤或無效時拒絕', async () => {
  fakeTelegram();
  const ext = load();
  const f = fakeCtx();
  ext.activate(f.ctx);
  await assert.rejects(f.handlers.setToken('abc'), /格式不正確/);
  await assert.rejects(f.handlers.setToken('999999:AAHabcdefghijklmnopqrstuvwxyz0123456'), /Bot Token 無效/);
  const bot = await f.handlers.setToken(TOKEN);
  assert.equal(bot.user, 'demo_bot');
  assert.equal(f.secrets.botToken, TOKEN);
  assert.ok(!JSON.stringify(f.store).includes(TOKEN), 'storage 不應含權杖');
  const s = await f.handlers.state();
  assert.equal(s.hasToken, true);
  assert.equal(s.secure, true);
});

test('聊天室：新增時向 Telegram 確認、第一個為預設、找不到時報錯', async () => {
  fakeTelegram();
  const ext = load();
  const f = fakeCtx();
  ext.activate(f.ctx);
  await f.handlers.setToken(TOKEN);
  await assert.rejects(f.handlers.addChat({ chatId: 'abc def' }), /格式不正確/);
  await assert.rejects(f.handlers.addChat({ chatId: '-999' }), /找不到聊天室/);
  const g = await f.handlers.addChat({ chatId: '-22' });
  assert.equal(g.name, '維運群組');
  assert.equal(g.isDefault, true);
  const p = await f.handlers.addChat({ chatId: '11', name: '我' });
  assert.equal(p.isDefault, false);
  await assert.rejects(f.handlers.addChat({ chatId: '11' }), /已經在清單/);

  const found = await f.handlers.findChats();
  assert.deepEqual(found, [{ chatId: '-22', name: '維運群組', type: 'group', added: true }]);

  f.handlers.setDefault(p.id);
  f.handlers.removeChat(p.id);
  assert.equal(f.store.chats.length, 1);
  assert.equal(f.store.chats[0].isDefault, true, '刪掉預設後由剩下的第一個接手');
});

test('指令 telegram.send：預設聊天室、依名稱指定、附檔、錯誤記錄', async () => {
  const calls = fakeTelegram();
  const ext = load();
  const f = fakeCtx();
  ext.activate(f.ctx);
  await assert.rejects(f.commands['telegram.send']('x'), /還沒有設定聊天室/);
  await f.handlers.setToken(TOKEN);
  await f.handlers.addChat({ chatId: '-22' });
  await f.handlers.addChat({ chatId: '11', name: '我' });
  calls.length = 0;

  const r1 = await f.commands['telegram.send']('備份完成');
  assert.equal(r1.chat, '維運群組');
  assert.deepEqual(calls[0], { method: 'sendMessage', body: { chat_id: '-22', text: '備份完成', disable_notification: false, link_preview_options: { is_disabled: true } } });

  await f.commands['telegram.send']({ text: '<b>警告</b>', html: true, chat: '我', silent: true });
  assert.equal(calls[1].body.chat_id, '11');
  assert.equal(calls[1].body.parse_mode, 'HTML');
  assert.equal(calls[1].body.disable_notification, true);

  await f.commands['telegram.send']({ file: { filename: 'r/1.csv', content: 'a,b' }, caption: '日報', chat: '11' });
  assert.equal(calls[2].method, 'sendDocument');
  assert.equal(/** @type {File} */ (calls[2].body.get('document')).name, 'r_1.csv');

  await assert.rejects(f.commands['telegram.send']({ text: 'x', chat: '不存在' }), /找不到聊天室「不存在」/);
  assert.equal(f.store.history.length, 3);
  assert.ok(f.store.history.every((/** @type {any} */ h) => h.ok && h.source === '指令'));
});

test('接收表格：排隊等待畫面確認，以文字或 CSV 發送並回傳結果', async () => {
  const calls = fakeTelegram();
  const ext = load();
  const f = fakeCtx();
  ext.activate(f.ctx);
  await f.handlers.setToken(TOKEN);
  const chat = await f.handlers.addChat({ chatId: '-22' });
  calls.length = 0;

  const pkg = { id: 'p1', type: 'tooldock.table', title: '加班時數', payload: { columns: [{ name: 'a', title: '姓名' }, { name: 'h', type: 'decimal' }], rows: [['王', '1.5']] } };
  const done = ext.importTable(f.ctx, pkg, fakeInfo());
  await flush();
  const s = await f.handlers.state();
  assert.equal(s.pending.id, 'p1');
  assert.equal(s.pending.defaultMode, 'text');
  assert.equal(s.pending.producer, 'Oracle SQL 工具');
  assert.equal(s.pending.stats, '2 欄 × 1 列');
  assert.equal(calls.length, 0, '使用者確認前不發送');

  await f.handlers.resolveImport({ id: 'p1', action: 'send', chat: chat.id, mode: 'text' });
  const r = await done;
  assert.equal(r.status, 'imported');
  assert.match(r.message, /維運群組/);
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.match(calls[0].body.text, /^<b>加班時數<\/b>\n<pre>姓名 |   h\n/);
  assert.equal((await f.handlers.state()).pending, null);

  // CSV 附檔
  const done2 = ext.importTable(f.ctx, { ...pkg, id: 'p2' }, fakeInfo());
  await f.handlers.resolveImport({ id: 'p2', action: 'send', mode: 'file' });
  assert.equal((await done2).status, 'imported');
  assert.equal(calls[1].method, 'sendDocument');
  assert.match(/** @type {File} */ (calls[1].body.get('document')).name, /^加班時數-\d{8}-\d{4}\.csv$/);
});

test('接收文字：大量文字預設用附檔；取消與工作台取消', async () => {
  fakeTelegram();
  const ext = load();
  const f = fakeCtx();
  ext.activate(f.ctx);
  await f.handlers.setToken(TOKEN);
  await f.handlers.addChat({ chatId: '-22' });

  const big = ext.importText(f.ctx, { id: 't1', type: 'tooldock.text', title: '日誌', payload: { mime: 'text/plain', text: 'x'.repeat(20000) } }, fakeInfo());
  await flush();
  assert.equal((await f.handlers.state()).pending.defaultMode, 'file');
  await f.handlers.resolveImport({ id: 't1', action: 'cancel' });
  assert.equal((await big).status, 'cancelled');

  const info = fakeInfo();
  const csv = ext.importText(f.ctx, { id: 't2', type: 'tooldock.text', title: '匯出', payload: { mime: 'text/csv', text: 'a,b', filename: 'out.csv' } }, info);
  await flush();
  const s = await f.handlers.state();
  assert.equal(s.pending.defaultMode, 'file');
  assert.equal(s.pending.filename, 'out.csv');
  info.cancel();
  assert.equal((await csv).status, 'cancelled');
  await assert.rejects(f.handlers.resolveImport({ id: 't2', action: 'send' }), /已經處理過/);

  assert.deepEqual(ext.importText(f.ctx, { id: 't3', payload: { mime: 'text/plain', text: '  ' } }, fakeInfo()), { status: 'rejected', message: '內容是空的' });
});

test('發送失敗時分享保留在佇列，可以重試', async () => {
  fakeTelegram();
  const ext = load();
  const f = fakeCtx();
  ext.activate(f.ctx);
  await f.handlers.setToken(TOKEN);
  await f.handlers.addChat({ chatId: '-22' });
  const real = global.fetch;
  global.fetch = /** @type {any} */ (async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
  const done = ext.importText(f.ctx, { id: 'r1', type: 'tooldock.text', title: 't', payload: { mime: 'text/plain', text: 'hi' } }, fakeInfo());
  await assert.rejects(f.handlers.resolveImport({ id: 'r1', action: 'send' }), /ECONNRESET/);
  assert.equal((await f.handlers.state()).pending.id, 'r1');
  assert.equal(f.store.history[0].ok, false);
  global.fetch = real;
  await f.handlers.resolveImport({ id: 'r1', action: 'send' });
  assert.equal((await done).status, 'imported');
});
