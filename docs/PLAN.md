# Agent Session History：VS Code 擴充規劃

狀態：已確認，實作中（2026-10-27）

## 1. 目標與範圍

在 VS Code 側欄用 TreeView 列出本機 Claude Code 與 Codex 的 session 歷史，可切換 Workspace／Project／All 三種範圍，點選後在正確目錄接續該 session。

**做：**
- 讀取 `~/.claude/projects` 與 `~/.codex/sessions` 的 jsonl，建立索引
- TreeView：依專案分組，顯示標題、agent、訊息數、模型、分支、相對時間
- 三種範圍切換、關鍵字過濾、手動與自動刷新
- 右鍵動作：在終端接續、開啟原始紀錄、複製 session ID、在檔案總管顯示

**不做（第一版）：**
- 卡片式 webview UI
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
- 空清單：完全沒有 session 時顯示設定提示（`agentSessionHistory.indexed`、`agentSessionHistory.hasSessions` 兩個 context key 控制）；只是目前範圍沒有 session 時，改在清單上方提示切換範圍。
- 重新索引時，等 git 查詢完成才換上新的 session 清單，避免中途切換範圍看到分組不完整的結果。

## 4. 架構

```
src/
  extension.ts          進入點：註冊 view、指令、設定監聽
  model.ts              SessionRecord 型別
  sources/
    claude.ts           解析 Claude jsonl，逐行串流讀取
    codex.ts            解析 Codex rollout jsonl 與 session_index
    lineReader.ts       共用：逐行讀取、跳過超大行、容錯解析
  index/
    indexer.ts          掃描兩個目錄、限制並行數、增量更新
    cache.ts            以「路徑 + 修改時間 + 大小」做快取，存在 globalStorage
  scope/
    paths.ts            路徑正規化
    gitRoot.ts          查詢 git common dir，結果依 cwd 快取
    filter.ts           三種範圍的過濾與分組
  view/
    treeProvider.ts     TreeDataProvider：專案節點 → session 節點
    format.ts           相對時間、截斷、tooltip Markdown
  commands.ts           接續、開啟、複製、刷新、切換範圍、搜尋
test/
  fixtures/             去識別化的 Claude 與 Codex 範例 jsonl
  *.test.ts             解析器與過濾邏輯的單元測試
```

**SessionRecord 欄位：** `id`、`agent`（claude 或 codex）、`title`、`lastReply`（截斷到 200 字）、`messageCount`、`subagentCount`、`model`、`gitBranch`、`cwd`、`startedAt`、`updatedAt`、`filePath`、`interactive`。

**技術選擇：**
- TypeScript，用 esbuild 打包成單一檔案，執行期零依賴
- 單元測試用 Node 內建的 `node:test`，解析器和過濾邏輯不依賴 vscode 模組，可以獨立測試
- `engines.vscode` 設 `^1.100.0`（本機是 1.142）
- 本機已有 Node v24.14.1 與 npm 11

## 5. 介面

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

- 建立 VS Code 終端，`cwd` 設成該 session 的工作目錄，名稱為 `Claude: <標題>` 或 `Codex: <標題>`，最長 60 字元。
- session ID 必須是標準 UUID 格式，否則拒絕接續。ID 來自磁碟上的檔案，只檢查字元集會讓 `--dangerously-skip-permissions` 這類值以 CLI 參數身分送出；本機 214 個 session（含非互動與封存）全部符合。
- 原始紀錄檔已被刪除時，開啟前先提示，不丟出 VS Code 的通用錯誤。
- 執行的指令：
  - Claude：`claude --resume <id>`
  - Codex：`codex resume <id>`
- `cwd` 不存在時，不開終端，改跳警告，並提供「複製指令」按鈕。
- 不傳任何權限相關參數，沿用使用者自己的 CLI 設定。

## 6.1 移到資源回收筒

- 入口：session 節點的右鍵選單「Move to Recycle Bin…」，一次一筆；不提供 ▶ 這類行內按鈕，也不在 Command Palette 出現。
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

- **逐行串流讀取**：一行超過 `maxLineBytes`（預設 10 MiB）就跳過那一行並記錄在輸出面板，不讓整個 session 失敗（Orca 也是這樣處理）。
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
- **M3 實測（2026-10-27，以 `stock_analyze_panel` 當 workspace）**：
  - Workspace 12 個（Claude 8、Codex 4），與獨立 Python 參考腳本一致；Project 也是 12 個，因為該 repo 目前沒有其他 worktree。
  - All 153 個、36 組。
  - 42 個不同的工作目錄查 git 耗時約 2 秒，其中 18 個是 repo。

## 8. 設定項

| 設定 | 預設 | 說明 |
|---|---|---|
| `agentSessionHistory.claudeDir` | `~/.claude` | Claude 資料目錄 |
| `agentSessionHistory.codexDir` | `~/.codex` | Codex 資料目錄 |
| `agentSessionHistory.includeNonInteractive` | `false` | 是否顯示 `codex exec`、`claude --print` 這類非互動 session（你的 review-debate-orchestrator 會產生大量這種紀錄） |
| `agentSessionHistory.includeCodexArchived` | `false` | 是否掃描 `~/.codex/archived_sessions` |
| `agentSessionHistory.maxLineBytes` | `10485760` | 單行大小上限，超過就跳過 |

## 9. 里程碑與驗收

| 里程碑 | 內容 | 驗收條件 |
|---|---|---|
| M0 骨架 | 建立 package.json、tsconfig、esbuild 打包、`.vscode/launch.json`；側欄顯示空的 TreeView | 按 F5 開啟擴充開發主機，側欄看得到 Agent Session History |
| M1 解析器 | 完成 `claude.ts`、`codex.ts`、`lineReader.ts` 與去識別化 fixtures | `node --test` 全部通過；涵蓋超大行、損壞行、缺欄位、沒有標題 |
| M2 索引與 All | 完成 indexer、cache、All 範圍的樹 | session 總數與獨立 Python 參考腳本一致；記錄冷、熱掃描的實測時間 |
| M3 範圍 | 完成 Workspace、Project 過濾與 git common dir 查詢 | 開 `stock_analyze_panel` 時，Workspace 只列該目錄的 session；Project 也包含它的 worktree；有測試覆蓋 cwd 已刪除的情況 |
| M4 動作 | 完成接續、開啟、複製、搜尋、刷新、自動更新 | 手動測試：Claude 與 Codex 各接續一次成功；新增 session 後清單會自動更新 |
| M4.1 移到資源回收筒 | 依第 6.1 節實作單筆移動 | 單元測試涵蓋路徑計算、大小統計與最新修改時間；使用者在 F5 實測移動一個舊 session 後，可從資源回收筒還原 |
| M5 打包 | 用 `vsce package` 產生 .vsix 並在本機安裝 | 在一般 VS Code 視窗安裝後，M2 到 M4 的驗收項目重跑通過 |

每個里程碑完成時，都會附 build 或測試輸出，並派 fresh-context agent 驗收。

## 10. 風險

| 風險 | 對策 |
|---|---|
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
