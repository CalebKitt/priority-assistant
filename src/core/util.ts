/* Small platform-neutral helpers. */
import type { Person } from './types';

export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const firstName = (name: string): string => String(name || '').trim().split(/\s+/)[0] || name;

export const initials = (name: string): string =>
  String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

export function avatarColor(name: string): string {
  const palette = ['#E8590C', '#2F6F9F', '#5B8C5A', '#8A5CA8', '#B5651D', '#3D7F7B', '#A33B5B', '#5C6B7A'];
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export const avatar = (name: string, size = 32): string =>
  `<span class="avatar" style="width:${size}px;height:${size}px;background:${avatarColor(name)};font-size:${Math.round(size * 0.4)}px">${esc(initials(name))}</span>`;

export const domainOf = (email: string): string => (String(email).split('@')[1] || '').toLowerCase();

/** Parse one RFC 5322 address ("Jane Doe <jane@x.com>" or "jane@x.com"). */
export function parsePerson(raw: string): Person {
  const text = String(raw || '').trim();
  const angle = /^(.*?)<([^>]+)>\s*$/.exec(text);
  if (angle) {
    const email = angle[2].trim().toLowerCase();
    const name = angle[1].trim().replace(/^"|"$/g, '').replace(/\\"/g, '"');
    return { name: name || email.split('@')[0], email };
  }
  return { name: text.split('@')[0] || text, email: text.toLowerCase() };
}

/** Parse an address list, respecting commas inside quoted names. */
export function parsePeople(raw: string | undefined): Person[] {
  if (!raw) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === '<') angled = true;
    if (ch === '>') angled = false;
    if (ch === ',' && !quoted && !angled) { parts.push(current); current = ''; } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map(parsePerson).filter((p) => p.email.includes('@'));
}

export const formatPerson = (p: Person): string => (p.name && p.name !== p.email ? `"${p.name.replace(/"/g, '')}" <${p.email}>` : p.email);

const DAY = 86400000;
export const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Inbox-style time: "9:41 AM" today, "Mon" this week, "Nov 3" otherwise. */
export function shortTime(t: number, now = Date.now()): string {
  const d = new Date(t);
  if (startOfDay(t) === startOfDay(now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (now - t < 6 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function dueLabel(t: number, now = Date.now()): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run async jobs with limited concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Standard base64 of bytes, in chunks (spreading a large array into fromCharCode overflows the stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const textToBase64 = (text: string): string => bytesToBase64(new TextEncoder().encode(text));

export function base64UrlEncode(text: string): string {
  return textToBase64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Strip HTML to readable plain text (for AI prompts and voice). */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Drop quoted history ("On Mon, X wrote:" and "> " lines) so prompts see only the new part of a reply. */
export function stripQuoted(text: string): string {
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || /^From: .+/i.test(line.trim()) && out.length > 3) break;
    if (line.trim().startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
