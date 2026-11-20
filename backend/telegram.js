// @ts-check
'use strict';
/**
 * Telegram Bot API 用戶端與訊息整理（不依賴 ToolDock，可單獨測試）
 * API 文件：https://core.telegram.org/bots/api
 */

/** 單則訊息的長度上限（Telegram 以 UTF-16 計算） */
const MAX_MESSAGE = 4096;
/** 附檔說明文字上限 */
const MAX_CAPTION = 1024;

class TelegramError extends Error {
  /** @param {string} message @param {number} [code] @param {number} [retryAfter] */
  constructor(message, code, retryAfter) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** 錯誤訊息裡不能出現權杖 @param {string} text @param {string} token */
function scrub(text, token) {
  return token ? String(text).split(token).join('***') : String(text);
}

/**
 * @param {{ token: string, apiBase?: string, fetch?: typeof fetch, timeoutMs?: number, sleep?: (ms: number) => Promise<void> }} opts
 */
function createClient(opts) {
  const token = String(opts.token || '').trim();
  if (!token) throw new TelegramError('尚未設定 Bot Token');
  const base = String(opts.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  const doFetch = opts.fetch || fetch;
  const timeoutMs = opts.timeoutMs || 30000;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  /**
   * @param {string} method
   * @param {Record<string, unknown> | FormData} [params]
   * @returns {Promise<any>}
   */
  async function call(method, params = {}, attempt = 0) {
    const isForm = typeof FormData !== 'undefined' && params instanceof FormData;
    /** @type {Response} */
    let res;
    try {
      res = await doFetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? /** @type {FormData} */ (params) : JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      const why = e && e.name === 'TimeoutError' ? `逾時（${Math.round(timeoutMs / 1000)} 秒）`
        : (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(err);
      throw new TelegramError(scrub(`無法連線到 Telegram：${why}`, token));
    }
    /** @type {any} */
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON（例如代理伺服器的錯誤頁） */ }
    if (body && body.ok) return body.result;

    const code = (body && body.error_code) || res.status;
    const retryAfter = body && body.parameters && body.parameters.retry_after;
    // 429：發送太頻繁，依 retry_after 等待後重試一次（最多等 30 秒）
    if (code === 429 && retryAfter && retryAfter <= 30 && attempt === 0) {
      await sleep(retryAfter * 1000);
      return call(method, params, attempt + 1);
    }
    const desc = (body && body.description) || `HTTP ${res.status}`;
    throw new TelegramError(scrub(explain(code, desc), token), code, retryAfter);
  }

  return {
    call,
    getMe: () => call('getMe'),
    /** @param {number} [offset] */
    getUpdates: (offset) => call('getUpdates', { offset, limit: 100, timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member'] }),
    /** @param {string|number} chatId */
    getChat: (chatId) => call('getChat', { chat_id: chatId }),
    /**
     * 發送文字；超過 4096 字自動分段。回傳各段的 message_id
     * @param {string|number} chatId @param {string} text
     * @param {{ parseMode?: 'HTML' | '', silent?: boolean }} [o]
     */
    async sendText(chatId, text, o = {}) {
      const parts = o.parseMode === 'HTML' ? splitHtml(text) : splitMessage(text);
      /** @type {number[]} */
      const ids = [];
      for (const part of parts) {
        const m = await call('sendMessage', {
          chat_id: chatId,
          text: part,
          parse_mode: o.parseMode || undefined,
          disable_notification: !!o.silent,
          link_preview_options: { is_disabled: true },
        });
        ids.push(m.message_id);
      }
      return ids;
    },
    /**
     * 以附檔發送
     * @param {string|number} chatId @param {{ filename: string, content: string | Uint8Array, mime?: string }} file
     * @param {{ caption?: string, silent?: boolean }} [o]
     */
    async sendDocument(chatId, file, o = {}) {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      const caption = String(o.caption || '');
      if (caption) form.set('caption', truncate(caption, MAX_CAPTION));
      if (o.silent) form.set('disable_notification', 'true');
      const blob = new Blob([file.content], { type: file.mime || 'application/octet-stream' });
      form.set('document', blob, file.filename);
      const m = await call('sendDocument', form);
      return [m.message_id];
    },
  };
}

/** @param {number} code @param {string} desc */
function explain(code, desc) {
  if (code === 401) return 'Bot Token 無效（401 Unauthorized），請確認權杖是否正確或已被撤銷';
  if (code === 404) return 'Bot Token 格式錯誤或 API 位址不正確（404）';
  if (/chat not found/i.test(desc)) return `找不到聊天室：請確認 chat_id，且 bot 已加入該群組或對方已先傳訊息給 bot（${desc}）`;
  if (/bot was blocked/i.test(desc)) return `對方已封鎖 bot（${desc}）`;
  if (/not enough rights|have no rights/i.test(desc)) return `bot 在該聊天室沒有發言權限（${desc}）`;
  if (/can't use getUpdates method while webhook is active/i.test(desc)) return '這個 bot 已設定 webhook，無法讀取最近訊息；請手動輸入 chat_id';
  if (code === 429) return `發送太頻繁，請稍後再試（${desc}）`;
  return `Telegram 回應錯誤 ${code}：${desc}`;
}

/** UTF-16 長度截斷 @param {string} s @param {number} max */
function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * 純文字分段：盡量在換行處切開，每段不超過 max
 * @param {string} text @param {number} [max]
 */
function splitMessage(text, max = MAX_MESSAGE) {
  const s = String(text);
  if (!s.trim()) throw new TelegramError('訊息內容不可為空');
  /** @type {string[]} */
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    // 不要切在代理對中間
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * HTML 模式分段：只在換行處切，且如果某段是 <pre> 區塊的一部分，每段各自補上 <pre></pre>
 * 為了簡單起見，只支援「整段文字是一個 <pre>」或「沒有跨段標籤」兩種情況，其他情況交給 Telegram 報錯
 * @param {string} html @param {number} [max]
 */
function splitHtml(html, max = MAX_MESSAGE) {
  const m = /^<pre>([\s\S]*)<\/pre>$/.exec(html);
  if (m) return splitMessage(m[1], max - 11).map((p) => `<pre>${p}</pre>`);
  return splitMessage(html, max);
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 顯示寬度：中日韓全形字算 2 @param {string} s */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1;
  }
  return w;
}

/** 表格值轉成文字（〈6.4〉值的 JSON 表示） @param {unknown} v */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * @typedef {{ name: string, title?: string, type?: string }} Column
 * @typedef {{ columns: Column[], rows: unknown[][] }} Table
 */

/**
 * 表格轉成等寬對齊的文字（放在 <pre> 內）。maxRows 以外的列省略並註明
 * @param {Table} table @param {{ maxRows?: number, maxCell?: number }} [o]
 */
function tableToText(table, o = {}) {
  const maxRows = o.maxRows ?? 50;
  const maxCell = o.maxCell ?? 40;
  const cols = table.columns || [];
  const rows = (table.rows || []).slice(0, maxRows);
  const clip = (/** @type {string} */ s) => {
    const one = s.replace(/\s*\n\s*/g, ' ');
    if (displayWidth(one) <= maxCell) return one;
    let out = '';
    for (const ch of one) {
      if (displayWidth(out + ch) > maxCell - 1) break;
      out += ch;
    }
    return `${out}…`;
  };
  const head = cols.map((c) => clip(c.title || c.name));
  const body = rows.map((r) => cols.map((_, i) => clip(cellText(r[i]))));
  const numeric = cols.map((c) => ['int', 'decimal', 'float'].includes(String(c.type)));
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...body.map((r) => displayWidth(r[i]))));
  const pad = (/** @type {string} */ s, /** @type {number} */ i) => {
    const gap = ' '.repeat(widths[i] - displayWidth(s));
    return numeric[i] ? gap + s : s + gap;
  };
  const line = (/** @type {string[]} */ cells) => cells.map(pad).join(' | ').replace(/\s+$/, '');
  const lines = [line(head), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(line)];
  const total = (table.rows || []).length;
  if (total > rows.length) lines.push(`…另有 ${total - rows.length} 列未顯示`);
  return lines.join('\n');
}

/** CSV 欄位 @param {string} s */
const csvCell = (s) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** 表格轉 CSV（含 BOM，Excel 開啟中文不亂碼） @param {Table} table */
function tableToCsv(table) {
  const cols = table.columns || [];
  const lines = [cols.map((c) => csvCell(c.title || c.name)).join(',')];
  for (const r of table.rows || []) lines.push(cols.map((_, i) => csvCell(cellText(r[i]))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 檔名不允許的字元 @param {string} s */
function safeFilename(s) {
  return String(s || 'export').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80) || 'export';
}

/**
 * 從 getUpdates 的結果整理出聊天室（去除重複，最新的在前）
 * @param {any[]} updates
 * @returns {{ chatId: string, name: string, type: string }[]}
 */
function chatsFromUpdates(updates) {
  /** @type {Map<string, { chatId: string, name: string, type: string }>} */
  const map = new Map();
  for (const u of [...(updates || [])].reverse()) {
    const msg = u.message || u.channel_post || u.edited_message || u.my_chat_member;
    const chat = msg && msg.chat;
    if (!chat || map.has(String(chat.id))) continue;
    map.set(String(chat.id), { chatId: String(chat.id), name: chatName(chat), type: chat.type });
  }
  return [...map.values()];
}

/** @param {any} chat */
function chatName(chat) {
  if (chat.title) return chat.title;
  const full = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return full || (chat.username ? `@${chat.username}` : String(chat.id));
}

/** chat_id：數字（可為負）或 @頻道名稱 @param {string} s */
function isChatId(s) {
  return /^-?\d{1,20}$/.test(s) || /^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(s);
}

/** Bot Token 格式：<數字>:<35 字元左右> @param {string} s */
function isToken(s) {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(s);
}

module.exports = {
  MAX_MESSAGE, MAX_CAPTION, TelegramError,
  createClient, splitMessage, splitHtml, escapeHtml, displayWidth, cellText, tableToText, tableToCsv,
  safeFilename, chatsFromUpdates, chatName, isChatId, isToken, truncate,
};
