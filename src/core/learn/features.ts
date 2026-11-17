/* Turns an email into the sparse features the models learn from: who sent it, how you were addressed, and what
   it is about. Feature strings are stored with each decision so any device can retrain after a sync merge. */
import type { MailMessage } from '../types';
import { domainOf } from '../util';
import { cleanSubject, isForwardSubject, isReplySubject } from '../providers/provider';

export interface FeatureContext { me: string }

const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com']);
const STOP = new Set('the and for you your with from this that are was were have has had not but all any can our out new now get got just will about into over more than then them they their there what when where which who why how its it’s it\'s re fwd fw please thanks thank hello dear regarding update updates info re: fw: fwd: email mail message'.split(' '));

export const URGENT_RE = /\b(urgent|asap|immediately|right away|emergency|critical|time[- ]sensitive|action required|past due|overdue)\b/i;
export const DEADLINE_RE = /\b(today|tonight|tomorrow|by (noon|eod|end of (the )?day|cob|monday|tuesday|wednesday|thursday|friday)|due|deadline|before \d|no later than|this (morning|afternoon|week))\b/i;
export const MONEY_RE = /(\$\s?\d|\b(invoice|payment|pay app|wire|ach|bank|routing|account number|remit|w-?9|purchase order|po #|change order|budget|quote|bid)\b)/i;

export function tokens(text: string, max = 8): string[] {
  const out: string[] = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9#-]+/)) {
    const t = raw.replace(/^[-#]+|[-#]+$/g, '');
    if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function featuresOf(m: MailMessage, ctx: FeatureContext): string[] {
  const me = ctx.me.toLowerCase();
  const myDomain = domainOf(me);
  const sender = m.from.email;
  const senderDomain = domainOf(sender);
  const f = ['bias', `from:${sender}`, `dom:${senderDomain}`];
  const direct = m.to.some((p) => p.email === me);
  const ccOnly = !direct && m.cc.some((p) => p.email === me);
  f.push(direct ? 'direct' : ccOnly ? 'cc-only' : 'not-addressed');
  if (direct && m.to.length === 1) f.push('only-me');
  if (m.to.length + m.cc.length > 5) f.push('many-recipients');
  if (myDomain && !PUBLIC_DOMAINS.has(myDomain)) f.push(senderDomain === myDomain ? 'internal' : 'external');
  if (m.isBulk) f.push('bulk');
  if (m.hasAttachments) f.push('attachment');
  if (m.importance === 'high') f.push('marked-important');
  if (isReplySubject(m.subject)) f.push('reply-thread');
  if (isForwardSubject(m.subject)) f.push('forwarded-to-me');
  const text = `${m.subject} ${m.snippet}`;
  if (URGENT_RE.test(text)) f.push('urgent-words');
  if (DEADLINE_RE.test(text)) f.push('deadline-words');
  if (MONEY_RE.test(text)) f.push('money-words');
  if (/\?/.test(m.snippet) || /\?/.test(m.subject)) f.push('question');
  for (const t of tokens(cleanSubject(m.subject))) f.push(`w:${t}`);
  return f;
}

/** Features the folder model uses (who + what, not urgency). */
export const folderFeatures = (features: string[]) => features.filter((x) => /^(from|dom|w):/.test(x) || x === 'cc-only' || x === 'bulk' || x === 'attachment');

/** Plain-English label for a positive feature, for "Why this order?". */
export function describeFeature(feature: string): string | null {
  if (feature.startsWith('w:')) return `Mentions “${feature.slice(2)}”`;
  if (feature.startsWith('dom:')) return `You act on most email from ${feature.slice(4)}`;
  return ({
    direct: 'Sent directly to you', 'only-me': 'Sent only to you', internal: 'From inside your company', attachment: 'Has attachments',
    'marked-important': 'Marked important', 'urgent-words': 'Says it is urgent', 'deadline-words': 'Mentions a deadline',
    'money-words': 'Involves money or a bid', question: 'Asks you a question', 'reply-thread': 'Part of a conversation you are in',
    'forwarded-to-me': 'Forwarded to you by someone',
  } as Record<string, string>)[feature] || null;
}
