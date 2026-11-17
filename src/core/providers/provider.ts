/* The one interface the assistant uses to talk to a mailbox. Gmail, Outlook (Microsoft Graph) and the demo
   mailbox all implement it, so the learning engine and UIs never care which one is behind it. */
import type { AccountInfo, Folder, FullMessage, MailBody, MailMessage, Person, ProviderKind, PullResult, SentMessage, Tier } from '../types';

export interface MailProvider {
  readonly kind: ProviderKind;
  account(): Promise<AccountInfo>;

  /** Incremental sync. cursor = null means full resync of the recent inbox. */
  pull(cursor: string | null): Promise<PullResult>;

  /** Recent messages for first-run learning: everything received in the last `days`, wherever it lives now. */
  history(days: number, max: number): Promise<MailMessage[]>;
  /** Messages the user sent in the last `days` (to learn who they answer, how fast, and who they forward to). */
  sentHistory(days: number, max: number): Promise<SentMessage[]>;

  /** The user's own folders (Gmail user labels / Outlook custom folders). */
  folders(): Promise<Folder[]>;
  folderMessages(folderId: string, max: number): Promise<MailMessage[]>;

  body(message: MailMessage): Promise<MailBody>;
  thread(threadId: string): Promise<FullMessage[]>;

  reply(message: MailMessage, text: string, replyAll: boolean): Promise<void>;
  forward(message: MailMessage, to: Person[], note: string): Promise<void>;

  moveToFolder(message: MailMessage, folderId: string): Promise<void>;
  moveToInbox(message: MailMessage): Promise<void>;
  trash(message: MailMessage): Promise<void>;
  archive(message: MailMessage): Promise<void>;
  markRead(message: MailMessage, read: boolean): Promise<void>;
  setFlag(message: MailMessage, flagged: boolean): Promise<void>;
  ensureFolder(name: string): Promise<Folder>;
  /** Color-coded priority marker visible in the native apps (Gmail label / Outlook category). null clears it. */
  setTier(message: MailMessage, tier: Tier | null): Promise<void>;

  /** Load / save the learned-state file in the user's own cloud app folder. */
  loadSyncDoc(): Promise<string | null>;
  saveSyncDoc(json: string): Promise<void>;
}

export const TIER_NAMES: Record<Tier, string> = { urgent: 'Priority: Urgent', important: 'Priority: Important' };
export const CC_FOLDER = 'CC';

/** Bulk-mail heuristics shared by providers. */
export function looksBulk(fromEmail: string, headers: { listUnsubscribe?: string; precedence?: string; autoSubmitted?: string }): boolean {
  if (headers.listUnsubscribe) return true;
  if (/bulk|list|junk/i.test(headers.precedence || '')) return true;
  if (headers.autoSubmitted && !/^no$/i.test(headers.autoSubmitted)) return true;
  return /(^|[._-])(no-?reply|do-?not-?reply|notifications?|newsletter|news|mailer|marketing|updates?|digest|alerts?)([._-]|@)/i.test(fromEmail);
}

export const isForwardSubject = (subject: string) => /^\s*(fwd?|fw)\s*:/i.test(subject);
export const isReplySubject = (subject: string) => /^\s*(re|aw|sv)\s*:/i.test(subject);
export const cleanSubject = (subject: string) => String(subject || '').replace(/^\s*((re|fwd?|fw|aw|sv)\s*:\s*)+/i, '').trim() || '(no subject)';
