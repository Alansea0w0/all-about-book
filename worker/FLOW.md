# 共读小屋本机回信流程

## 边界

- 网页可在任意设备使用，只负责登录、保存小安的消息和显示回复。
- Supabase 是信箱和共读资料库，不运行 Codex，也不保存 Codex 登录凭据。
- 家中电脑上的事件取信员只在新信到达时唤醒专用 Codex 共读任务。
- OpenRouter 是网页中的独立备用通道，不冒充固定的 Codex 共读任务。

## 一封信的完整路径

1. 网页先把小安的新内容写入 `discussions`，角色为 `me`。
2. 网页向 `codex_requests` 新增一条 `queued` 请求，并保存书籍、对话、消息和是否附带上下文。
3. Supabase Realtime 只推送一条 `INSERT` 事件；取信员不信任事件正文，只把它当作“有新信”的铃声。
4. 取信员查询最早的可用请求，用条件更新把它从 `queued` 原子领取为 `processing`。多个实例同时看见时也只有一个能领取成功。
5. 取信员按请求中的 `user_id`、`book_id` 和 `conversation_id` 读取书目、摘录、问题、进度和最近讨论。
6. 取信员先通过本机 `ws://127.0.0.1:8766` 直接调用 Ombre Brain 的 `breath_search`，只读取最多三条相关记忆；读取失败则停止本封信，不生成假装衔接记忆的回复。
7. 取信员把只读检索结果与当前阅读资料一起交给自己拥有的 Codex app-server 开始一轮；模型无需申请临时 MCP 权限，该专用任务也不与桌面 Codex 的任务共用 writer。
8. 第一封真实信完成后，同一 app-server 上的 Codex 观察窗口再接入并显示轮次；取信员从 `item/completed` 和 `turn/completed` 取得最终回复。
9. 成功时，取信员先向 `discussions` 新增角色为 `syzygy` 的回复，再把原请求标为 `completed` 并记录回复 ID。
10. 失败时，请求被标为 `failed` 或 `needs_attention`，不自动重试。终端只记录脱敏后的短错误。
11. Realtime 订阅建立后，取信员只补查一次启动时积压的 `queued` 信件；之后没有定时轮询。

## 最小数据库权限

`service_role` 对 `books`、`excerpts`、`book_questions`、`check_ins` 和 `discussions` 只有读取权限，对 `discussions` 另有新增权限。它对这些表没有更新或删除权限，也没有 `conversations` 权限。`codex_requests` 是取信员自己的队列表，需领取和完成请求，因此保留完整权限。

`public.codex_requests` 是本流程唯一加入 `supabase_realtime` publication 的表。本流程不修改既有 RLS、登录设置或认证方式。

## 进程与故障边界

- `start-windows.ps1` 是唯一日常入口：它启动隐藏的专用 app-server、当前终端中的事件取信员；若是尚无轮次的新任务，可见的 Codex 观察窗口会等待第一封真实信完成后再接入。
- app-server 只监听回环地址，不接受局域网或公网连接。
- 同一时间只运行一套取信员。端口已被占用时第二套会拒绝启动。
- Realtime、app-server 或 Codex 轮次失败即停；没有无限重连、定时重试或旧信自动重投。
- 按 `Ctrl+C` 停止取信员会一并停止它启动的 app-server；观察窗口随后失去连接，可直接关闭。

## 验收条件

使用网页新建一封测试信，不复用任何旧失败请求。验收必须同时满足：

- 终端在静默等待期间没有周期性 mailbox 查询。
- 新请求只领取一次，`attempts` 只增加一次。
- 专用共读任务新增且只新增一轮。
- 该信在生成回复前能实际调用 Ombre Brain 做只读记忆检索。
- `discussions` 只新增一条甘棠回复。
- 请求最终为 `completed`，其 `response_message_id` 与新增回复 ID 一致。
