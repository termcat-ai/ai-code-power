# 2026-06-27 修改摘要：修正面板按 CLI 分流、Codex approval 改启动注入、新增 Codex Preset

## 一句话概述
修复了 ai-code-power 面板在选 Codex 时错误显示 Claude 字段的 bug，把 Codex approval_policy
从「写 codex 不读的 config.json」改成「启动时 `-c` 注入」，并为 Codex 新增了与 Claude 对等的
Preset（key / baseUrl / model）能力。

## 背景 / 目标
触发点：用户截图发现面板选了 Codex，下面却显示 Claude 的 PRESET / DRIVE 模式字段（对 Codex 无意义）。
顺着排查，又牵出两件事：
1. Codex 的「模式」(approval_policy) 当时只读、且底层 `setMode` 写的是 codex **根本不读**的
   `~/.codex/config.json`，取值还是旧版 `suggest/auto-edit/full-auto`。
2. 用户希望 Codex 也能像 Claude 那样在面板里换 baseUrl / model / key（场景：指向 OpenAI 兼容中转站）。

目标：让面板字段严格跟随所选 CLI、只显示可配置项；让 Codex approval 真正生效；给 Codex 做一套 Preset。

## 改动清单
全部位于 `termcat_client_plugin/ai-code-power/`，**均为未提交工作区改动**（用户习惯手动 commit）。

**新增**
- `src/adapters/codex/preset-store.ts` — `CodexPreset` 类型 + `CodexPresetStore`（load/list/getActive/
  upsert/setActive/save），存 `~/.termcat/plugins/ai_code_power/codex-presets.json`；`generateCodexActiveEnv`
  只写 `OPENAI_API_KEY`（带 cleanup prologue，键 `__TC_ACP_CODEX_MANAGED_KEYS`），落 `codex-active.env`。

**修改**
- `src/adapters/codex/index.ts`
  - `buildCodexLaunch` 抽为导出函数并改 opts 对象签名 `{ proxyUrl, baseUrl, model, approvalPolicy }`；
    `openai_base_url ← proxyUrl ?? baseUrl`，三项均单引号包裹（防 shell 吞双引号）。
  - `CodexAdapter.launch` 回退为接口签名 `(injector, sessionId, proxyUrl?)`，委托 `buildCodexLaunch`。
  - `setMode` 不再写 config.json，只更新内存 `index.setApprovalMode` + 注入重启提示。
- `src/adapters/codex/config-reader.ts` — 删除已无人调用的 `writeApprovalMode`（-10 行）。
- `src/extension.ts`（+167/-，主要）
  - `buildControlsSection`：`kind = adapter?.kind ?? selectedCliKind`（修复回退 bug）；Codex 分支加 PRESET
    下拉（选/编辑/新建）、**移除独立只读 MODEL 字段**、approval「模式」加 🔄 cycle 按钮、保留「会话」。
  - 新增全局 `selectedCodexApproval`；`CODEX_APPROVAL_MODES = ['untrusted','on-request','never']`。
  - `cycleApprovalMode` 处理：不写文件、不要求运行中，只记录选择 + pushPanel。
  - 新增全局 `codexPresetStore`，activate 加载；proxy 上游解析 codex 分支优先 `codexPresetStore.getActive()?.baseUrl`。
  - `field-change` / `presetFlow` / createPreset / editPreset 按 `adapter?.kind ?? selectedCliKind` 分流到 codex/claude store。
  - `launchCli` codex 分支：有 key 先 `set -a; source codex-active.env; set +a;`，再
    `buildCodexLaunch({ proxyUrl, baseUrl: preset.baseUrl, model: preset.model, approvalPolicy: selectedCodexApproval })`。

本次无新 commit；基线 commit：`83cb4f0 ai-code-power支持codex`。

## 关键决策与理由
- **approval_policy 持久化方式**：
  - 否决「写 `~/.codex/config.toml`」(A)：现有 `CodexConfigReader` 用 `JSON.parse` 读 config.toml 会直接崩，
    且需引入 TOML writer 处理嵌套表，改动重。
  - 选「启动 `-c approval_policy=` 注入」(B)：与已有 proxy 注入（`-c openai_base_url`）同一套路，
    不碰配置文件格式、即时随启动生效。代价：仅下次启动生效（codex 启动时读一次配置，运行中改不了），已在 UI 提示。
- **Codex baseUrl 实现**：选 `-c openai_base_url=`（用户场景为 OpenAI 兼容中转站，足够）；
  否决完整 `model_providers.<id>` 配置（需自定义认证头/wire_api，复杂，非本次场景）。
- **API key 传递**：选「source 一个只含 OPENAI_API_KEY 的 env 文件」（与 Claude 一致，key 不落命令行/ps/history）；
  否决「命令行前缀 `OPENAI_API_KEY=` codex」（会暴露在 `ps`/历史）。
- **Codex MODEL 字段去留**：最终**移除**。注意这**反转了本会话早先「保留 MODEL 作信息展示」的决定**——
  因为加了 PRESET 下拉后 model 已并入 PRESET 标签（`name · model`），独立 MODEL 字段冗余且与 Claude 不一致。
- **取值集合纠正**：旧 `suggest/auto-edit/full-auto` 是 TS 版 codex 叫法；核实 codex 0.142 二进制后改为真实
  `approval_policy` 值 `untrusted/on-request/never`（`on-failure` 已弃用，不入循环）。

## 当前状态 / 验证
- `npm run build` + `npx tsc --noEmit` 均通过（dist 122.5kb）。
- `buildCodexLaunch` 输出用 node 验证三种场景：proxy 关+key（source env + 三个 `-c`）、proxy 开（proxy 占
  base 槽）、bare（`codex`）——字符串均正确。
- **未做真机验证**：尚未在 TermCat 里实际重载插件、启动真实 codex 连中转站（需用户手测）。
- 遗留 / 已知问题：
  1. **Claude 代理抓包/JSONL 重建不完整**（用户本会话新提出）：未启 proxy 时只能从 JSONL 重建
     user/assistant 文本，system prompt 与 tool 定义未存储/未捕获。
     → 后续已诊断（结论：非 bug，是生命周期）并做了 UX 改进，详见
     [2026-06-27-代理抓包诊断与代理注入健壮性修复](./2026-06-27-代理抓包诊断与代理注入健壮性修复.md)。
  2. `claude_refs/ARCHITECTURE.md` §15（写「codex Preset 管理：无」）、§10.2（旧的 config.json/approvalMode 描述）
     与现实现已不一致，本会话未改（留待 dum-doc-reconcile）。
  3. `CodexConfigReader.read()` 仍读 codex 不写的 config.json，属 vestigial，未清理。
  4. `CodexAdapter.setMode` 现仅满足 IAdapter 接口、面板不再调用（approval 走 `-c`）。

## 如何续接（下个会话从这接）
- 入口文件：
  - `src/extension.ts`：`buildControlsSection`（面板字段）、`launchCli`（启动注入）、`handlePanelEvent`（事件分流）、
    proxy 上游解析闭包（activate 内 `new ProxyServer`）。
  - `src/adapters/codex/index.ts`：`buildCodexLaunch`、`CodexAdapter`。
  - `src/adapters/codex/preset-store.ts`：Codex preset 存储。
- 手测：TermCat 重载 ai-code-power 插件 → 面板选 Codex → PRESET 旁「+」新建（填中转站 baseUrl / key / model）→
  点 ▶ 启动，确认注入命令形如
  `set -a; source '…/codex-active.env'; set +a; codex -c 'openai_base_url="<中转站>"' -c 'model="<model>"'`，
  且 codex 实际连到中转站；切回 Claude 确认 PRESET/DRIVE 不受影响。
- 候选下一步：①排查并修复「Claude 代理抓包不完整」（遗留问题 1）；②真机验证 Codex preset；
  ③用 dum-doc-reconcile 校正 ARCHITECTURE.md §15/§10.2。
