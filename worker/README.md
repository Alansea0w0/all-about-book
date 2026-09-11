# 共读甘棠取信员

这个本机进程把网页里的 `codex_requests` 信箱连接到固定的 Codex 共读任务，再把回复写回 `discussions`。

## Windows 首次配置

1. 在 Supabase 项目的 API Keys 页面复制 `service_role` key。不要把它放进网页、GitHub 或聊天。
2. 在 PowerShell 中运行 `./worker/configure-windows.ps1`，按提示粘贴一次。
3. 运行 `./worker/start-windows.ps1` 并保持这个窗口开启。

密钥保存在 `%LOCALAPPDATA%\AllAboutBookGantang`，由当前 Windows 账户的 DPAPI 加密。固定 Codex 任务 ID 和工作路径保存在同目录的普通配置文件中。每次启动会优先使用 Codex 桌面版当前随附的原生 `codex.exe`，再回退到旧配置或系统路径，避免桌面版升级后误用不兼容的旧版本。

取信员只使用只读 Codex 沙箱和 `never` 批准策略。若一次回复需要人工批准，它会把请求标为 `needs_attention`，不会自行放行。
