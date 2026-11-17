/* Shared data shapes for providers (Gmail, Outlook, demo), the learning engine and the UIs. */

export type ProviderKind = 'gmail' | 'outlook' | 'demo';

export interface Person { name: string; email: string }

/** One email as the assistant sees it. Metadata only; bodies are fetched on demand. */
export interface MailMessage {
  id: string;                 // Gmail message id, or Graph immutable id
  threadId: string;           // Gmail threadId, or Graph conversationId
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  snippet: string;
  date: number;               // received, epoch ms
  isRead: boolean;
  flagged: boolean;           // Gmail star / Outlook flag
  hasAttachments: boolean;
  inInbox: boolean;
  inTrash: boolean;
  folderId: string | null;    // user folder/label the message sits in (null = inbox/archive/system)
  isBulk: boolean;            // newsletters, notifications, no-reply senders
  isSent?: boolean;
  importance?: 'low' | 'normal' | 'high';
  webLink?: string;
}

export interface Attachment { name: string; size: number; mimeType?: string }
export interface MailBody { text: string; attachments: Attachment[] }
export interface FullMessage extends MailMessage { body: MailBody }

export interface Folder { id: string; name: string }

/** Something the user sent: used to detect replies and forwards. */
export interface SentMessage {
  id: string;
  threadId: string;
  to: Person[];
  subject: string;
  date: number;
  kind: 'reply' | 'forward' | 'new';
}

/** Result of one incremental pull from the mailbox. */
export interface PullResult {
  cursor: string;
  upserts: MailMessage[];     // new or changed messages (current location and flags)
  removedIds: string[];       // permanently gone
  sent: SentMessage[];        // newly sent by the user
  full: boolean;              // true when this was a full resync (upserts = whole recent inbox)
}

/** What the user did with an email. The learning engine trains on these. */
export type DecisionKind =
  | 'replied' | 'forwarded' | 'flagged' | 'made-priority' | 'always-sender' // positive
  | 'trashed' | 'ignored' | 'archived' | 'not-priority' | 'later' | 'later-sender' | 'read-only' // negative / weak
  | 'filed';                                                                    // folder signal

export interface Decision {
  id: string;                 // `${msgId}:${kind}` (dedupe across devices)
  msgId: string;
  kind: DecisionKind;
  at: number;
  arrived: number;
  latencyMin?: number;
  to?: string;                // forward target email
  folder?: string;            // folder name filed into
  wasRead?: boolean;
  sender: string;
  features: string[];         // feature keys at arrival time (lets any device retrain after a merge)
  source: 'observed' | 'explicit' | 'backfill';
  predictedPriority?: boolean;   // shadow-mode guess made before the user acted
  predictedFolder?: string | null;
}

export type Tier = 'urgent' | 'important';

export interface Task {
  id: string;
  msgId: string;
  title: string;
  sub: string;
  due: number | null;         // epoch ms
  done: boolean;
  kind: 'reminder' | 'due';   // user reminder, or due date the AI found in the email
  updatedAt: number;
}

export interface MovedItem {
  msgId: string;
  subject: string;
  from: string;
  folderName: string;
  folderId: string;
  at: number;
  reason: string;
  undone?: boolean;
}

/** Per-email AI analysis (cached). */
export interface Analysis {
  headline: string;
  bullets: string[];
  nextStep: string;
  action: 'reply' | 'forward' | 'remind' | 'call' | 'none';
  draft?: string;
  due?: { iso: string; label: string } | null;
  phone?: string | null;
  at: number;
}

/** "Where did this thread end up" summary for long chains. */
export interface ThreadSummary {
  whereItEnded: string;
  bullets: string[];
  openItems: string[];
  messageCount: number;
  lastFrom: string;
  at: number;
}

export interface Settings {
  autoFile: boolean;          // allow folder moves once confident (never sends)
  ccFolder: boolean;          // move emails where I'm only CC'd into a "CC" folder
  colorLabels: boolean;       // write Priority labels/categories to the mailbox
  ownGeminiKey: string;       // optional: user's own key instead of the team proxy
  everythingElseOrder: 'priority' | 'newest';
}

export interface AccountInfo { kind: ProviderKind; email: string; name: string }
