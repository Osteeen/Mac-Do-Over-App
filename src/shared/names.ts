import type { NameFlag } from './types.js';

// Written as escapes on purpose: the characters themselves are invisible in an editor and a diff.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const NEWLINE = /[\r\n\u2028\u2029]/;
const CONTROL = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;
/** Looks like a tag or an HTML entity. Apostrophes and ampersands in ordinary names are not flagged. */
const MARKUP = /<[a-zA-Z/!]|&[#a-zA-Z0-9]+;/;

/**
 * Why a filename or title needs care on screen. Screens show a badge for every flag.
 * This detects; it does not sanitise. Names are always rendered as text, flagged or not.
 */
export function nameFlags(name: string): NameFlag[] {
  const flags: NameFlag[] = [];
  if (BIDI.test(name)) flags.push('bidi');
  if (CONTROL.test(name)) flags.push('control');
  if (NEWLINE.test(name)) flags.push('newline');
  if (MARKUP.test(name)) flags.push('markup');
  return flags;
}
