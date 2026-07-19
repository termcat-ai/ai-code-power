/**
 * 中文文案（基准 locale — `Locale = typeof zh`）。
 * 目前仅覆盖历史记录区；其余面板文案后续迁移。
 */
export const zh = {
  // 历史列表
  historyEmpty: '尚无历史 — 第一次输入 prompt 后会在这里出现',
  expandTooltip: '展开',
  collapseTooltip: '收起',
  viewRawTooltip: '查看原始记录',
  gotoTurnTooltip: '调用详情',

  // 头部 badge tooltip
  toolCountTooltip: '工具调用次数（本轮所有 API 调用之和）',
  filesReadTooltip: '读取文件数（去重）\n展开可查看文件清单',
  filesWriteTooltip: '写入文件数（去重·同文件既读又写只计写）\n展开可查看文件清单',
  skillsTooltip: '调用技能数（Skill 工具 + /slash 命令加载，去重）\n展开可查看技能清单',
  tokenInTooltip: '上行 Token（所有调用之和）\n= input_tokens + cache_creation_input_tokens（Claude）/ prompt_tokens（Codex）\n不含缓存命中，缓存命中单独显示',
  tokenOutTooltip: '下行 Token（所有调用之和）\n= output_tokens',
  tokenCacheTooltip: '缓存命中 Token（所有调用之和）\n= cache_read_input_tokens\n这部分上行内容直接从缓存读取，不重新计算',

  // 展开明细分组标题
  skillsGroupTitle: '技能',
  filesReadGroupTitle: '读取文件',
  filesWriteGroupTitle: '写入文件',
  subagentsGroupTitle: '子 Agent',

  // 子 agent 归并说明（本轮有子 agent 时追加到各 badge tooltip）
  includesSubagentsNote: '统计已含子 agent 内部调用',

  // 子 agent 明细弹窗
  clickToViewSubagent: '点击查看子 agent 调用明细',
  overviewTab: '概览',
  toolsTab: '工具',
  noneLabel: '（无）',
};
