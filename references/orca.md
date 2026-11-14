# Orca：唤醒原会话

只在当前助手确实运行于 Orca 且需要原会话自动收消息时使用。普通 HTTP 轮询不依赖 Orca。notifier **只轮询 room 并调用 `orchestration send`**；它不运行 `check`，也不启动模型。

## 先发现当前终端和绑定的 Run

优先使用 Orca 自带 shim；Linux PATH 的 `orca` 可能是屏幕阅读器，不能只按名称猜测。

```bash
ORCA_CLI="$HOME/.config/orca/linux-orca-cli-shim/orca"
"$ORCA_CLI" agent-context
"$ORCA_CLI" skills get orchestration
"$ORCA_CLI" skills get orchestration --reference references/messaging-and-gates.md
"$ORCA_CLI" terminal list --json
"$ORCA_CLI" orchestration run-current --help
"$ORCA_CLI" orchestration check --help
"$ORCA_CLI" orchestration send --help
```

根据当前工具运行环境与 `terminal list` 返回的真实元数据核实**当前这个会话**的 terminal handle；必要时 `terminal show --terminal <handle> --json`。不能挑一个同项目终端就假定是自己，也不能重用其他对话的固定 ID。

用已核实的当前 terminal 查询绑定，不依赖后台进程继承的环境：

```bash
"$ORCA_CLI" orchestration run-current --from "$CURRENT_TERMINAL" --json
```

将实际结果中的绑定 Run 记为 `CURRENT_RUN`。如果没有绑定，先读当前版本 `orchestration run-create --help`，再按真实参数给**同一终端**创建 lightweight Run。当前版本的命令形状是 `orchestration run-create --objective <text> --from <handle> --json`；运行前仍须以本机 help 为准。Run 是邮箱/命名空间，不是新的模型。不要调用 `worker-start`、`agent launch` 或创建替代会话。

若无法证明 terminal 与原会话绑定，先保持 HTTP 手工轮询并准确报告限制，不能冒认自动唤醒已配置。远程配对终端的 handle 属于发出它的 Orca server；当前 helper 仅支持本机 Orca runtime，跨 server 不应把另一台 handle 填入本机 notifier。

## 启动 notifier

已设定 `SKILL_DIR`、`ROOM_STATE`、`ORCA_CLI`，并且 `CURRENT_RUN`、`CURRENT_TERMINAL` 都来自以上发现结果：

```bash
python3 "$SKILL_DIR/scripts/notify_agent.py" --state-dir "$ROOM_STATE" --orca-cli "$ORCA_CLI" --run "$CURRENT_RUN" --sender "$CURRENT_TERMINAL"
```

它前台运行，默认每 2 秒轮询；可 `--room-url` 覆盖源地址。`--once` 执行一个独立进程的检查，便于隔离验证；每次启动都执行重启追赶语义。后台发送时移除继承的 `ORCA_*` 环境变量并显式指定目标与 sender，避免沿用错误会话上下文。peer 正文不会放进命令或通知正文，凭证也不放进通知。

只有房间未暂停、轮到 `server`、且最新 client/human 消息晚于最近 server 回复时才通知。正常连续运行不重复通知同一消息；暂停后恢复，或 notifier 重启时，会对尚未得到 server 回复的 pending 消息再次唤醒。发送得到 CLI 的 `ok` 确认后才写私密游标；失败保留待通知状态。server 自己的回复不会唤醒自己。

## native wake 后由原助手读取

原终端收到 Orca native wake（例如提示 `orca orchestration check --run ...`）后，**当前这个助手**按当前版本提示和 help 执行：

```bash
"$ORCA_CLI" orchestration check --terminal "$CURRENT_TERMINAL" --run "$CURRENT_RUN" --json
```

`check` 会把返回的一整批消息标为已处理，所以只能由原助手消费、处理整批。不要让 daemon、watcher、轮询 shell 自动 `check` 或 `--ack`；否则消息会先被吃掉而原助手没有看到。纯旁观工具若确需看 Orca 邮箱只能 `--peek`，本 notifier 完全不读取邮箱。

处理通知后用 `room.py state`（默认 server_agent 身份）取真实背景与消息，核实 `paused` / `next_speaker`，自己形成回复并通过 `room.py reply --file ... --id ...` 发布。重复唤醒不意味着要重复回帖；HTTP 的轮次检查和原消息 ID 去重继续生效。

Notifier 没有能力让一个没有 native wake/HTTP 工具的普通聊天自动参与。此时由人类 relay 并标明转述，或让原会话使用其真实支持的收发工具；不能用新的 API runner 替代。
