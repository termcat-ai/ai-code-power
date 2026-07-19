import type { Locale } from './index';

export const en: Locale = {
  // History list
  historyEmpty: 'No history yet — it will appear after your first prompt',
  expandTooltip: 'Expand',
  collapseTooltip: 'Collapse',
  viewRawTooltip: 'View raw record',
  gotoTurnTooltip: 'Call details',

  // Header badge tooltips
  toolCountTooltip: 'Tool calls (sum of all API calls this turn)',
  filesReadTooltip: 'Files read (distinct)\nExpand to see the file list',
  filesWriteTooltip: 'Files written (distinct; a file both read and written counts as written)\nExpand to see the file list',
  skillsTooltip: 'Skills invoked (Skill tool + /slash loads, distinct)\nExpand to see the skill list',
  tokenInTooltip: 'Input tokens (sum of all API calls)\n= input_tokens + cache_creation_input_tokens (Claude) / prompt_tokens (Codex)\nExcludes cache hits, which are shown separately',
  tokenOutTooltip: 'Output tokens (sum of all API calls)\n= output_tokens',
  tokenCacheTooltip: 'Cache hit tokens (sum of all API calls)\n= cache_read_input_tokens\nThis portion of the context was served from cache without recomputation',

  // Expanded detail group titles
  skillsGroupTitle: 'Skills',
  filesReadGroupTitle: 'Files read',
  filesWriteGroupTitle: 'Files written',
  subagentsGroupTitle: 'Sub-agents',

  // Appended to badge tooltips when the turn spawned sub-agents
  includesSubagentsNote: 'Counts include sub-agent internal calls',

  // Sub-agent detail modal
  clickToViewSubagent: 'Click to view sub-agent call details',
  overviewTab: 'Overview',
  toolsTab: 'Tools',
  noneLabel: '(none)',
};
