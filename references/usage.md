# 启动与操作

仅需 Python 3 标准库。Cloudflare 需要另有 `cloudflared`。下方路径变量属于新房间；已有房间先核实其状态，不能用新目录覆盖或冒充旧讨论。

```bash
umask 077
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/agent-debug-room"
ROOM_STATE="$HOME/.local/state/agent-debug-room/my-debug-session"
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" serve --port 58401
```

`serve` 绑定 `127.0.0.1`，前台运行并保存实际地址至 `room-url.txt`。可用 `--port 0` 分配空闲端口。在受支持的长时 exec session 或独立终端保持其运行；本 skill 不安装 systemd，也不管理任意 PID。停止时结束自己创建的进程/session。

其余命令在另一个终端运行，或由当前助手的工具执行；每次 shell 都重新设置上述变量。先把背景和消息正文写成 UTF-8 文件，避免把外部正文拼入 shell：

```bash
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" configure --topic '本次跨 Agent 联调' --context-file /absolute/path/context.txt --max-turns 8
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" state
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" start
REPLY_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" reply --file /absolute/path/reply.txt --id "$REPLY_ID"
```

`state` 默认用 `server_agent_token`，可选 `--role owner|viewer|server|client`、`--after <最大消息ID>`。`reply` 默认 `server`；`--role client` 仅供明确标记的本地 fixture 测试，实际对方用邀请凭证从它自己的原会话发送。fixture 不能作为对方实际接入证据。

同一条回复超时重试时保留同一个 `REPLY_ID` 和完全相同正文；新回复先生成新 ID。不同角色或正文复用 ID 返回 `409`。主持人备注不耗 Agent 发言次数，也不改变下一位 Agent：

```bash
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" note --file /absolute/path/human-note.txt --id human-unique-id
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" pause
```

`max_turns` 是 Agent **发言次数**，不是对话对数，范围 1–20。达到上限自动暂停；`start` 在耗尽后重置当次计数，继续原来的下一位发言者，保留全部记录。服务重启也保留记录、凭证和轮次，但总是先暂停。

## 跨机器旁观与邀请

另一个长时 exec session / 终端运行：

```bash
python3 "$SKILL_DIR/scripts/run_tunnel.py" --state-dir "$ROOM_STATE"
```

默认先找 `~/.local/bin/cloudflared`，再查 PATH；可显式 `--cloudflared /absolute/path/cloudflared`。默认 `http2`。`--room-url http://127.0.0.1:58401` 可覆盖保存的源地址；网络需要额外 cloudflared 参数时放在末尾 `--` 后，按该机器实际路由诊断选择，不复制其他机器的 IP/edge 设置。

wrapper 前台启动 tunnel 并将最新观察到的 Quick Tunnel 地址保存为私密 `tunnel-url.txt`。该文件只表示最后观察到的地址，不代表当前在线；退出后仍需自行确认进程和公网 `/healthz`。重新启动 Quick Tunnel 的 URL 通常变化，须重新生成链接和邀请。本机、HTTP 服务与 tunnel 都必须保持在线。若需稳定地址，使用已有授权的 named tunnel；本 skill 不创建账户或改 DNS。

```bash
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" link
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" link --role owner
python3 "$SKILL_DIR/scripts/room.py" --state-dir "$ROOM_STATE" invite
```

`link` 默认 viewer；`link` 与 `invite` 优先使用 `tunnel-url.txt`，没有则使用 loopback。显式 `--room-url https://your-current-room.example`（放在子命令前）可覆盖。向跨机器用户交付前，验证所用公网地址当前可达。浏览器把凭证放在 URL fragment，随后移除地址栏 fragment；令牌仍属于 bearer 凭证，只交给对应人。

`invite` 只输出 client 凭证及 curl 接入步骤，不含 owner/server/viewer 凭证。对方约每 5 秒读取一次状态；无需安装这个 skill，也不能把其工具能力不存在说成已加入。若保存邀请输出，先 `umask 077`，放在私密目录，避免写入仓库或公共日志。

## 验证

```bash
python3 "$SKILL_DIR/assets/bridge/test_server.py"
python3 "$SKILL_DIR/scripts/test_helpers.py"
```

测试使用隔离临时目录、真实本地 HTTP，notifier/tunnel 的外部 CLI 使用明确的本地 fixtures；不调用模型、不通知真实会话、不产生真实 Agent 接入证据。
