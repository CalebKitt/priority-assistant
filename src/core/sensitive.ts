/* "Are you sure?" checks before anything leaves the mailbox (Steven's ask): attachments, money/bank details,
   and recipients outside the company. Returns plain-English reasons; an empty list means no extra prompt. */
import type { MailMessage, Person } from './types';
import { domainOf } from './util';

const FINANCIAL_RE = /\b(bank|routing|account (number|#)|acct|wire|ach|iban|swift|ssn|social security|tax id|ein|w-?9|credit card|password|invoice|payment|pay app|remit)\b|\$\s?\d[\d,]*(\.\d+)?/i;
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'aol.com']);

export interface SendCheck { reasons: string[]; needsConfirm: boolean }

export function checkSend(opts: { kind: 'reply' | 'forward'; message: MailMessage; text: string; bodyText?: string; to: Person[]; me: string; attachmentCount?: number }): SendCheck {
  const reasons: string[] = [];
  const myDomain = domainOf(opts.me);
  if (opts.kind === 'forward' && (opts.attachmentCount ?? (opts.message.hasAttachments ? 1 : 0)) > 0) {
    reasons.push(opts.attachmentCount ? `Includes ${opts.attachmentCount} attachment${opts.attachmentCount === 1 ? '' : 's'} from the original email` : 'Includes the original attachments');
  }
  const scan = `${opts.message.subject}\n${opts.text}\n${opts.kind === 'forward' ? opts.bodyText || opts.message.snippet : ''}`;
  const money = FINANCIAL_RE.exec(scan);
  if (money) reasons.push(`Mentions financial details (“${money[0].trim()}”)`);
  if (myDomain && !PUBLIC.has(myDomain)) {
    const outside = opts.to.filter((p) => domainOf(p.email) !== myDomain);
    if (outside.length && opts.kind === 'forward') reasons.push(`Goes outside your company: ${outside.map((p) => p.email).join(', ')}`);
  }
  if (opts.to.length > 5) reasons.push(`Goes to ${opts.to.length} people`);
  return { reasons, needsConfirm: reasons.length > 0 };
}
