// @ts-check
/** Telegram 通知：畫面 */
const td = /** @type {any} */ (window).tooldock;

/** @template {HTMLElement} T @param {string} sel @returns {T} */
const $ = (sel) => /** @type {T} */ (document.querySelector(sel));
const esc = (/** @type {unknown} */ s) => td.escape(String(s ?? ''));
const errMsg = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * @typedef {{ id: string, chatId: string, name: string, type: string, isDefault?: boolean }} Chat
 * @typedef {{ at: number, chat: string, kind: string, summary: string, source: string, ok: boolean, error?: string }} HistoryItem
 * @typedef {{ id: string, title: string, producer: string, origin: string, type: string, preview: string, stats: string, defaultMode: 'text'|'file', filename: string, busy: boolean }} Pending
 * @typedef {{ bot: { user?: string, name: string } | null, hasToken: boolean, secure: boolean, chats: Chat[], history: HistoryItem[], pending: Pending | null, queued: number }} State
 */

/** @type {State} */
let state = { bot: null, hasToken: false, secure: true, chats: [], history: [], pending: null, queued: 0 };
/** 目前顯示中的分享 id，換一筆時才重設選項 */
let shownPending = '';

const TYPES = /** @type {Record<string, string>} */ ({ private: '個人', group: '群組', supergroup: '超級群組', channel: '頻道' });

/** @param {HTMLElement} el @param {string} text @param {'ok'|'err'|'warn'|''} [kind] */
function say(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

/**
 * 按鈕執行期間停用，錯誤顯示在狀態列
 * @param {HTMLButtonElement} btn @param {HTMLElement} out @param {() => Promise<string | void>} fn
 */
async function busy(btn, out, fn) {
  btn.disabled = true;
  say(out, '處理中…');
  try {
    const msg = await fn();
    say(out, msg || '', 'ok');
  } catch (e) {
    say(out, errMsg(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

/** @param {HTMLSelectElement} sel */
function fillChatSelect(sel) {
  const prev = sel.value;
  sel.innerHTML = state.chats.length
    ? state.chats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.isDefault ? '（預設）' : ''}</option>`).join('')
    : '<option value="">（尚未設定聊天室）</option>';
  const def = state.chats.find((c) => c.isDefault);
  sel.value = state.chats.some((c) => c.id === prev) ? prev : (def ? def.id : (state.chats[0] ? state.chats[0].id : ''));
}

function render() {
  // Bot
  const b = state.bot;
  const badge = $('#botBadge');
  if (state.hasToken && b) {
    badge.className = 'badge ok';
    badge.textContent = `@${b.user}`;
    $('#botName').innerHTML = `🤖 <b>${esc(b.name)}</b> <span class="muted">@${esc(b.user)}</span>`;
  } else {
    badge.className = 'badge warn';
    badge.textContent = '未設定 Bot';
  }
  const hasBot = state.hasToken && !!b;
  if (!$('#botSet').dataset.changing) {
    $('#botNone').hidden = hasBot;
    $('#botSet').hidden = !hasBot;
  }
  $('#insecure').hidden = state.secure || !state.hasToken;

  // 聊天室
  const tbody = $('#chats tbody');
  tbody.innerHTML = state.chats.length
    ? state.chats.map((c) => `<tr data-id="${esc(c.id)}">
        <td><input type="radio" name="def" data-act="default" ${c.isDefault ? 'checked' : ''}></td>
        <td class="name">${esc(c.name)}</td>
        <td class="mono">${esc(c.chatId)}</td>
        <td>${esc(TYPES[c.type] || c.type)}</td>
        <td class="actions">
          <button class="secondary" data-act="test">測試</button>
          <button class="ghost" data-act="rename">改名</button>
          <button class="danger" data-act="remove">刪除</button>
        </td></tr>`).join('')
    : `<tr><td colspan="5" class="faint">${hasBot ? '還沒有聊天室：對 bot 傳一則訊息後按「尋找最近聊天室」' : '先設定 Bot'}</td></tr>`;
  fillChatSelect($('#msgChat'));
  fillChatSelect($('#pChat'));
  for (const id of ['#addChat', '#findChats', '#sendMsg']) /** @type {HTMLButtonElement} */ ($(id)).disabled = !hasBot;

  // 紀錄
  $('#history tbody').innerHTML = state.history.length
    ? state.history.slice(0, 30).map((h) => `<tr>
        <td>${esc(new Date(h.at).toLocaleString('zh-TW', { hour12: false }))}</td>
        <td>${esc(h.chat)}</td>
        <td class="summary">${esc(h.summary)}</td>
        <td>${esc(h.source)}</td>
        <td class="${h.ok ? 'ok' : 'err'}">${h.ok ? '✓' : `✗ ${esc(h.error || '')}`}</td></tr>`).join('')
    : '<tr><td colspan="5" class="faint">尚無紀錄</td></tr>';

  renderPending();
}

function renderPending() {
  const p = state.pending;
  const card = $('#pending');
  card.hidden = !p;
  if (!p) { shownPending = ''; return; }
  if (p.id !== shownPending) {
    shownPending = p.id;
    $('#pTitle').textContent = p.title;
    $('#pMeta').textContent = `來自「${p.producer}」・${p.stats}`;
    const pre = $('#pPreview');
    pre.textContent = p.preview;
    pre.classList.toggle('wrap', p.type !== 'tooldock.table');
    $('#pFile').textContent = p.filename;
    const r = /** @type {HTMLInputElement | null} */ (document.querySelector(`input[name="pMode"][value="${p.defaultMode}"]`));
    if (r) r.checked = true;
    say($('#pStatus'), '');
    card.scrollIntoView({ block: 'start' });
  }
  const q = $('#pQueue');
  q.style.display = state.queued > 1 ? '' : 'none';
  q.textContent = `還有 ${state.queued - 1} 筆`;
  /** @type {HTMLButtonElement} */ ($('#pSend')).disabled = p.busy || !state.chats.length || !state.hasToken;
}

/** @param {State} s */
function setState(s) {
  state = s;
  render();
}

// ── Bot ──
$('#saveToken').addEventListener('click', (e) => busy(/** @type {any} */ (e.currentTarget), $('#botStatus'), async () => {
  /** @type {HTMLInputElement} */
  const input = $('#token');
  const bot = await td.invoke('setToken', input.value);
  input.value = '';
  delete $('#botSet').dataset.changing;
  render();
  return `已連線：@${bot.user}`;
}));
$('#token').addEventListener('keydown', (e) => { if (/** @type {KeyboardEvent} */ (e).key === 'Enter') $('#saveToken').click(); });
$('#testBot').addEventListener('click', (e) => busy(/** @type {any} */ (e.currentTarget), $('#botStatus'), async () => {
  const bot = await td.invoke('testBot');
  return `連線正常：@${bot.user}`;
}));
$('#changeToken').addEventListener('click', () => {
  $('#botSet').dataset.changing = '1';
  $('#botNone').hidden = false;
  $('#token').focus();
});
$('#clearToken').addEventListener('click', async () => {
  const r = await td.dialog.message({ type: 'warning', message: '移除 Bot Token？', detail: '聊天室清單會保留，重新設定 Token 後即可繼續使用。', buttons: ['移除', '取消'], cancelId: 1 });
  if (r && r.response === 0) { await td.invoke('clearToken'); say($('#botStatus'), '已移除'); }
});

// ── 聊天室 ──
$('#addChat').addEventListener('click', (e) => busy(/** @type {any} */ (e.currentTarget), $('#chatStatus'), async () => {
  /** @type {HTMLInputElement} */ const id = $('#newChatId');
  /** @type {HTMLInputElement} */ const name = $('#newChatName');
  const chat = await td.invoke('addChat', { chatId: id.value, name: name.value });
  id.value = ''; name.value = '';
  return `已新增「${chat.name}」`;
}));

$('#findChats').addEventListener('click', (e) => busy(/** @type {any} */ (e.currentTarget), $('#chatStatus'), async () => {
  /** @type {{ chatId: string, name: string, type: string, added: boolean }[]} */
  const list = await td.invoke('findChats');
  $('#found').innerHTML = list.length
    ? `<table class="grid"><tbody>${list.map((c) => `<tr>
        <td>${esc(c.name)}</td><td class="mono">${esc(c.chatId)}</td><td>${esc(TYPES[c.type] || c.type)}</td>
        <td style="text-align:right">${c.added ? '<span class="faint">已在清單</span>'
          : `<button data-chat="${esc(c.chatId)}" data-name="${esc(c.name)}">加入</button>`}</td></tr>`).join('')}</tbody></table>`
    : '';
  return list.length ? `找到 ${list.length} 個聊天室` : '沒有最近的訊息：請先對 bot 傳一則訊息（群組需把 bot 加入後在群組發言），再按一次';
}));

$('#found').addEventListener('click', (e) => {
  const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-chat]');
  if (!(btn instanceof HTMLButtonElement)) return;
  busy(btn, $('#chatStatus'), async () => {
    const chat = await td.invoke('addChat', { chatId: btn.dataset.chat, name: btn.dataset.name });
    btn.replaceWith(Object.assign(document.createElement('span'), { className: 'ok', textContent: '✓ 已加入' }));
    return `已新增「${chat.name}」`;
  });
});

$('#chats').addEventListener('click', (e) => {
  const el = /** @type {HTMLElement} */ (e.target);
  const act = el.dataset.act;
  const tr = el.closest('tr');
  const id = tr && tr.dataset.id;
  if (!act || !id) return;
  const out = $('#chatStatus');
  if (act === 'default') td.invoke('setDefault', id);
  else if (act === 'test') busy(/** @type {any} */ (el), out, async () => { const r = await td.invoke('testChat', id); return `已發送測試訊息到「${r.chat}」`; });
  else if (act === 'remove') {
    const c = state.chats.find((x) => x.id === id);
    td.dialog.message({ type: 'warning', message: `刪除聊天室「${c ? c.name : ''}」？`, buttons: ['刪除', '取消'], cancelId: 1 })
      .then((/** @type {any} */ r) => { if (r && r.response === 0) td.invoke('removeChat', id); });
  } else if (act === 'rename') {
    const cell = /** @type {HTMLElement} */ (tr.querySelector('td.name'));
    const input = Object.assign(document.createElement('input'), { className: 'rename', value: cell.textContent || '' });
    cell.replaceChildren(input);
    input.focus();
    input.select();
    const done = (/** @type {boolean} */ save) => {
      if (!input.isConnected) return;
      if (save && input.value.trim()) td.invoke('renameChat', id, input.value).catch((/** @type {unknown} */ err) => say(out, errMsg(err), 'err'));
      else render();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') done(true);
      if (ev.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }
});

// ── 發送訊息 ──
function sendManual() {
  /** @type {HTMLTextAreaElement} */ const msg = $('#msg');
  busy($('#sendMsg'), $('#msgStatus'), async () => {
    if (!msg.value.trim()) throw new Error('訊息內容不可為空');
    const r = await td.invoke('send', {
      chat: /** @type {HTMLSelectElement} */ ($('#msgChat')).value,
      text: msg.value,
      html: /** @type {HTMLInputElement} */ ($('#msgHtml')).checked,
      silent: /** @type {HTMLInputElement} */ ($('#msgSilent')).checked,
    });
    msg.value = '';
    return `已發送到「${r.chat}」`;
  });
}
$('#sendMsg').addEventListener('click', sendManual);
$('#msg').addEventListener('keydown', (e) => {
  const k = /** @type {KeyboardEvent} */ (e);
  if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) { k.preventDefault(); sendManual(); }
});

$('#clearHistory').addEventListener('click', () => td.invoke('clearHistory'));

// ── 分享 ──
$('#pSend').addEventListener('click', (e) => {
  const p = state.pending;
  if (!p) return;
  const mode = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="pMode"]:checked'));
  busy(/** @type {any} */ (e.currentTarget), $('#pStatus'), async () => {
    const r = await td.invoke('resolveImport', {
      id: p.id, action: 'send',
      chat: /** @type {HTMLSelectElement} */ ($('#pChat')).value,
      mode: mode ? mode.value : p.defaultMode,
      silent: /** @type {HTMLInputElement} */ ($('#pSilent')).checked,
    });
    td.toast(`已發送到 Telegram「${r.chat}」`, 'success');
  });
});
$('#pCancel').addEventListener('click', () => {
  const p = state.pending;
  if (p) td.invoke('resolveImport', { id: p.id, action: 'cancel' }).catch(() => {});
});

td.on('state', setState);
td.invoke('state').then(setState);
