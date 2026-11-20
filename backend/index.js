// @ts-check
'use strict';
/**
 * Telegram 通知：後端
 *
 * - Bot Token 以 ctx.secrets 加密保存（無法使用鑰匙圈時退回 ctx.storage 並在畫面警告）
 * - 聊天室清單、發送紀錄存在 ctx.storage
 * - 接收 tooldock.text / tooldock.table：開啟畫面預覽，使用者選聊天室後才發送
 * - 指令 telegram.send：讓其他擴充直接發送通知（不經確認）
 */
const T = require('./telegram');

const TOKEN_KEY = 'botToken';
const HISTORY_MAX = 100;

/**
 * @typedef {{ id: string, chatId: string, name: string, type: string, isDefault?: boolean }} Chat
 * @typedef {{ at: number, chat: string, chatId: string, kind: 'text' | 'file', summary: string, source: string, ok: boolean, error?: string }} HistoryItem
 * @typedef {{ id: string, user?: string, name: string }} BotInfo
 * @typedef {{ kind: 'text', text: string, html: boolean } | { kind: 'file', filename: string, content: string | Uint8Array, mime: string, caption: string }} SendSpec
 * @typedef {{
 *   preview: string, stats: string, defaultMode: 'text' | 'file', filename: string,
 *   build: (mode: 'text' | 'file') => SendSpec,
 * }} ImportSpec
 * @typedef {ImportSpec & {
 *   id: string, type: string, title: string, producer: string, origin: string,
 *   resolve: (r: any) => void, busy?: boolean,
 * }} PendingImport
 */

/** @type {any} */
let ctx;
/** @type {PendingImport[]} */
const queue = [];

/** @param {any} c */
exports.activate = (c) => {
  ctx = c;

  const h = (/** @type {string} */ name, /** @type {(...a: any[]) => any} */ fn) => ctx.ui.handle(name, fn);
  h('state', state);
  h('setToken', setToken);
  h('clearToken', clearToken);
  h('testBot', refreshBot);
  h('findChats', findChats);
  h('addChat', addChat);
  h('renameChat', (/** @type {string} */ id, /** @type {string} */ name) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('名稱不可為空');
    return saveChats(chats().map((x) => (x.id === id ? { ...x, name: n } : x)));
  });
  h('removeChat', (/** @type {string} */ id) => {
    let list = chats().filter((x) => x.id !== id);
    if (list.length && !list.some((x) => x.isDefault)) list = list.map((x, i) => ({ ...x, isDefault: i === 0 }));
    return saveChats(list);
  });
  h('setDefault', (/** @type {string} */ id) => saveChats(chats().map((x) => ({ ...x, isDefault: x.id === id }))));
  h('testChat', (/** @type {string} */ id) => sendTo(resolveChat(id),
    { kind: 'text', text: '✅ ToolDock 測試訊息：可以收到通知了', html: false }, { source: '測試' }));
  h('send', (/** @type {{ chat: string, text: string, html?: boolean, silent?: boolean }} */ a) => sendTo(resolveChat(a.chat),
    { kind: 'text', text: String(a.text || ''), html: !!a.html }, { silent: a.silent, source: '手動' }));
  h('clearHistory', () => { ctx.storage.set('history', []); pushState(); return true; });
  h('resolveImport', resolveImport);

  ctx.subscriptions.push(
    ctx.commands.register('telegram.open', () => ctx.window.openView('telegram.main')),
    ctx.commands.register('telegram.send', sendCommand),
  );
};

exports.deactivate = () => {
  for (const p of queue.slice()) p.resolve({ status: 'cancelled', message: 'Telegram 通知已停止' });
};

// ── 狀態 ──────────────────────────────────────────────

/** @returns {Chat[]} */
const chats = () => ctx.storage.get('chats', []);
/** @returns {HistoryItem[]} */
const history = () => ctx.storage.get('history', []);
/** @returns {BotInfo | null} */
const botInfo = () => ctx.storage.get('bot', null);

/** @param {Chat[]} list */
function saveChats(list) {
  ctx.storage.set('chats', list);
  pushState();
  return list;
}

async function secure() {
  return !!(ctx.secrets && await ctx.secrets.available());
}

/** @returns {Promise<string>} */
async function getToken() {
  if (await secure()) return (await ctx.secrets.get(TOKEN_KEY)) || '';
  return ctx.storage.get('plainToken', '') || '';
}

function apiOptions() {
  return {
    apiBase: ctx.settings.get('telegram.apiBase') || undefined,
    timeoutMs: Math.max(5, Number(ctx.settings.get('telegram.timeoutSeconds')) || 30) * 1000,
  };
}

async function client() {
  const token = await getToken();
  if (!token) throw new T.TelegramError('尚未設定 Bot Token：請到「Telegram 通知」畫面設定');
  return T.createClient({ token, ...apiOptions() });
}

async function state() {
  return {
    bot: botInfo(),
    hasToken: !!(await getToken()),
    secure: await secure(),
    chats: chats(),
    history: history(),
    pending: queue.length ? publicPending(queue[0]) : null,
    queued: queue.length,
  };
}

function pushState() {
  state().then((s) => ctx.ui.emit('state', s), () => {});
}

/** @param {PendingImport} p */
function publicPending(p) {
  return {
    id: p.id, type: p.type, title: p.title, producer: p.producer, origin: p.origin,
    preview: p.preview, stats: p.stats, defaultMode: p.defaultMode, filename: p.filename, busy: !!p.busy,
  };
}

// ── Bot 設定 ─────────────────────────────────────────

/** @param {any} me @returns {BotInfo} */
const toBot = (me) => ({ id: String(me.id), user: me.username, name: me.first_name });

/** @param {string} raw */
async function setToken(raw) {
  const token = String(raw || '').trim();
  if (!T.isToken(token)) throw new Error('Bot Token 格式不正確，應類似 123456789:AAH…（向 @BotFather 取得）');
  const bot = toBot(await T.createClient({ token, ...apiOptions() }).getMe());
  if (await secure()) {
    await ctx.secrets.set(TOKEN_KEY, token);
    ctx.storage.set('plainToken', '');
  } else {
    ctx.storage.set('plainToken', token);
  }
  ctx.storage.set('bot', bot);
  ctx.log.info(`已設定 bot：@${bot.user}`);
  pushState();
  return bot;
}

async function clearToken() {
  if (await secure()) await ctx.secrets.delete(TOKEN_KEY);
  ctx.storage.set('plainToken', '');
  ctx.storage.set('bot', null);
  pushState();
  return true;
}

async function refreshBot() {
  const bot = toBot(await (await client()).getMe());
  ctx.storage.set('bot', bot);
  pushState();
  return bot;
}

// ── 聊天室 ───────────────────────────────────────────

async function findChats() {
  const updates = await (await client()).getUpdates();
  const known = new Set(chats().map((x) => x.chatId));
  return T.chatsFromUpdates(updates).map((x) => ({ ...x, added: known.has(x.chatId) }));
}

/** @param {{ chatId: string, name?: string }} a */
async function addChat(a) {
  const chatId = String(a.chatId || '').trim();
  if (!T.isChatId(chatId)) throw new Error('chat_id 格式不正確：應為數字（群組為負數）或 @頻道名稱');
  if (chats().some((x) => x.chatId === chatId)) throw new Error('這個聊天室已經在清單中');
  // 向 Telegram 確認 bot 看得到這個聊天室，順便取得名稱與類型
  const info = await (await client()).getChat(chatId);
  if (chats().some((x) => x.chatId === String(info.id))) throw new Error('這個聊天室已經在清單中');
  const list = chats();
  /** @type {Chat} */
  const chat = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    chatId: String(info.id),
    name: String(a.name || '').trim() || T.chatName(info),
    type: info.type,
    isDefault: list.length === 0,
  };
  saveChats([...list, chat]);
  return chat;
}

/**
 * 依 id、chat_id 或名稱找聊天室；省略時使用預設聊天室
 * @param {string | number | undefined} ref
 * @returns {Chat}
 */
function resolveChat(ref) {
  const list = chats();
  if (!list.length) throw new Error('還沒有設定聊天室：請到「Telegram 通知」畫面新增');
  if (ref === undefined || ref === null || ref === '') return list.find((x) => x.isDefault) || list[0];
  const s = String(ref).trim();
  const hit = list.find((x) => x.id === s) || list.find((x) => x.chatId === s)
    || list.find((x) => x.name === s) || list.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`找不到聊天室「${s}」，可用的有：${list.map((x) => x.name).join('、')}`);
  return hit;
}

// ── 發送 ─────────────────────────────────────────────

/**
 * @param {Chat} chat @param {SendSpec} spec
 * @param {{ silent?: boolean, source: string }} o
 */
async function sendTo(chat, spec, o) {
  const summary = spec.kind === 'text'
    ? T.truncate((spec.html ? spec.text.replace(/<[^>]+>/g, '') : spec.text).replace(/\s+/g, ' ').trim(), 80)
    : `📎 ${spec.filename}`;
  try {
    const api = await client();
    const ids = spec.kind === 'text'
      ? await api.sendText(chat.chatId, spec.text, { parseMode: spec.html ? 'HTML' : '', silent: o.silent })
      : await api.sendDocument(chat.chatId, { filename: spec.filename, content: spec.content, mime: spec.mime }, { caption: spec.caption, silent: o.silent });
    record({ at: Date.now(), chat: chat.name, chatId: chat.chatId, kind: spec.kind, summary, source: o.source, ok: true });
    return { ok: true, chat: chat.name, messageIds: ids };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record({ at: Date.now(), chat: chat.name, chatId: chat.chatId, kind: spec.kind, summary, source: o.source, ok: false, error: msg });
    ctx.log.warn(`發送到「${chat.name}」失敗：${msg}`);
    throw err;
  }
}

/** @param {HistoryItem} item */
function record(item) {
  ctx.storage.set('history', [item, ...history()].slice(0, HISTORY_MAX));
  pushState();
}

/**
 * 指令 telegram.send：給其他擴充或 lifecycle hook 呼叫
 *
 *   await ctx.commands.execute('telegram.send', '備份完成');
 *   await ctx.commands.execute('telegram.send', { text: '<b>警告</b>', html: true, chat: '維運群組' });
 *   await ctx.commands.execute('telegram.send', { file: { filename: 'a.csv', content: 'x,y' }, caption: '日報' });
 *
 * 不帶參數（從命令面板執行）時開啟畫面
 * @param {any} arg
 */
async function sendCommand(arg) {
  if (arg === undefined || arg === null) {
    await ctx.window.openView('telegram.main');
    return null;
  }
  const a = typeof arg === 'string' ? { text: arg } : arg;
  if (typeof a !== 'object') throw new Error('telegram.send 參數應為文字或 { text, chat?, html?, silent?, file? }');
  const chat = resolveChat(a.chat);
  if (a.file) {
    const f = a.file;
    if (!f.filename || (typeof f.content !== 'string' && !(f.content instanceof Uint8Array))) {
      throw new Error('file 需要 filename 與 content（文字或 Uint8Array）');
    }
    return sendTo(chat, {
      kind: 'file', filename: T.safeFilename(f.filename), content: f.content, mime: f.mime || 'application/octet-stream',
      caption: String(a.caption ?? a.text ?? ''),
    }, { silent: a.silent, source: '指令' });
  }
  return sendTo(chat, { kind: 'text', text: String(a.text ?? ''), html: !!a.html }, { silent: a.silent, source: '指令' });
}

// ── 接收分享 ──────────────────────────────────────────

/** 檔名用的時間 */
function stamp() {
  const d = new Date();
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 排進佇列，等畫面決定發送或取消
 * @param {any} pkg @param {any} info @param {ImportSpec} spec
 * @returns {Promise<any>}
 */
function enqueue(pkg, info, spec) {
  return new Promise((resolve) => {
    /** @type {PendingImport} */
    const p = {
      ...spec,
      id: String(pkg.id || Date.now().toString(36)),
      type: pkg.type,
      title: pkg.title || '(未命名)',
      producer: (info.producer && info.producer.name) || (info.origin === 'file' ? '交換檔' : '其他工具'),
      origin: info.origin,
      resolve: (r) => {
        const i = queue.indexOf(p);
        if (i < 0) return;
        queue.splice(i, 1);
        resolve(r);
        pushState();
      },
    };
    queue.push(p);
    info.onCancel(() => p.resolve({ status: 'cancelled', message: '已取消' }));
    pushState();
  });
}

/** @param {any} _ctx @param {any} pkg @param {any} info */
exports.importTable = (_ctx, pkg, info) => {
  /** @type {import('./telegram').Table} */
  const table = pkg.payload || {};
  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    return { status: 'rejected', message: '表格格式不正確' };
  }
  const n = table.rows.length;
  const title = pkg.title || '表格';
  const html = `<b>${T.escapeHtml(title)}</b>\n<pre>${T.escapeHtml(T.tableToText(table, { maxRows: 50 }))}</pre>`;
  const filename = `${T.safeFilename(title)}-${stamp()}.csv`;
  return enqueue(pkg, info, {
    preview: T.tableToText(table, { maxRows: 30 }),
    stats: `${table.columns.length} 欄 × ${n} 列`,
    defaultMode: n <= 50 && html.length <= T.MAX_MESSAGE ? 'text' : 'file',
    filename,
    build: (mode) => (mode === 'text'
      ? { kind: 'text', text: html, html: true }
      : { kind: 'file', filename, content: T.tableToCsv(table), mime: 'text/csv', caption: `${title}（${n} 列）` }),
  });
};

/** @param {any} _ctx @param {any} pkg @param {any} info */
exports.importText = (_ctx, pkg, info) => {
  const p = pkg.payload || {};
  const text = String(p.text ?? '');
  if (!text.trim()) return { status: 'rejected', message: '內容是空的' };
  const mime = String(p.mime || 'text/plain');
  const plain = mime === 'text/plain' || mime === 'text/markdown';
  const ext = mime === 'application/json' ? 'json' : (mime.split('/')[1] || '').replace(/[^a-z0-9]/gi, '') || 'txt';
  const filename = T.safeFilename(p.filename || `${pkg.title || 'text'}-${stamp()}.${ext}`);
  return enqueue(pkg, info, {
    preview: text.length > 4000 ? `${text.slice(0, 4000)}\n…（共 ${text.length} 字）` : text,
    stats: `${mime}，${text.length} 字`,
    defaultMode: plain && text.length <= T.MAX_MESSAGE * 3 ? 'text' : 'file',
    filename,
    build: (mode) => (mode === 'text'
      ? { kind: 'text', text, html: false }
      : { kind: 'file', filename, content: text, mime, caption: pkg.title || '' }),
  });
};

/**
 * 畫面決定如何處理排在最前面的分享
 * @param {{ id: string, action: 'send' | 'cancel', chat?: string, mode?: 'text' | 'file', silent?: boolean }} a
 */
async function resolveImport(a) {
  const p = queue.find((x) => x.id === a.id);
  if (!p) throw new Error('這筆分享已經處理過或被取消');
  if (a.action === 'cancel') {
    p.resolve({ status: 'cancelled', message: '使用者取消發送' });
    return { status: 'cancelled' };
  }
  if (p.busy) throw new Error('正在發送中');
  const chat = resolveChat(a.chat);
  p.busy = true;
  pushState();
  try {
    const r = await sendTo(chat, p.build(a.mode === 'file' ? 'file' : 'text'), { silent: a.silent, source: `分享：${p.producer}` });
    p.resolve({ status: 'imported', message: `已發送到 Telegram「${chat.name}」`, data: { chatId: chat.chatId, messageIds: r.messageIds } });
    return r;
  } finally {
    p.busy = false;
    pushState();
  }
}
