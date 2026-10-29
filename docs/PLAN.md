# Agent Session History：VS Code 擴充規劃

狀態：已確認，實作中（2026-10-27）

## 1. 目標與範圍

在 VS Code 側欄列出本機 Claude Code 與 Codex 的 session 歷史，可切換 Workspace／Project／All 三種範圍，點選後接續該 session。第一版（M0 到 M5）用 TreeView；第二階段（W1、W2）改成卡片式 Webview View，見第 5 節。

**做：**
- 讀取 `~/.claude/projects` 與 `~/.codex/sessions` 的 jsonl，建立索引
- 依專案分組，顯示標題、最後回覆、agent、訊息數、subagent 數、模型、分支、相對時間
- 三種範圍切換、關鍵字過濾、排序、手動與自動刷新
- 動作：接續、開啟原始紀錄、複製 session ID、在檔案總管顯示、移到資源回收筒

**不做：**
- 修改 session 檔案內容；除了「移到資源回收筒」之外，擴充對兩個資料目錄一律唯讀
- 永久刪除、多選批次刪除、依天數自動清理
- 網路連線、遙測、Marketplace 發佈

## 2. 資料來源（已在本機確認，2026-10-27）

| 欄位 | Claude：`~/.claude/projects/<編碼路徑>/<id>.jsonl` | Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
|---|---|---|
| session ID | 檔名，或紀錄裡的 `sessionId` | 第一行 `session_meta.payload.id` |
| 標題 | 最後一筆 `type: "ai-title"` 的 `aiTitle`，沒有就取第一則使用者訊息 | `~/.codex/session_index.jsonl` 的 `thread_name`（849 個裡有 82 個），沒有就取第一則使用者訊息 |
| 使用者訊息 | `type: "user"`，排除 `isMeta`、`isSidechain`、`promptSource: "system"`、純 tool_result，以及以 `<` 開頭的注入文字 | `response_item` 中角色為 user 的 message，排除以 `<` 或 `# AGENTS.md` 開頭的注入文字；VS Code 版取 `## My request for Codex:` 之後的內容 |
| 最後一句回覆 | 最後一筆含文字區塊的 `type: "assistant"` | 最後一筆角色為 assistant 的 `response_item` message |
| 訊息數 | 使用者訊息加上含文字的 assistant 紀錄 | 使用者訊息加上 assistant message |
| subagent 數 | 同名資料夾下 `subagents/*.jsonl` 的數量 | subagent 是獨立的 rollout 檔。父 session ID 優先讀 `source.subagent.thread_spawn.parent_thread_id`，沒有就讀 `session_meta.payload.parent_thread_id`（review 類 subagent 用這個欄位）。只有 `source` 含 `subagent` 的紀錄才採用父 ID，一般 session 即使帶 `parent_thread_id` 也不會被當成子項，避免移動父 session 時連帶移走它；由索引層計算所有後代數量 |
| 模型 | `assistant.message.model`，取最後一筆，排除 `<synthetic>` | `turn_context.payload.model`，取最後一筆 |
| 分支 | 紀錄裡的 `gitBranch`，取最後一筆 | `session_meta.payload.git.branch`（session 開始時的分支；本機 101 個互動 session 中有 59 個帶此欄位），沒有就留空，不用「目前分支」代替 |
| 工作目錄 | 第一筆 user 或 assistant 紀錄的 `cwd` | `session_meta.payload.cwd` |
| 是否為非互動模式 | `entrypoint: "sdk-cli"`（`claude --print`）；互動式是 `cli` 或 `claude-vscode` | `source: "exec"`；`source` 為含 `subagent` 鍵的物件也視為非互動，包括 `thread_spawn` 與 `review` 兩種 |
| 分頁 | 不適用 | `history_mode: "paginated"` 時，同一 thread 會分成 `rollout-…-<id>.jsonl` 與 `rollout-…-<id>_<page>.jsonl`，每頁的 `session_meta.id` 相同且只含接續內容；索引層依 ID 合併：訊息數相加，開始時間、第一句、工作目錄、分支取最早一頁，最後回覆、模型、更新時間、檔案路徑取最新一頁 |
| 時間 | user、assistant 紀錄中第一筆與最後一筆的 `timestamp` | 只看 session_meta、turn_context 與 response_item message；`compacted` 等其他紀錄不算 |

**規模：** Claude 有 32 個專案目錄、54 個 session，單檔中位數 1.3 MB、最大 31 MB；Codex 有 849 個 session，單檔中位數 0.6 MB、最大 35.8 MB。

**M1 實測（2026-10-27，循序解析、尚無快取）：**
- Claude：54 個全部解析成功，互動式 52 個，subagent 檔共 525 個；耗時 0.7 到 0.9 秒。
- Codex：849 個全部解析成功，其中 thread_spawn subagent 687 個、exec 57 個、review subagent 2 個、互動式 103 個；thread_spawn subagent 的父 session 都找得到；耗時約 3.5 秒。
- 加入字串預先過濾之前，Codex 耗時 14.8 秒。
- 沒有標題的 265 個 Codex session 全部是非互動式。

**注意：** 兩邊的 jsonl 都是內部格式，不是公開 API。Claude 一個檔案就有 14 種以上的紀錄類型，CLI 升版就可能改格式。

## 3. 範圍定義

| 範圍 | 判定方式 |
|---|---|
| Workspace | session 的 `cwd` 等於目前任一 workspace 資料夾，或位於其中 |
| Project | session 的 `cwd` 與 workspace 資料夾屬於同一個 git repo，也就是 `git rev-parse --git-common-dir` 相同，因此同一 repo 的所有 worktree 會歸在一起 |
| All | 全部 session，依專案分組 |

- 路徑比對：Windows 上不分大小寫，斜線方向統一，磁碟代號統一大寫（`~/.claude.json` 曾出現 `D:/` 和 `d:/` 兩個重複的鍵）。
- `cwd` 已經不存在或不是 git repo：分組退回以工作目錄分組。Project 範圍仍會保留位於 workspace 資料夾內的這類 session。
- 已知限制：位於 workspace 外、且目錄已刪除的 worktree（例如 Orca 建在 `~/orca/workspaces` 的 worktree），無法判斷屬於哪個 repo，只會出現在 All 範圍。
- 沒有開啟 workspace：Workspace 與 Project 範圍顯示提示訊息，請使用者改用 All。
- git 查詢：以 `git -C <dir> rev-parse --path-format=absolute --git-common-dir` 判斷，同時最多 4 個、逾時 5 秒，結果依目錄快取。查不到的目錄只在手動按 Refresh 時重查，避免自動刷新反覆啟動 git。
- 預設範圍：Workspace。
- 空清單：完全沒有 session 時顯示設定提示；只是目前範圍沒有 session 時，提示切換範圍。W1 起由 webview 顯示，見第 5.1 節「空狀態」。
- 重新索引時，等 git 查詢完成才換上新的 session 清單，避免中途切換範圍看到分組不完整的結果。

## 4. 架構

```
src/
  extension.ts          進入點：索引排程、指令、設定與檔案監看
  model.ts              SessionRecord 型別
  protocol.ts           擴充與 webview 之間的訊息與畫面資料型別（W1）
  actions.ts            接續、開啟原始紀錄、複製 ID、在檔案總管顯示
  trash.ts              移到資源回收筒
  commandLine.ts        CLI 接續指令與 UUID 檢查
  sources/
    claude.ts           解析 Claude jsonl，逐行串流讀取
    codex.ts            解析 Codex rollout jsonl 與 session_index
    lineReader.ts       共用：逐行讀取、跳過超大行、容錯解析
    text.ts             摘要、截斷、注入文字判斷
  index/
    indexer.ts          掃描兩個目錄、限制並行數、合併分頁、計算後代
    cache.ts            以「路徑 + 修改時間 + 大小」做快取，存在 globalStorage
    discover.ts         找出要索引的檔案
    ownedPaths.ts       session 擁有的檔案與大小統計
    refreshScheduler.ts 自動刷新的節流
  scope/
    paths.ts            路徑正規化
    gitRepo.ts          查詢 git common dir，結果依目錄快取
    filter.ts           三種範圍的過濾與分組依據
    search.ts           關鍵字比對
  view/
    format.ts           相對時間、大小格式（webview 也共用）
    grouping.ts         依專案分組與排序
    viewModel.ts        由 session 清單與目前選項產生畫面資料，純函式可單元測試（W1）
    webviewProvider.ts  WebviewViewProvider：HTML、CSP、訊息往返（W1）
  webview/
    main.ts             webview 端的畫面繪製與事件，另行打包成 dist/webview.js（W1）
    tsconfig.json       webview 用 DOM 型別，與擴充端分開檢查（W1）
media/
  sessions.svg          Activity Bar 圖示（面板 + 星芒；自繪，不取自圖示庫）
  webview.css           卡片樣式，只用 --vscode-* 主題變數（W1）
test/
  fixtures/             手寫合成的 Claude 與 Codex 範例 jsonl
  *.test.ts             解析器、索引、範圍、畫面資料的單元測試
```

**SessionRecord 欄位：** `id`、`agent`（claude 或 codex）、`title`、`lastReply`（截斷到 200 字）、`messageCount`、`subagentCount`、`model`、`gitBranch`、`cwd`、`startedAt`、`updatedAt`、`filePath`、`interactive`。

**技術選擇：**
- TypeScript，用 esbuild 打包成單一檔案，執行期零依賴
- 單元測試用 Node 內建的 `node:test`，解析器和過濾邏輯不依賴 vscode 模組，可以獨立測試
- `engines.vscode` 設 `^1.100.0`（本機是 1.142）
- 本機已有 Node v24.14.1 與 npm 11

## 5. 介面

### 5.1 卡片式 Webview View（W1 起）

- **容器**：Activity Bar 容器不變；裡面的 view 改成 `"type": "webview"`，由 `WebviewViewProvider` 提供，取代 TreeView。
- **標題列**：只留重新整理按鈕；範圍、搜尋、排序都移進 webview。命令面板的範圍切換與「Search Sessions」保留，後者改為聚焦 webview 的搜尋框。
- **版面（由上到下）**：
  1. 範圍分頁：Workspace／Project／All，目前範圍反白；選擇記在 workspaceState。
  2. 搜尋框：輸入後延遲 150 ms 過濾，右側有清除按鈕；比對規則同第 5.2 節。
  3. 掃描狀態：左側 `Scanned 905 files`，右側相對時間（如 `4m ago`）。只有首次索引、手動重新整理與設定變更時顯示 `Indexing…` 與進度條；檔案監看觸發的自動刷新在背景進行，避免寫入中的 session 每 10 秒閃一次。有略過的超大行或解析失敗的檔案時，下一行加上提示。
  4. 統計與排序：`118 sessions`（過濾中為 `3 of 118 sessions`），排序可選 Last updated、Created、Messages；排序記在 workspaceState。組內依所選欄位排序，組與組之間依各組第一筆排序。
  5. 專案分組：名稱與數量，可收合；預設只展開第一組，收合狀態存在 webview 的 state。
  6. session 卡片：
     - 標題（單行，過長以省略號截斷）與 `⋯` 按鈕
     - `Agent:` 加最後一句回覆，最多兩行
     - agent 圖示與名稱、訊息數、subagent 數（大於 0 才顯示）、相對時間、模型
     - 分支標籤（有才顯示）；非互動 session 加 `non-interactive` 標籤
- **點卡片**：接續該 session，方式見第 6 節；點在展開的詳細資訊區內、或是拖曳選取文字後放開，都不接續，方便複製文字（例如 session ID）。詳細資訊區的右鍵選單保留複製。
- **`⋯` 按鈕**：跳出 VS Code 的快速選單，列出接續、在終端接續、開啟原始紀錄、在檔案總管顯示、複製 ID、移到資源回收筒。
- **右鍵選單（W2）**：同一組動作，以 `webview/context` 選單提供，依「接續／檢視／複製／刪除」分組；卡片以 `data-vscode-context` 只帶 session key，擴充端照樣從自己的清單找出 session。清單區隱藏 webview 預設的剪下、複製、貼上，搜尋框保留。快速選單與右鍵選單共用同一份動作清單。
- **展開詳細資訊（W2）**：卡片標題列的 ⌄ 按鈕展開第一句提問、工作目錄、session ID、開始與更新時間；展開狀態存在 webview 的 state，重新整理後保留。
- **鍵盤（W2）**：清單只有一個 Tab 停駐點（最後聚焦的群組標題或卡片），卡片內的按鈕不在 Tab 順序中。上下鍵在可見的列之間移動，Home／End 到首末列；右鍵展開群組、進入第一張卡片或展開卡片詳細資訊；左鍵依序收起詳細資訊、回到群組標題、收合群組；Enter 接續；Shift+F10 或選單鍵開啟與 `⋯` 相同的快速選單：Shift+F10 在 keydown 攔截；選單鍵則因瀏覽器放開按鍵時一定會另外觸發 contextmenu，改在 contextmenu 事件取消並開快速選單（VS Code 的 webview 腳本遇到已取消的 contextmenu 就不開原生選單，見 1.143 的 `webview/browser/pre/index.html`），避免同時跳出兩個選單。點過卡片上的按鈕後，焦點回到卡片，方向鍵照常可用。無障礙角色採 tree 模式：清單為 `tree`、群組標題與卡片為 `treeitem`（level 1、2），卡片的朗讀名稱含詳細資訊是否展開。
- **`Current workspace` 標籤（W2）**：session 的工作目錄位於目前開啟的資料夾內時顯示；Workspace 範圍不顯示，因為每張卡片都會有。原規劃名稱為 `Current worktree`，改名是因為開啟的資料夾不一定是 git worktree。
- **相對時間**：webview 每分鐘自行重算，不必等重新索引。
- **主題**：顏色一律用 `--vscode-*` CSS 變數，淺色、深色、高對比主題自動套用；例外只有 Claude 圖示的橘色，以及主題沒提供分隔線顏色時的半透明灰。agent 圖示用自繪的簡單圖形，不放官方 logo。
- **重繪**：組別與內容沒變的卡片沿用原本的 DOM 節點，只換掉有變動的卡片；自動刷新不會打斷焦點、選取的文字，或搜尋中手動收合的組別。搜尋框只在主機端改了關鍵字（例如命令面板的 Clear Search）時才被覆寫：webview 每次送出關鍵字都帶遞增序號，主機在畫面資料裡回報最後套用的序號，比 webview 最後送出的舊就忽略，不會蓋掉正在輸入的字。範圍或排序改變時，非搜尋狀態的組別依記住的展開狀態或「第一組展開」重新計算。
- **空狀態**：webview 不支援 viewsWelcome，改在 webview 內顯示。完全沒有 session 時提供「開啟設定」與「重新整理」按鈕；範圍內沒有 session 時提示切換範圍；沒有開啟資料夾時提示改用 All。
- **隱藏時不保留**：不開 `retainContextWhenHidden`；側欄切走時釋放 webview，切回來時擴充端重送目前畫面資料。
- **安全**：
  - CSP 為 `default-src 'none'`，樣式與腳本只允許擴充自帶、帶 nonce 的檔案，不載入任何外部資源，也不開 command URI。
  - session 內容來自紀錄檔，可能含任意文字：一律用 `textContent` 放進 DOM，不用 `innerHTML`。
  - webview 傳回的訊息只帶 session 的 key（agent 加 ID）；擴充端從自己的清單找出 session 才執行動作，不採用 webview 傳來的路徑或指令。

### 5.2 TreeView（M0 到 M5，W1 起移除）

- **Activity Bar**：新增一個「Agent Session History」容器，裡面放一個 TreeView。
- **TreeView 標題列按鈕**：
  - 切換範圍：Workspace、Project、All 三個按鈕（圖示 folder、repo、globe），用指令的 `toggled` 條件標示目前範圍
  - 搜尋：開輸入框；過濾中時標題列顯示關鍵字，另有清除按鈕
  - 刷新
- **`view.description`**：顯示目前範圍與數量，例如 `All · 118 sessions`。
- **樹狀結構**：
  - 專案節點：名稱 + 數量，預設展開目前 workspace 的專案
  - session 節點：
    - 標籤：標題
    - 說明：`Claude · 22 msgs · 3m ago`
    - 圖示：依 agent 區分
    - tooltip：最後一句回覆、模型、分支、subagent 數、工作目錄、ID
- **排序**：依最後更新時間，新的在前。
- **接續 session**：滑鼠移到該列時出現的 ▶ 按鈕、右鍵選單，或選取後按 Enter。單擊只選取，不觸發動作，因為 VS Code 樹狀清單的項目指令是單擊觸發，會造成誤開終端。在專案節點按 Enter 則是展開或收合。
- **右鍵選單**：接續、開啟原始紀錄（唯讀）、複製 ID、在檔案總管顯示。
- **搜尋**：標題列的搜尋按鈕開輸入框，空白分隔的每個詞都要出現在標題、第一句、最後回覆、分支、模型、工作目錄或 ID 之一，不分大小寫。過濾中標題列顯示「N of M」與關鍵字，並出現清除按鈕。
- **範圍記憶**：上次選的範圍存在 workspaceState。

## 6. 接續 session

W1 起，點卡片改由各 agent 自己的 VS Code 擴充接續，不開終端。終端只保留在 `⋯` 選單的「Resume in Terminal」，以及擴充未安裝時的提示按鈕。

**共通規則：** session ID 必須是標準 UUID 格式，否則拒絕接續。ID 來自磁碟上的檔案，只檢查字元集會讓 `--dangerously-skip-permissions` 這類值以參數身分送出；本機 214 個 session（含非互動與封存）全部符合。同一張卡片 1.5 秒內重複點擊只算一次。

### 6.1 Claude Code 擴充（`anthropic.claude-code`）

- 入口：`vscode.commands.executeCommand('claude-vscode.primaryEditor.open', id)`，在編輯器分頁開啟；該 session 已經開著時，Claude 擴充會直接切過去。
- 限制：Claude 擴充只到「目前視窗第一個資料夾」及「同一 repo 其他 worktree」對應的 `~/.claude/projects/<目錄>` 找紀錄；找不到時不報錯，而是開一個空白新對話。目錄名稱是 cwd 把英數字以外的字元都換成 `-`（本機 24 個專案目錄中 22 個完全一致，另 2 個只差磁碟代號大小寫，所以 Windows 上不分大小寫比對）。
- 判斷：先比對紀錄檔所在目錄名稱，與目前視窗第一個資料夾、以及 `git worktree list` 列出的每個 worktree 換算出的名稱；沒有開資料夾時，比對家目錄（與 Claude 擴充相同）。換算後超過 200 字元時，Claude 會截成前 200 字元再加 `-<雜湊>`；我們只比對前綴，不重算雜湊。
  - 符合：直接開啟。
  - 不符合：跳確認視窗，詢問是否用新視窗開啟該 session 的資料夾並在那裡接續。
  - 紀錄檔目錄與 session 的 cwd 換算結果也對不上時，開新視窗也找不到，改提示並提供「Resume in Terminal」。
- 跨視窗交接：
  - 確認後，把 `{ id, folder, createdAt }` 寫進 globalStorage 的 `pending-resume.json`，再用 `vscode.openFolder` 開新視窗。
  - 每個視窗啟動時（`onStartupFinished`）與取得焦點時，檢查這個檔案：資料夾相符且未超過 2 分鐘，就刪檔並開啟該 session；刪檔成功的視窗才動作，避免兩個視窗都開。過期或格式錯誤的檔案由任何視窗順手刪除。
  - 取得焦點也要檢查，是因為資料夾若已在別的視窗開著，VS Code 只會切到那個視窗，不會開新視窗。
- 為了交接，擴充改在 VS Code 啟動時就啟用，但索引與檔案監看要等側欄第一次顯示才開始，不增加未使用時的負擔。
- 依據：2026-10-28 讀 2.1.311 版的程式碼（未公開的 API），未實際執行；以 W1 的 F5 實測為準。

### 6.2 Codex 擴充（`openai.chatgpt`）

- 入口：`vscode.commands.executeCommand('vscode.openWith', openai-codex://route/local/<id>, 'chatgpt.conversationEditor', { preview: false })`，在編輯器分頁開啟。這個 URI 也是 Codex 擴充自己在 Chat Sessions 清單使用的資源位置。
- Codex 依 thread 自己記錄的 cwd 接續，不受目前視窗限制，所以任何視窗都能開。
- 不用 `vscode://openai.chatgpt/local/<id>` 這類 URI：從擴充開啟時，VS Code 會跳「是否允許開啟此 URI」確認視窗。
- 依據：2026-10-28 讀 26.51021.22027 版的程式碼（未公開的 API），未實際執行；以 W1 的 F5 實測為準。

### 6.3 終端（明確選擇或擴充不可用時）

- 對應的擴充未安裝或被停用時，跳警告並提供「Resume in Terminal」按鈕；不自動退回終端。
- 建立 VS Code 終端，`cwd` 設成該 session 的工作目錄，名稱為 `Claude: <標題>` 或 `Codex: <標題>`，最長 60 字元。
- 執行的指令：
  - Claude：`claude --resume <id>`
  - Codex：`codex resume <id>`
- `cwd` 不存在時，不開終端，改跳警告，並提供「複製指令」按鈕。
- 不傳任何權限相關參數，沿用使用者自己的 CLI 設定。

## 6.4 移到資源回收筒

- 入口：卡片的 `⋯` 選單與右鍵選單「Move to Recycle Bin…」，一次一筆；不在 Command Palette 出現。
- 移動範圍：
  - Claude：主檔 `<id>.jsonl`，以及同名資料夾 `<id>/`（subagents、tool-results）。
  - Codex：所有分頁檔，以及所有後代 subagent 的 rollout 檔（由索引層計算，存在 `ownedFiles`，不進快取）。
  - 不修改 `~/.codex/session_index.jsonl`；殘留的標題紀錄不影響任何功能。
- 保護：
  - 相關檔案中最新的修改時間在 10 分鐘內，就拒絕移動，避免動到仍在執行的 CLI session。
  - 移動前跳出確認視窗，顯示檔案數與總大小；按下確認後再檢查一次 10 分鐘規則，避免視窗開著時 session 又被寫入。
  - 統計檔案時用 `lstat`，符號連結與 Windows junction 只算本身，不往下走。
  - 只用 `vscode.workspace.fs.delete(…, { useTrash: true })`；資源回收筒不可用時直接報錯，不退回成永久刪除。
  - 成功後立即重新索引。
- 本機估算（2026-10-27，只計算不移動）：subagent 最多的 Codex session 為 97 個檔案、89.9 MB；subagent 最多的 Claude session 為 391 個檔案、337 MB。

## 7. 效能與穩定性

- **逐行串流讀取**：一行超過 `maxLineBytes`（預設 10 MiB）就跳過那一行，不讓整個 session 失敗（Orca 也是這樣處理）。
  - 被跳過的行保留開頭 4 KB 判斷紀錄類型。Codex 的頂層 `type` 一定在 `payload` 之前（本機抽樣 32,116 筆全部如此），所以 `event_msg`、`compacted`、非 `message` 的 `response_item` 這類解析器本來就不用的紀錄被跳過時不計數，不再出現誤報；看不出類型時照樣計數。
  - Claude 的 assistant 紀錄多半 `type` 在 `message` 之後（本機抽樣 4,207 筆中有 3,981 筆），開頭看不出類型，所以一律計數。
  - 輸出面板記下每個有跳過行的檔案路徑與行數，同一個檔案版本只記一次，避免自動刷新重複寫入。
- **只解析需要的行**：先用字串比對 `"type":"assistant"` 這類片段，命中才 `JSON.parse`，其餘直接跳過。
- **快取**：檔案的修改時間和大小都沒變，就直接用快取結果，不重讀。
- **並行上限**：預設同時讀 4 個檔案。
- **自動更新**：用 `FileSystemWatcher` 監看 `<claudeDir>/projects/**/*.jsonl`、`<codexDir>/sessions/**/rollout-*.jsonl` 與 `session_index.jsonl`。第一個事件後 10 秒刷新一次，期間的其他事件合併，計時不因新事件重設；因此持續寫入中的 session 也會定期更新，而不是等到完全靜止。自動刷新只重新解析有變動的檔案，也不重查先前查不到 repo 的目錄。
- **效能目標**：首次冷掃描本機約 900 個檔案在 10 秒內完成；之後有快取的熱啟動在 1 秒內完成。
- **M2 實測（2026-10-27，並行 4，本機真實資料）**：
  - 冷掃描 903 個檔案耗時 3.3 到 3.6 秒；熱掃描 40 到 45 毫秒，全部命中快取。冷掃描時作業系統的檔案快取可能已熱，未量測真正的磁碟冷讀。
  - 清單 153 個 session（Claude 52、Codex 101），與獨立 Python 參考腳本依 ID 去重後的數量一致。
  - 快取檔約 1 MB，存在擴充的 globalStorage（`index-v1.json`）。
- **快取作廢**：`SessionRecord` 或解析規則改變時調高 `CACHE_SCHEMA_VERSION`；快取也記錄解析選項（目前是 `maxLineBytes`），選項不同就整份作廢。多個 VS Code 視窗共用快取檔，寫入時各自使用含 pid 與亂數的暫存檔再改名。
- **Codex 標題**：在索引層套用，不存進快取，所以 thread 改名不需要重新解析。
- **M3 實測（2026-10-27，以一個有 worktree 的本機專案當 workspace）**：
  - Workspace 12 個（Claude 8、Codex 4），與獨立 Python 參考腳本一致；Project 也是 12 個，因為該 repo 目前沒有其他 worktree。
  - All 153 個、36 組。
  - 42 個不同的工作目錄查 git 耗時約 2 秒，其中 18 個是 repo。

## 8. 設定項

| 設定 | 預設 | 說明 |
|---|---|---|
| `agentSessionHistory.claudeDir` | `~/.claude` | Claude 資料目錄 |
| `agentSessionHistory.codexDir` | `~/.codex` | Codex 資料目錄 |
| `agentSessionHistory.includeNonInteractive` | `false` | 是否顯示 `codex exec`、`claude --print` 這類非互動 session（自動化流程可能產生大量這種紀錄） |
| `agentSessionHistory.includeCodexArchived` | `false` | 是否掃描 `~/.codex/archived_sessions` |
| `agentSessionHistory.maxLineBytes` | `10485760` | 單行大小上限，超過就跳過；最小 1 MiB，因為 Codex 的 `session_meta` 一行可達約 23 KB，太小會讓整個 session 消失 |

## 9. 里程碑與驗收

| 里程碑 | 內容 | 驗收條件 |
|---|---|---|
| M0 骨架 | 建立 package.json、tsconfig、esbuild 打包、`.vscode/launch.json`；側欄顯示空的 TreeView | 按 F5 開啟擴充開發主機，側欄看得到 Agent Session History |
| M1 解析器 | 完成 `claude.ts`、`codex.ts`、`lineReader.ts` 與去識別化 fixtures | `node --test` 全部通過；涵蓋超大行、損壞行、缺欄位、沒有標題 |
| M2 索引與 All | 完成 indexer、cache、All 範圍的樹 | session 總數與獨立 Python 參考腳本一致；記錄冷、熱掃描的實測時間 |
| M3 範圍 | 完成 Workspace、Project 過濾與 git common dir 查詢 | 開一個本機專案時，Workspace 只列該目錄的 session；Project 也包含它的 worktree；有測試覆蓋 cwd 已刪除的情況 |
| M4 動作 | 完成接續、開啟、複製、搜尋、刷新、自動更新 | 手動測試：Claude 與 Codex 各接續一次成功；新增 session 後清單會自動更新 |
| M4.1 移到資源回收筒 | 依第 6.4 節實作單筆移動 | 單元測試涵蓋路徑計算、大小統計與最新修改時間；使用者在 F5 實測移動一個舊 session 後，可從資源回收筒還原 |
| M5 打包 | 用 `vsce package` 產生 .vsix 並在本機安裝 | 在一般 VS Code 視窗安裝後，M2 到 M4 的驗收項目重跑通過 |
| W1 卡片列表 | 依第 5.1 節改成 Webview View：範圍分頁、搜尋、掃描狀態、排序、分組收合、卡片、`⋯` 快速選單、空狀態；接續改用第 6 節的擴充開啟與跨視窗交接；移除 TreeView | 畫面資料（範圍、搜尋、排序、分組、統計、空狀態）、webview 訊息驗證、Claude 目錄比對與交接檔都有單元測試；F5 實測三種範圍、搜尋、排序、收合；Claude 各接續一個本視窗與其他資料夾的 session，Codex 接續一個 session，三者都不開終端；淺色與深色主題都看得清楚 |
| W2 細節 | 卡片展開詳細資訊、原生右鍵選單、方向鍵移動、`Current workspace` 標籤、超大行誤報修正，版本 0.0.2 重新打包安裝 | 單元測試涵蓋超大行判斷、標籤與卡片欄位；headless 瀏覽器實測鍵盤、詳細資訊與右鍵選單屬性；F5 實測鍵盤操作與右鍵選單（含移到資源回收筒）；安裝 .vsix 後 W1 驗收項目重跑通過 |

每個里程碑完成時，都會附 build 或測試輸出，並派 fresh-context agent 驗收。

## 10. 風險

| 風險 | 對策 |
|---|---|
| Claude、Codex 擴充升版改了開啟 session 的指令或 URI | 兩者都不是公開 API：擴充不存在時提示改用終端；指令失敗記在輸出面板；第 6 節記錄所依據的版本，升版後若失效再重新查 |
| CLI 升版改了 jsonl 格式 | 解析器對未知類型一律跳過，欄位缺就留空；fixtures 標註來源 CLI 版本；輸出面板記錄解析警告 |
| 檔案很大或數量很多 | 串流讀取、先過濾再解析、快取、限制並行數 |
| Windows 路徑大小寫與斜線不一致 | 統一正規化，並寫單元測試 |
| 對話內容外洩 | 不連網、不送遙測；fixtures 必須去識別化，不得把真實對話提交進 repo |
| 讀到 CLI 正在寫入的檔案 | 只讀不鎖檔；最後一行不完整就忽略，等下次刷新 |

## 11. 決策紀錄

| 項目 | 決定（2026-10-27） |
|---|---|
| 擴充名稱與 ID | `agent-session-history` |
| 容器、view、設定的命名空間 | `agentSessionHistory`；`agentSessions` 已被 VS Code 1.142 內建的 Agent Sessions 保留，用了會導致容器不顯示 |
| 非互動 session | 預設隱藏，用 `agentSessionHistory.includeNonInteractive` 開啟 |
| 版本控制 | `ai_terminal` 已 `git init`；commit 前一律先取得使用者同意 |
| TypeScript 版本 | 5.9.3（相容性考量，暫不用 7.x） |
| Codex subagent 數 | 計算所有後代 rollout 檔（subagent 可以再開 subagent，depth 可達 2）；subagent 本身不列在清單上 |
| 測試資料 | 全部手寫合成，不從真實對話複製任何內容 |
| 打包與安裝（2026-10-27） | 用 `@vscode/vsce` 4.0.0（devDependency，固定版本）執行 `npm run package`，以 `--no-dependencies --allow-missing-repository --skip-license` 打包；`.vsix` 只含 `package.json`、`dist/extension.js`、`media/` 與 README，約 17 KB；以 `code --install-extension` 安裝到使用者的 VS Code。安裝、更新、移除步驟寫在 `README.md` |
| 刪除 session（2026-10-27） | 只做單筆「移到資源回收筒」，含相關檔案；10 分鐘內有更新的拒絕；不做永久刪除與批次刪除 |
| Activity Bar 圖示（2026-10-29） | 使用者在 VS Code 實際比較三個自繪方案後選擇「session 清單 + 星芒」；取代原本取自 Lucide 的歷史時鐘圖示，免除第三方授權聲明；版本 0.0.3 |
| 介面改為卡片式 Webview View（2026-10-28） | 依 Orca 截圖的版面，取代 TreeView，不兩套並存；分 W1、W2 兩步 |
| 超大行提示（2026-10-28） | 使用者問到提示的意義後，確認被跳過的 2 行是 Codex 的 `event_msg`（貼上的 15.2 MiB 截圖），解析器本來就不用；改成依紀錄類型判斷是否計數，並在輸出面板記下檔案 |
| 接續方式（2026-10-28） | 使用者要求改由 VS Code 的 Claude Code、Codex 擴充接續，不用終端；Claude 的 session 不屬於目前視窗時，經確認後開新視窗交接；終端只留作明確選項 |
