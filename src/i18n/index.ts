/**
 * Idiomas de la interfaz. El proceso principal y la interfaz usan los mismos textos: el proceso
 * principal decide el idioma (config.json) y lo envía en cada estado que muestra la interfaz.
 */
import { en } from './en';
import { es } from './es';

export type Language = 'es' | 'en';
export type Messages = typeof es;

export const DEFAULT_LANGUAGE: Language = 'es';

/** Idiomas que se pueden elegir, cada uno con su nombre en su propio idioma. */
export const LANGUAGES: readonly { value: Language; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
];

const ALL: Readonly<Record<Language, Messages>> = { es, en };

export function messages(language: Language): Messages {
  return ALL[language] ?? es;
}

export function isLanguage(value: unknown): value is Language {
  return value === 'es' || value === 'en';
}

/** Idioma a partir de una configuración regional («es-ES», «en-GB»…): español o, si no, inglés. */
export function languageFromLocale(locale: string | null | undefined): Language {
  return (locale ?? '').toLowerCase().startsWith('es') ? 'es' : 'en';
}

/**
 * Idioma elegido en el instalador (identificador de idioma de Windows que escribe NSIS):
 * 1033 = English, 3082 = Español (alfabetización internacional). `null` si no se reconoce.
 */
export function languageFromInstallerId(id: string): Language | null {
  const lcid = Number(id.trim());
  if (!Number.isInteger(lcid) || lcid <= 0) return null;
  // El byte bajo es el idioma principal: 0x0A español, 0x09 inglés.
  const primary = lcid & 0x3ff;
  if (primary === 0x0a) return 'es';
  if (primary === 0x09) return 'en';
  return null;
}

/** Tamaño legible según el idioma: «1,2 MB» o «1.2 MB». */
export function formatBytes(bytes: number, language: Language = DEFAULT_LANGUAGE): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(messages(language).locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
}
