import { locales, type Locale } from './locales';

export type UILanguage = 'zh' | 'en' | 'es';

let currentLanguage: UILanguage = 'zh';

export function setLanguage(lang: string): void {
  if (lang === 'zh' || lang === 'en' || lang === 'es') currentLanguage = lang;
}

export function t(): Locale {
  return locales[currentLanguage];
}
