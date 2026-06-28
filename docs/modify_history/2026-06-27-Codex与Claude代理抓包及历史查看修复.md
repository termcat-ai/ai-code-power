# 2026-06-27 修改摘要：修复 Codex 历史查看 + Codex/Claude 代理抓包全链路

## 一句话概述
修好了 `ai-code-power` 插件里 Codex 历史查看的多处数据丢失（工具调用/改文件输出/token），并打通了 Codex 与 Claude 的代理抓包链路（502 → 上游寻址 → 上行解压 → 下行解压 → 启动注入不泄漏），另让 Codex 不开代理也能看 system prompt。

## 背景 / 目标
`ai-code-power` 是检测 claude/codex 进程后在右侧面板展示会话历史、调用详情、token、原始请求的插件，处于在建状态。本次会话依次解决用户反馈的几类问题：

1. Codex 的历史查看：工具调用、改文件、上下行 token、缓存命中、原始记录都显示不全/缺失。
2. 开代理跑 Codex 报 502（`net::ERR_INVALID_ARGUMENT`），无法查看原始记录。
3. 开代理跑 Claude：先是抓不到原始提示词，再是 `ZlibError`，关代理后又 `ConnectionRefused`。

目标是让两个 CLI 的「历史查看 + 代理抓包」都真正可用，而不是绕过问题。

## 改动清单
> 注意：本会话未提交（用户手动提交）。下列文件在会话开始前就带有在建改动，`git diff --stat` 的行数把**会话前的在建工作**和**本次逻辑改动**混在一起；以下按本次会话的逻辑改动归类。`jsonl-watcher.ts`、`process-watcher.ts` 本次**未**改动。

**Codex 历史查看修复**
- `src/adapters/codex/jsonl-parser.ts`：新增 `web_search_call` → 搜索类工具调用（之前整类丢弃）；新增 `session_meta` → 取 `base_instructions.text` 作为 system prompt；新增 `turn_context` → 取 `model` / `approval_policy`；`function_call_output`/`custom_tool_call_output` 输出改用 `asOutputString`（容错对象包裹形式）；`CodexEvent` 的 `meta` 事件扩展 `model`/`approvalMode`/`systemPrompt`。
- `src/adapters/codex/session-index.ts`：工具结果配对从「pending 数组下标」改为 **turn 级 `callId → 工具对象引用` map**（跨 `token_count` flush 存活）；`flushPending` 在 token 非零时也保留（不丢纯推理轮 token）；消费 `meta` 事件填充 `lastModel`/`approvalMode`/`systemPrompt`，新增 `getSystemPrompt()`。
- `src/shared/ui/msg-block-adapter.ts`：纯工具轮（无 assistant 文本）也输出带 `tokenUsage` 的块，让上下行 token / 缓存命中在调用详情可见。
- `src/extension.ts`：移除 `openRawTurnModal` 里每次弹出的 `[DBG]` 通知；新增头部 📄 `viewSystemPrompt` 按钮 + 处理逻辑（Codex 从 JSONL 读，Claude 无则提示需代理）。

**代理抓包（Codex + Claude 通用）**
- `src/shared/proxy/proxy-server.ts`：转发给 `electron.net` 前剥掉 `content-length`（Chromium 自管，否则 `ERR_INVALID_ARGUMENT`）；响应回传时剥掉 `content-encoding`/`content-length`（Chromium 已透明解压，否则客户端二次解压 `ZlibError`）；抓包展示前按 `content-encoding` 解压请求体（zstd 用打包的 `fzstd`，gzip/br/deflate 用内置 `zlib`），新增 `decodeBodyForDisplay`；加目标 URL + status + forward error 诊断日志。
- `src/adapters/codex/sse-strategy.ts`：`captureEndpointPath` 由 `/v1/responses` 改为 `/responses`（配合启动不带 /v1）。
- `src/adapters/codex/index.ts`：`launch` 改为接收实时 `proxyUrl`（去掉 `/v1`，让代理收到 `/responses`）；新增 `resolveCodexUpstream()` 读 `~/.codex/auth.json` 判断 ChatGPT 登录 → `chatgpt.com/backend-api/codex`、API Key → `api.openai.com/v1`，`getUpstreamBaseUrl()` 暴露；`writeProxyEnv` 改为 no-op，`restoreEnv` 仅清理旧 `proxy.env`；删除已无用的 `readProxyUrl`；`getSystemPrompt()` 返回 index 的值。
- `src/adapters/claude/index.ts`：`launch` 接收实时 `proxyUrl`，用**进程作用域前缀** `ANTHROPIC_BASE_URL=... claude`（不导出到 shell）；`writeProxyEnv` 不再把代理地址持久化进 `active.env`（写干净 env）。
- `src/adapters/types.ts`：`IAdapter.launch` 增加可选 `proxyUrl?: string | null`。
- `src/extension.ts`：代理上游解析对 Codex 调 `getUpstreamBaseUrl()`；`launchCli` 按 `store.proxyEnabled && proxyServer.getPort()` 实时计算 `proxyUrl` 并下发；Claude 启动同样用前缀作用域注入；删除 `writeCodexProxyEnv` 死代码与 toggleProxy 里的预写分支；清理因此变孤儿的 `fs`/`os` import。
- `package.json` / `package-lock.json`：新增依赖 `fzstd`（纯 JS zstd 解码，零原生依赖）。

本次会话**无 commit**（用户手动提交）；会话起点锚定在 `775fe10 ai-code-power初步实现` 之后的未提交改动。

## 关键决策与理由
- **工具结果配对（核心 bug）**：根因是 Codex 常见顺序 `function_call → token_count → function_call_output`，`token_count` 触发 flush 清空了 pending 数组，下标失配导致输出全丢。**否决**「继续用下标 + flush 时不清 map」（仍受 flush 重置影响）；**选**「`callId → 工具对象引用` map，跨 flush 存活，结果回来直接 mutate 同一对象」。3 月会话 72 个输出由全丢变为全 `[out✓]`。
- **Codex 代理上游**：**否决**硬编码 `api.openai.com`（用户是 ChatGPT 免费登录，会 401）；**选**读 `auth.json` 的 `auth_mode`/`OPENAI_API_KEY`/`tokens.access_token` 判断走 `chatgpt.com/backend-api/codex`。同时**否决**启动带 `/v1`（与 chatgpt 前缀冲突），**选**启动用代理根、代理统一 `上游base + /responses`，对两种登录都成立。
- **zstd 解压**：**否决**内置 `zlib`（Electron 28 → Node 18 无 `zstdDecompressSync`）；**选**打包纯 JS `fzstd`。用系统 `zstd` 造帧做了真实往返验证（魔数 `28b52ffd` 与现场乱码一致）。
- **Claude 注入 `ANTHROPIC_BASE_URL`（迭代三次，前两次被否决）**：
  1. **否决**：`writeProxyEnv` 持久化进 `active.env` —— 关代理后端口残留变陈旧死端口。
  2. **否决**：`set -a; …; ANTHROPIC_BASE_URL=…; set +a` —— 赋值被导出进交互式 shell，claude 退出后变量残留，下次关代理启动仍连死端口 → `ConnectionRefused`。
  3. **选**：进程作用域前缀 `ANTHROPIC_BASE_URL=… claude`，只对该进程生效，绝不进 shell。
- **启动是否带代理的判定源**：**否决**读 `proxy.env`/`active.env` 文件（端口每次随机、易残留陈旧）；**选**实时 `store.proxyEnabled && proxyServer.getPort()`，文件机制整体退役。
- **per-call token 显示**：选「纯工具轮也发 assistant_text 块（空文本 + tokenUsage）」，对 Claude/Codex 一致生效。
- **ZlibError**：根因是 Chromium（electron.net）透明解压后响应头仍带 `content-encoding`，客户端二次解压。选在 electron 响应路径剥掉编码/长度头；Node https 路径不受影响故不动。

## 当前状态 / 验证
- **类型与构建**：每步 `node_modules/.bin/tsc --noEmit` 退出码 0；`npm run build`（esbuild → `dist/extension.js`）均通过，`fzstd` 已打进 bundle。
- **数据层（真实 `~/.codex/sessions` 离线验证，已通过）**：用 esbuild 临时 harness 跑真实会话——web 搜索现解析为 search 工具；3 月 apply_patch/exec 输出全部 `[out✓]`；token/缓存数值正确；`model=gpt-5.3-codex`、`mode=on-request`；`getSystemPrompt()` 取到约 12–21KB；`fzstd` 对真实 zstd 帧往返成功（含中文）。全 24 个会话解析无崩溃。
- **代理实时链路**：本机无法跑 Electron+Codex/Claude，**实时 SSE 抓取由用户侧验证**；已加 `[ai-code-power proxy]` 诊断日志（目标 URL + status）。用户已确认 Claude 走代理后报错被逐个修复（ZlibError → ConnectionRefused → 现应正常）。
- **遗留 / 已知问题**：
  - 代理实时抓取仅单元级验证；ChatGPT 登录的 Codex 若上游返回 401，可能还需在转发到 chatgpt 上游时补 `chatgpt-account-id` 头（未确认，待用户日志）。
  - 用户当前终端可能仍残留上次泄漏的 `ANTHROPIC_BASE_URL`，需 `unset` 或开新终端（仅历史 shell，新构建不再泄漏）。
  - 本次改动未提交；相关文件还混有会话前的在建改动，提交时需按需挑选。

## 如何续接（下个会话从这接）
- **入口文件**：代理转发 `src/shared/proxy/proxy-server.ts`；Codex 数据 `src/adapters/codex/{jsonl-parser,session-index,index}.ts`；Claude 启动/代理 `src/adapters/claude/index.ts`；编排 `src/extension.ts`（`launchCli`、`toggleProxy`、`buildRawResult`/`buildCodexRawResult`、`pushPanel`）。
- **构建**：`cd termcat_client_plugin/ai-code-power && npm run build`；类型检查 `node_modules/.bin/tsc --noEmit`。
- **若代理实时验证出问题**：看开发者控制台 `ai-code-power proxy` 日志的 `-> <url> | status=`。Codex ChatGPT 登录若 401 → 在 `proxy-server.ts` 转发到 `chatgpt.com/backend-api/codex` 时从 `auth.json` 注入 `chatgpt-account-id`。
- **离线复跑数据层**：用 esbuild 把 `jsonl-parser` + `session-index`（+ `msg-block-adapter`）bundle 成 cjs，喂 `~/.codex/sessions/**/rollout-*.jsonl`，断言工具输出 `[out✓]`、token、systemPrompt。
- **坑**：electron.net 会自管/重写 `host`、`content-length`、`accept-encoding` 并透明解压；改转发头时务必区分 electron 路径与 Node https 路径。启动注入环境变量一律用进程作用域前缀，不要 `set -a` 导出。
