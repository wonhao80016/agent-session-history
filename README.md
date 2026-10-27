# Agent Session History

在 VS Code 側欄用卡片瀏覽本機 Claude Code 與 Codex 的 session 歷史，可切換 Workspace／Project／All 範圍、搜尋、排序，點卡片即可接續 session。設計與規則見原始碼 repo 中的 `docs/PLAN.md`。

## 接續方式

- Claude session 用 Claude Code 擴充（`anthropic.claude-code`）開啟。Claude Code 只能接續屬於目前視窗資料夾（或同一 repo 其他 worktree）的 session；其他資料夾的 session 會先詢問，再開新視窗並在那裡接續。
- Codex session 用 Codex 擴充（`openai.chatgpt`）開啟，任何視窗都可以。
- 卡片的 `⋯` 選單與右鍵選單另有「Resume in Terminal」，改用 `claude --resume` 或 `codex resume` 在終端接續。

## 操作

- 卡片標題列的 ⌄ 展開第一句提問、工作目錄、session ID 與時間；`⋯` 或右鍵開啟動作選單。
- 鍵盤：上下鍵移動，左右鍵收合／展開群組與詳細資訊，Enter 接續，Shift+F10 或選單鍵開動作選單。

## 安裝

需要 Node.js 22 以上與 VS Code 1.100 以上。

```powershell
npm install
npm run package
code --install-extension .\agent-session-history-0.0.2.vsix
```

安裝後，已開啟的 VS Code 視窗要執行一次 **Developer: Reload Window**，才會出現在 Activity Bar。

## 更新

1. 調高 `package.json` 的 `version`。
2. 重新執行 `npm run package`。
3. 用 `code --install-extension .\agent-session-history-<新版本>.vsix --force` 安裝。
4. 執行 **Developer: Reload Window**。

## 移除

```powershell
code --uninstall-extension local.agent-session-history
```

移除後，擴充的索引快取仍會留在 VS Code 的 globalStorage（`%APPDATA%\Code\User\globalStorage\local.agent-session-history`），可以手動刪除。擴充從不修改 `~/.claude`、`~/.codex` 的檔案內容；只有「Move to Recycle Bin…」會把檔案移到資源回收筒。

## 開發

| 指令 | 用途 |
|---|---|
| `npm run check` | 型別檢查並打包到 `dist/` |
| `npm test` | 編譯並執行單元測試 |
| `npm run package` | 產生 `.vsix` |
| F5 | 在擴充開發主機中執行 |

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `agentSessionHistory.claudeDir` | `~/.claude` | Claude Code 資料目錄 |
| `agentSessionHistory.codexDir` | `~/.codex` | Codex 資料目錄 |
| `agentSessionHistory.includeNonInteractive` | `false` | 是否顯示 `codex exec`、`claude --print` 等非互動 session |
| `agentSessionHistory.includeCodexArchived` | `false` | 是否掃描 Codex 的 `archived_sessions/` |
| `agentSessionHistory.maxLineBytes` | `10485760` | 單行超過此大小就跳過（最小 1 MiB） |
