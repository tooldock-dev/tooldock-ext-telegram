# ✈️ Telegram 通知

ToolDock 擴充：用 Telegram bot 發送通知。

- **多個聊天室**：個人、群組、頻道都可以，指定一個預設聊天室；「尋找最近聊天室」自動找出 chat_id，不用手動查。
- **Bot Token 加密保存**：以作業系統鑰匙圈保護（`ctx.secrets`），磁碟上只有密文。
- **接收分享**：其他工具分享的 `tooldock.table`（表格）與 `tooldock.text`（文字、CSV、JSON）會開啟預覽，選好聊天室才發送。
  - 表格可以轉成等寬文字訊息，或以 CSV 附檔發送（含 BOM，Excel 開啟不亂碼）；超過 50 列預設用附檔。
  - 文字超過 4096 字會自動分段，CSV / JSON 預設用附檔。
  - Oracle SQL 工具查詢結果的「分享」按鈕可以直接送到 Telegram。
- **指令 `telegram.send`**：其他擴充、生命週期 hook 可以直接發送通知（不經確認）。
- **發送紀錄**：保留最近 100 筆，失敗原因以中文說明。

需要 ToolDock 1.4.0 以上。

## 設定步驟

1. 在 Telegram 找 **@BotFather**，傳送 `/newbot` 建立 bot，取得 Token。
2. 開啟「Telegram 通知」，貼上 Token 按「驗證並儲存」。
3. 個人通知：對 bot 傳一則訊息；群組通知：把 bot 加進群組後在群組發言；頻道：把 bot 設為頻道管理員。
4. 按「尋找最近聊天室」，把要用的聊天室加入清單，按「測試」確認收得到。

> 這個 bot 已經設定 webhook 時無法讀取最近訊息，請手動輸入 chat_id（群組為負數，頻道可以用 `@頻道名稱`）。

| 設定 | 預設 | 說明 |
|---|---|---|
| `telegram.apiBase` | `https://api.telegram.org` | 使用自架 Bot API 伺服器或公司反向代理時修改 |
| `telegram.timeoutSeconds` | 30 | 單次呼叫逾時 |

## 給其他擴充：`telegram.send`

```js
// 發送到預設聊天室
await ctx.commands.execute('telegram.send', '備份完成');

// 指定聊天室（名稱或 chat_id）、HTML 格式、靜音
await ctx.commands.execute('telegram.send', { text: '<b>站台異常</b>', html: true, chat: '維運群組', silent: false });

// 附檔（content 可以是文字或 Uint8Array）
await ctx.commands.execute('telegram.send', { file: { filename: 'report.csv', content: csv, mime: 'text/csv' }, caption: '日報' });
```

成功時回傳 `{ ok: true, chat, messageIds }`，失敗時丟出錯誤（例如沒有設定 Token、找不到聊天室、網路不通）。沒有安裝 Telegram 通知時 `execute` 會丟出「找不到指令」，呼叫端請自行處理。

HTML 格式只支援 Telegram 允許的標籤（`<b>`、`<i>`、`<code>`、`<pre>`、`<a href>`…），內容裡的 `<`、`>`、`&` 要自己跳脫。

## 限制

- 平台沒有沙箱，任何已安裝的擴充都能呼叫 `telegram.send`。
- Node 的網路連線不會套用系統代理伺服器設定；公司網路無法直接連到 `api.telegram.org` 時，請設定 `telegram.apiBase` 指向可用的反向代理。
- 附檔上限 50 MB（Telegram Bot API 限制）。

## 測試

```bash
npm test
```

以假的 Telegram API 與假的 `ctx` 測試：API 呼叫與錯誤說明、429 重試、長訊息分段、表格轉文字與 CSV、聊天室管理、指令、分享的確認／取消／失敗重試。

## 開發

需要先安裝 ToolDock 和 Node.js 18 以上。

| 指令 | 說明 |
|---|---|
| `npm run dev` | 以開發模式啟動 ToolDock 並載入這個擴充。存檔後會自動重新載入後端和畫面 |
| `npm run debug` | 同上，並開啟後端偵錯埠 `127.0.0.1:9229` |
| `npm run validate` | 檢查 manifest、檔案和相依套件 |
| `npm run pack` | 打包成 `dist/telegram-<版本>.tbx`，只含正式相依 |
| `npm run install-local` | 打包並安裝到本機的 ToolDock |

開發模式使用獨立的資料目錄（`ToolDock-ExtDev`），可以和平常使用的 ToolDock 同時開啟，互不干擾。如果想從乾淨的狀態開始，執行 `npm run dev -- --fresh`。

找不到 ToolDock 時，可以用 `--app` 參數或 `TOOLDOCK_PATH` 環境變數指定位置：

```bash
TOOLDOCK_PATH=/Applications/ToolDock.app npm run dev
```

## 偵錯

**後端**

- **VS Code**：按 F5 選「ToolDock：啟動並偵錯擴充」，就能在 `backend/` 設中斷點。擴充重新載入後，除錯器會自動重新連線。
- **其他工具**：執行 `npm run debug`，再到 Chrome 開啟 `chrome://inspect` 附加。
- **偵錯啟動流程**：要偵錯 `activate()` 本身時，執行 `npm run dev -- --inspect-brk`，擴充會停在第一行等待除錯器。

**畫面**：在 ToolDock 的分頁上按右鍵，選「檢查此畫面」，開發者工具會直接定位到這個擴充的畫面。

**日誌**：`ctx.log.*` 和 `console.log` 會顯示在 ToolDock 的輸出面板（`⇧⌘U`），也會顯示在執行 `npm run dev` 的終端機。

## 發佈

專案已附上 GitHub Actions 流程 `.github/workflows/release.yml`：推送 `v*` tag 後，會自動驗證、打包、簽章，並建立 GitHub Release。ToolDock 商店會從 Release 下載並驗證簽章。

**第一次設定（只需做一次）**

1. 產生簽章金鑰：

   ```bash
   npx tooldock-ext keygen
   ```

   私鑰會存到 `~/.tooldock/keys/tooldock-signing-key.pem`（權限 600），終端機會印出公鑰字串。請另外備份私鑰，**不要提交到 git**。

2. 把私鑰加入 GitHub repo 的 secret `TOOLDOCK_SIGNING_KEY`：

   ```bash
   gh secret set TOOLDOCK_SIGNING_KEY < ~/.tooldock/keys/tooldock-signing-key.pem
   ```

   也可以到 GitHub repo →「Settings → Secrets and variables → Actions」新增，內容貼上私鑰檔的全部文字（包含 `-----BEGIN PRIVATE KEY-----` 那兩行）。

3. 把公鑰字串提交到 ToolDock 商店索引。
4. 選用：把公鑰設為 repo variable `TOOLDOCK_PUBLIC_KEY`，CI 發佈前會再驗證一次，可以及早發現 secret 設錯：

   ```bash
   gh variable set TOOLDOCK_PUBLIC_KEY --body "<公鑰字串>"
   ```

**每次發佈**

```bash
npm version patch        # 或 minor / major；會更新 package.json 並建立 v<版本> tag
git push --follow-tags
```

tag 必須是 `v` 加上 `package.json` 的版本（例如 `v0.2.0`），不一致時 CI 會失敗。`package-lock.json` 必須提交，CI 使用 `npm ci` 安裝。

Release 會附上三個檔案：

| 檔案 | 內容 |
|---|---|
| `telegram-<版本>.tbx` | 擴充套件 |
| `telegram-<版本>.tbx.sha256` | `.tbx` 的 SHA-256 |
| `telegram-<版本>.tbx.sig` | Ed25519 簽章 |

沒有設定 `TOOLDOCK_SIGNING_KEY` 時，CI 仍會發佈 `.tbx` 和 `.sha256`，但會顯示「未簽章，商店不會收錄」的警告。

**在本機簽章與驗證**

```bash
npx tooldock-ext pack --sign --key ~/.tooldock/keys/tooldock-signing-key.pem
npx tooldock-ext verify dist/telegram-<版本>.tbx --public-key <公鑰字串>
```

## 專案結構

```
package.json         manifest（畫面、指令、設定、交換接收）
backend/index.js     後端：Token、聊天室、發送、接收分享、telegram.send
backend/telegram.js  Bot API 用戶端與訊息整理（不依賴 ToolDock，可單獨測試）
ui/                  畫面
test/                單元測試
.tbxignore        打包時要排除的檔案
.github/workflows/release.yml  推送 v* tag 時自動發佈
```

## 加入函式庫

```bash
npm install <套件>
```

用 `npm install` 安裝的套件會列在 `dependencies`，打包時一起帶走，ToolDock 平台不需要更新。`devDependencies` 不會被打包。

API 型別定義在 `node_modules/tooldock-types/index.d.ts`。編輯器裡的自動完成和型別檢查已經透過 `jsconfig.json` 設定好了。
