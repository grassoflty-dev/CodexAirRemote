/**
 * Voice-input shortcut logic.
 *
 * Adapted from dsh-ears `src/shortcut.ts`
 * (https://github.com/WizisCool/dsh-ears, MIT, Copyright (c) JUNZE).
 * Modifications for dsh-airremote: kept the parser/matcher unchanged so the
 * shortcut UX is identical; only comments and import paths differ.
 *
 * Canonical chord format: lowercase, '+' separated modifiers in order
 * ctrl, alt, shift, meta, then key.
 */

export type ShortcutModifier = 'ctrl' | 'alt' | 'shift' | 'meta'

export const SHORTCUT_MODIFIERS: readonly ShortcutModifier[] = ['ctrl', 'alt', 'shift', 'meta']

export const SHORTCUT_MAX_LENGTH = 64

/** Key tokens that type or act on text; never valid as a bare shortcut. */
const TEXT_ACTION_TOKENS = new Set([
  'space', 'enter', 'tab', 'backspace', 'delete',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'home', 'end', 'pageup', 'pagedown', 'insert',
  'backquote', 'semicolon', 'period', 'comma', 'minus', 'equal',
  'bracketleft', 'bracketright', 'backslash', 'slash', 'quote', 'intlbackslash'
])

export interface ParsedShortcut {
  readonly modifiers: readonly ShortcutModifier[]
  readonly key: string
}

const KEY_TOKEN_BY_CODE: Record<string, string> = {
  Space: 'space',
  Backquote: 'backquote',
  Semicolon: 'semicolon',
  Period: 'period',
  Comma: 'comma',
  Minus: 'minus',
  Equal: 'equal',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
  Slash: 'slash',
  Quote: 'quote',
  IntlBackslash: 'intlbackslash',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'arrowup',
  ArrowDown: 'arrowdown',
  ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert'
}

for (let index = 1; index <= 12; index += 1) KEY_TOKEN_BY_CODE[`F${index}`] = `f${index}`
for (let index = 0; index < 26; index += 1) {
  const letter = String.fromCharCode(65 + index)
  KEY_TOKEN_BY_CODE[`Key${letter}`] = letter.toLowerCase()
}
for (let index = 0; index <= 9; index += 1) KEY_TOKEN_BY_CODE[`Digit${index}`] = String(index)

function isModifierToken(token: string): token is ShortcutModifier {
  return (SHORTCUT_MODIFIERS as readonly string[]).includes(token)
}

/** Map a modifier keydown/keyup to its canonical token. */
export function modifierTokenFromEvent(event: { readonly key?: string; readonly code?: string }): ShortcutModifier | null {
  if (event.key === 'Control' || event.code === 'ControlLeft' || event.code === 'ControlRight') return 'ctrl'
  if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') return 'alt'
  if (event.key === 'Shift' || event.code === 'ShiftLeft' || event.code === 'ShiftRight') return 'shift'
  if (event.key === 'Meta' || event.code === 'MetaLeft' || event.code === 'MetaRight') return 'meta'
  return null
}

/** Parse a canonical chord into modifiers and key token; null on malformed input. */
export function parseShortcut(chord: string): ParsedShortcut | null {
  if (typeof chord !== 'string') return null
  if (chord.trim() === '' || chord.length > SHORTCUT_MAX_LENGTH) return null
  const tokens = chord.trim().toLowerCase().split('+').filter((token) => token !== '')
  if (tokens.length === 0) return null
  const modifiers: ShortcutModifier[] = []
  for (const token of tokens.slice(0, -1)) {
    if (!isModifierToken(token)) return null
    if (!modifiers.includes(token)) modifiers.push(token)
  }
  const key = tokens[tokens.length - 1]
  if (key === undefined || isModifierToken(key)) return null
  if (TEXT_ACTION_TOKENS.has(key)) return null
  return { modifiers, key }
}

/** Format a parsed shortcut back to the canonical chord. */
export function formatShortcut(parsed: ParsedShortcut): string {
  return [...parsed.modifiers, parsed.key].join('+')
}

/** Normalize user input, returning null when it is not a usable chord. */
export function normalizeShortcut(chord: string): string | null {
  const parsed = parseShortcut(chord)
  return parsed === null ? null : formatShortcut(parsed)
}

/** Resolve the key token of a KeyboardEvent (layout independent via `code`). */
export function keyTokenFromEvent(event: { readonly key?: string; readonly code?: string }): string | null {
  const token = (event.key ?? '').toLowerCase()
  if (token.length === 1) return token
  const byKey: Record<string, string> = {
    ' ': 'space',
    enter: 'enter',
    tab: 'tab',
    backspace: 'backspace',
    delete: 'delete',
    escape: 'escape',
    arrowup: 'arrowup',
    arrowdown: 'arrowdown',
    arrowleft: 'arrowleft',
    arrowright: 'arrowright'
  }
  if (token in byKey) return byKey[token]
  if (/^f([1-9]|1[0-2])$/.test(token)) return token
  if (event.code !== undefined && keyTokenFromEvent(event) !== null) {
    return KEY_TOKEN_BY_CODE[event.code] ?? null
  }
  return null
}

/** True when the keyboard event matches the canonical chord (strict modifiers). */
export function matchesShortcut(chord: string, event: KeyboardEvent): boolean {
  const parsed = parseShortcut(chord)
  if (parsed === null) return false
  const key = keyTokenFromEvent(event)
  if (key === null || key !== parsed.key) return false
  const eventModifiers: ShortcutModifier[] = []
  if (event.ctrlKey) eventModifiers.push('ctrl')
  if (event.altKey) eventModifiers.push('alt')
  if (event.shiftKey) eventModifiers.push('shift')
  if (event.metaKey) eventModifiers.push('meta')
  return eventModifiers.length === parsed.modifiers.length &&
    parsed.modifiers.every((modifier) => eventModifiers.includes(modifier))
}
