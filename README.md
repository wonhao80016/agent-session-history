# Agent Session History

在 VS Code 側欄瀏覽本機 Claude Code 與 Codex 的 session 歷史，可切換 Workspace／Project／All 範圍，並直接接續 session。設計與規則見原始碼 repo 中的 `docs/PLAN.md`。

## 安裝

需要 Node.js 22 以上與 VS Code 1.100 以上。

```powershell
npm install
npm run package
code --install-extension .\agent-session-history-0.0.1.vsix
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
| `agentSessionHistory.maxLineBytes` | `10485760` | 單行超過此大小就跳過 |
