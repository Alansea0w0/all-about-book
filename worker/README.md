# 共读甘棠事件取信员

这个本机进程通过 Supabase Realtime 等待 `codex_requests` 的新增事件，只在小安写信时唤醒专用的 Codex 共读任务，并把最终回复写回 `discussions`。

## Windows 首次配置

1. 在 Supabase 项目的 API Keys 页面复制 `service_role` key。不要把它放进网页、GitHub 或聊天。
2. 在 PowerShell 中运行 `./worker/configure-windows.ps1`，按提示粘贴一次。
3. 运行 `./worker/start-windows.ps1` 并保持“Gantang Realtime Mail Carrier”窗口开启。

密钥保存在 `%LOCALAPPDATA%\AllAboutBookGantang`，由当前 Windows 账户的 DPAPI 加密。首次启动会在本机 `ws://127.0.0.1:8766` 上创建一个专用 Codex app-server 和一个专用共读任务；旧桌面任务 ID 不会复用。

启动脚本还会打开一个用于观察的 Codex 窗口，它和取信员连接同一个 app-server，因此能显示共读任务的轮次。新任务会先等待第一封真实信完成，再自动接入观察窗口；不会为初始化额外调用一次模型。取信员发起的每个轮次仍强制使用只读沙箱和 `never` 批准策略。若只需要网页回复，可运行 `./worker/start-windows.ps1 -NoObserver`。

取信员不轮询信箱：Realtime 订阅完成后只补查一次启动期间积压的 `queued` 信件，之后仅响应新 `INSERT`。订阅、app-server 或回复轮次任一失败时都会停止，不会无限重连或自动重复投递。按 `Ctrl+C` 停止取信员时，其专用 app-server 也会一并退出。

每封信开始前，取信员会通过 app-server 固定调用 Ombre Brain 的 `breath_search`，只读取得最多三条相关记忆，再与阅读资料一起交给 Codex。读取失败时该信直接失败，不生成假装衔接记忆的回复；Codex 轮次本身继续使用只读沙箱和 `never` 批准策略，不开放其他临时工具权限。
