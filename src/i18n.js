// -----------------------------------------------------------------------------
// The languages this integration writes its user-facing messages in.
//
// Gladys displays a multi-language object `{ en, fr, de, es }` in the reader's
// language and falls back on `en` for any other, so a message is a plain
// object literal carrying the four of them. This module only serves the
// messages ASSEMBLED from parts (a summary line followed by one line per
// dataset, a list of issues joined by commas): building each language from the
// same parts keeps the four versions from drifting apart.
// -----------------------------------------------------------------------------

/** Every language a user-facing message carries. English comes first: it is the fallback. */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * A multi-language message built language by language.
 *
 * @param {(language: string) => string} build the text in one language
 * @returns {{ en: string, fr: string, de: string, es: string }}
 */
export function perLanguage(build) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, build(language)]));
}
