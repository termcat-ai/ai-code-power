# AI Code Power

TermCat 的 **Claude + Codex 统一调用查看面板**插件。

当前终端运行 `claude` 或 `codex` 时，右侧面板自动注入并显示：

- **统一会话历史**：按 prompt/task 倒序列出当前 session 的每次对话，展示用户输入与模型回复
- **调用详情展开**：每条 prompt 下展开本轮所有 API round-trip 的 tool call（内置工具 / Skill / MCP / Sub-agent / Shell / Patch / Search）
- **Token 统计**：分层显示 freshInput / cacheRead / output / reasoning（o3/o4）token 数量
- **模式切换**：Claude 的 PermissionMode（`default` / `acceptEdits` / `plan` / `bypassPermissions`）；Codex 的 approvalMode（`suggest` / `auto-edit` / `full-auto`）
- **代理抓包（可选）**：启用本地代理后查看完整 system prompt 及原始 SSE 请求/响应
- **双 CLI 感知**：同一 tab 内若 `claude` 与 `codex` 同时存在，以启动最晚者为准；切 tab 面板内容跟随激活终端

## 双 CLI 适配（Adapter 模式）

插件通过 `IAdapter` 接口屏蔽两种 CLI 的差异，上层完全不感知具体类型：

| 对比项 | ClaudeAdapter | CodexAdapter |
|--------|---------------|--------------|
| 数据来源 | `~/.claude/projects/<hash>/<uuid>.jsonl` | `~/.codex/sessions/<y>/<m>/<d>/<id>.jsonl` |
| JSONL 结构 | `parentUuid` DAG，提取主分支 | 线性 `task_started` → `assistant` → `token_count` |
| Token 来源 | `message.usage` 内联 | 独立 `token_count` 事件 |
| 模式来源 | JSONL `permissionMode` 字段 | `~/.codex/config.json` 的 `approvalMode` |
| SSE 格式 | Anthropic `/v1/messages` | OpenAI `/v1/chat/completions` |

检测由 `Detector` 每 5 秒轮询进程树完成，按进程名 / cmdline 正则区分 `claude` 与 `codex`。

## 代理抓包

启用代理后，插件在本地启动 HTTP 代理，将 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` 指向 `http://127.0.0.1:<port>`：

- 命中 `captureEndpointPath` 的请求体存入 `CaptureStore`（LRU 200 条），其余直接透传
- SSE 响应一边 Buffer 记录、一边零延迟 pipe 到客户端
- 同一 `ProxyServer` 通过可插拔的 `SseStrategy` 兼容 Anthropic 与 OpenAI 两种 SSE 格式
- API Key 自动脱敏；session 结束后缓存释放

**生效方式**：
- Claude — 写入 `active.env`，下次 `launch` 时 `source` 后生效
- Codex — 写入 `~/.codex/proxy.env`，需手动 `source` 或重启 codex

## 设计原则

- **Adapter 模式解耦**：`ClaudeAdapter` / `CodexAdapter` 各自实现 `IAdapter`，UI 与入口层不感知 CLI 类型
- **策略模式处理 SSE 差异**：`SseStrategy` 屏蔽 Anthropic 与 OpenAI SSE 格式差异
- **只读本地文件**：数据来自 JSONL 文件、CLI 配置文件、SQLite（Codex），不装 hook
- **默认"填入不回车"**：PTY 注入默认停在输入行，仅 `launch` 操作会自动回车
- **面板跟随激活 tab**：多 tab 并行运行不同 CLI 互不干扰

## 开发

```bash
npm install
npm run build          # esbuild → dist/extension.js
npm run pack           # 打出 ai-code-power.tgz 可安装包
```

esbuild 要点：`platform: node` / `format: cjs`；`electron`、`better-sqlite3` 为外部原生模块；`chokidar`、`pidtree`、`uuid` 打包进 bundle。

## 安装到 TermCat

把打好的 tgz 放到 TermCat 用户数据目录的 `plugins/ai-code-power/` 下即可（或复制整个 `dist/` 目录）。

## 存储位置

```
~/.termcat/plugins/ai_code_power/
├── presets.json      # Claude preset CRUD
└── active.env        # Claude env（原子 tmp→rename 写入，含清理 prologue）

~/.codex/
├── config.json       # Codex 模型 / approvalMode
├── .env              # OPENAI_API_KEY
└── proxy.env         # export OPENAI_BASE_URL=...
```

## 相关文档

- 程序架构：`claude_refs/ARCHITECTURE.md`
- 技术方案设计：`docs/tech-design/20260621-AiCodePower.md`
- 基础插件参考：`termcat_client_plugin/claude_code_power/`
- 宿主架构：`termcat_client/claude_refs/ARCHITECTURE.md`
