import type { Locale } from './index';

export const es: Locale = {
  // Lista de historial
  historyEmpty: 'Sin historial — aparecerá tras tu primer prompt',
  expandTooltip: 'Expandir',
  collapseTooltip: 'Contraer',
  viewRawTooltip: 'Ver registro en bruto',
  gotoTurnTooltip: 'Detalles de la llamada',

  // Tooltips de badges
  toolCountTooltip: 'Llamadas a herramientas (suma de todas las llamadas de este turno)',
  filesReadTooltip: 'Archivos leídos (sin duplicados)\nExpande para ver la lista',
  filesWriteTooltip: 'Archivos escritos (sin duplicados; un archivo leído y escrito cuenta como escrito)\nExpande para ver la lista',
  skillsTooltip: 'Skills invocados (herramienta Skill + cargas /slash, sin duplicados)\nExpande para ver la lista',
  tokenInTooltip: 'Tokens de entrada (suma de todas las llamadas)\n= input_tokens + cache_creation_input_tokens (Claude) / prompt_tokens (Codex)\nNo incluye aciertos de caché, que se muestran por separado',
  tokenOutTooltip: 'Tokens de salida (suma de todas las llamadas)\n= output_tokens',
  tokenCacheTooltip: 'Tokens leídos de caché (suma de todas las llamadas)\n= cache_read_input_tokens\nEsta parte del contexto se sirvió desde caché sin recomputación',

  // Títulos de grupos del detalle
  skillsGroupTitle: 'Skills',
  filesReadGroupTitle: 'Archivos leídos',
  filesWriteGroupTitle: 'Archivos escritos',
  subagentsGroupTitle: 'Subagentes',

  // Añadido a los tooltips cuando el turno lanzó subagentes
  includesSubagentsNote: 'Los recuentos incluyen llamadas internas de subagentes',

  // Modal de detalles del subagente
  clickToViewSubagent: 'Clic para ver los detalles del subagente',
  overviewTab: 'Resumen',
  toolsTab: 'Herramientas',
  noneLabel: '(ninguno)',
};
