/* Gmail API provider. Incremental sync uses the history API; the learned-state file lives in Drive's hidden
   appDataFolder (only this app can see it). */
import type { AccountInfo, Attachment, Folder, FullMessage, MailBody, MailMessage, Person, PullResult, SentMessage, Tier } from '../types';
import { authedFetch, jsonOrThrow, type TokenManager } from '../auth';
import { base64UrlDecode, base64UrlEncode, formatPerson, htmlToText, mapLimit, parsePeople, parsePerson, textToBase64 } from '../util';
import { cleanSubject, isForwardSubject, isReplySubject, looksBulk, TIER_NAMES, type MailProvider } from './provider';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SYNC_FILE = 'priority-assistant.json';
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'Message-ID', 'In-Reply-To', 'References', 'Content-Type'];
const BULK_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
const TIER_COLORS: Record<Tier, { backgroundColor: string; textColor: string }> = {
  urgent: { backgroundColor: '#fb4c2f', textColor: '#ffffff' },
  important: { backgroundColor: '#ffad47', textColor: '#ffffff' },
};

interface GmailHeader { name: string; value: string }
interface GmailPart { mimeType: string; filename?: string; headers?: GmailHeader[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[] }
interface GmailMsg { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GmailPart; historyId?: string }

const header = (msg: GmailMsg, name: string) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

/** RFC 2047 encode a header value when it has non-ASCII characters. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${textToBase64(value)}?=`;
}

const encodeAddress = (p: Person) => (p.name && p.name !== p.email ? `${encodeHeader(`"${p.name.replace(/"/g, '')}"`)} <${p.email}>` : p.email);

function wrap76(b64: string): string { return b64.replace(/.{1,76}/g, '$&\r\n'); }

export class GmailProvider implements MailProvider {
  readonly kind = 'gmail' as const;
  private meta = new Map<string, MailMessage>();
  private extra = new Map<string, { messageId: string; references: string }>();
  private labels: Map<string, string> | null = null;   // id -> name (user labels)
  private me: AccountInfo | null = null;
  private syncFileId: string | null = null;

  constructor(private tm: TokenManager) {}

  private async get(path: string, what: string): Promise<any> {
    return jsonOrThrow(await authedFetch(this.tm, `${API}${path}`), what);
  }

  private async post(path: string, body: unknown, what: string): Promise<any> {
    return jsonOrThrow(await authedFetch(this.tm, `${API}${path}`, { method: 'POST', body: JSON.stringify(body) }), what);
  }

  async account(): Promise<AccountInfo> {
    if (!this.me) {
      const profile = await this.get('/profile', 'Reading your Gmail profile');
      this.me = { kind: 'gmail', email: String(profile.emailAddress).toLowerCase(), name: this.tm.current.name || profile.emailAddress };
    }
    return this.me;
  }

  private async labelMap(force = false): Promise<Map<string, string>> {
    if (!this.labels || force) {
      const data = await this.get('/labels', 'Reading your Gmail labels');
      this.labels = new Map((data.labels || []).filter((l: any) => l.type === 'user').map((l: any) => [l.id, l.name]));
    }
    return this.labels;
  }

  private toMessage(msg: GmailMsg, labels: Map<string, string>): MailMessage {
    const ids = msg.labelIds || [];
    const from = parsePerson(header(msg, 'From'));
    const tierNames = new Set(Object.values(TIER_NAMES));
    const folderId = ids.find((id) => labels.has(id) && !tierNames.has(labels.get(id)!)) || null;
    const subject = header(msg, 'Subject') || '(no subject)';
    this.extra.set(msg.id, { messageId: header(msg, 'Message-ID'), references: header(msg, 'References') });
    return {
      id: msg.id,
      threadId: msg.threadId,
      from,
      to: parsePeople(header(msg, 'To')),
      cc: parsePeople(header(msg, 'Cc')),
      subject,
      snippet: (msg.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      date: Number(msg.internalDate) || Date.parse(header(msg, 'Date')) || Date.now(),
      isRead: !ids.includes('UNREAD'),
      flagged: ids.includes('STARRED'),
      hasAttachments: /multipart\/mixed/i.test(header(msg, 'Content-Type')),
      inInbox: ids.includes('INBOX'),
      inTrash: ids.includes('TRASH'),
      folderId,
      isBulk: ids.some((id) => BULK_CATEGORIES.includes(id)) || looksBulk(from.email, {
        listUnsubscribe: header(msg, 'List-Unsubscribe'), precedence: header(msg, 'Precedence'), autoSubmitted: header(msg, 'Auto-Submitted'),
      }),
      isSent: ids.includes('SENT'),
      importance: ids.includes('IMPORTANT') ? 'high' : 'normal',
      webLink: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(this.me?.email || '')}#all/${msg.threadId}`,
    };
  }

  private async metadata(ids: string[], refresh = false): Promise<{ found: MailMessage[]; missing: string[] }> {
    const labels = await this.labelMap();
    const missing: string[] = [];
    const found = await mapLimit(ids, 8, async (id) => {
      if (!refresh && this.meta.has(id)) return this.meta.get(id)!;
      const response = await authedFetch(this.tm, `${API}/messages/${id}?format=metadata&${HEADERS.map((h) => `metadataHeaders=${h}`).join('&')}`);
      if (response.status === 404) { missing.push(id); this.meta.delete(id); return null; }
      const message = this.toMessage(await jsonOrThrow(response, 'Reading an email'), labels);
      this.meta.set(id, message);
      return message;
    });
    return { found: found.filter((m): m is MailMessage => Boolean(m)), missing };
  }

  private async listIds(query: string, max: number, labelIds: string[] = []): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = '';
    while (ids.length < max) {
      const params = new URLSearchParams({ maxResults: String(Math.min(100, max - ids.length)) });
      if (query) params.set('q', query);
      labelIds.forEach((l) => params.append('labelIds', l));
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.get(`/messages?${params}`, 'Listing emails');
      ids.push(...(data.messages || []).map((m: { id: string }) => m.id));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return ids;
  }

  private toSent(m: MailMessage): SentMessage {
    const extra = this.extra.get(m.id);
    const kind = isForwardSubject(m.subject) ? 'forward' : (isReplySubject(m.subject) || extra?.references ? 'reply' : 'new');
    return { id: m.id, threadId: m.threadId, to: [...m.to, ...m.cc], subject: m.subject, date: m.date, kind };
  }

  async pull(cursor: string | null): Promise<PullResult> {
    await this.account();
    if (cursor) {
      try {
        return await this.pullHistory(cursor);
      } catch (error) {
        if (!/\(404\)/.test(String((error as Error).message))) throw error;
        // history too old: fall through to a full resync
      }
    }
    const profile = await this.get('/profile', 'Reading your Gmail profile');
    await this.labelMap(true);
    const inboxIds = await this.listIds('newer_than:21d', 150, ['INBOX']);
    const sentIds = await this.listIds('in:sent newer_than:2d', 40);
    const { found } = await this.metadata([...inboxIds, ...sentIds], true);
    const sentSet = new Set(sentIds);
    return {
      cursor: String(profile.historyId),
      upserts: found.filter((m) => !sentSet.has(m.id) || m.inInbox),
      removedIds: [],
      sent: found.filter((m) => sentSet.has(m.id)).map((m) => this.toSent(m)),
      full: true,
    };
  }

  private async pullHistory(cursor: string): Promise<PullResult> {
    const changed = new Set<string>();
    const added = new Set<string>();
    const deleted = new Set<string>();
    let pageToken = '';
    let latest = cursor;
    do {
      const params = new URLSearchParams({ startHistoryId: cursor, maxResults: '500' });
      ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'].forEach((t) => params.append('historyTypes', t));
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.get(`/history?${params}`, 'Checking for new email');
      for (const h of data.history || []) {
        for (const a of h.messagesAdded || []) { changed.add(a.message.id); added.add(a.message.id); }
        for (const d of h.messagesDeleted || []) deleted.add(d.message.id);
        for (const l of [...(h.labelsAdded || []), ...(h.labelsRemoved || [])]) changed.add(l.message.id);
      }
      latest = data.historyId || latest;
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    deleted.forEach((id) => changed.delete(id));
    const { found, missing } = await this.metadata([...changed], true);
    const sent = found.filter((m) => m.isSent && added.has(m.id)).map((m) => this.toSent(m));
    return {
      cursor: String(latest),
      upserts: found.filter((m) => !m.isSent || m.inInbox),
      removedIds: [...deleted, ...missing],
      sent,
      full: false,
    };
  }

  async history(days: number, max: number): Promise<MailMessage[]> {
    await this.account();
    const ids = await this.listIds(`newer_than:${days}d -in:sent -in:chats -in:drafts -in:spam`, max);
    return (await this.metadata(ids)).found;
  }

  async sentHistory(days: number, max: number): Promise<SentMessage[]> {
    const ids = await this.listIds(`in:sent newer_than:${days}d`, max);
    return (await this.metadata(ids)).found.map((m) => this.toSent(m));
  }

  async folders(): Promise<Folder[]> {
    const labels = await this.labelMap(true);
    const hidden = new Set(Object.values(TIER_NAMES));
    return [...labels].filter(([, name]) => !hidden.has(name)).map(([id, name]) => ({ id, name }));
  }

  async folderMessages(folderId: string, max: number): Promise<MailMessage[]> {
    const ids = await this.listIds('', max, [folderId]);
    return (await this.metadata(ids)).found;
  }

  private parseBody(part: GmailPart | undefined): MailBody {
    let plain = '';
    let html = '';
    const attachments: Attachment[] = [];
    const walk = (p?: GmailPart) => {
      if (!p) return;
      if (p.filename && (p.body?.attachmentId || p.body?.data)) attachments.push({ name: p.filename, size: p.body.size || 0, mimeType: p.mimeType });
      else if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = base64UrlDecode(p.body.data);
      else if (p.mimeType === 'text/html' && p.body?.data && !html) html = base64UrlDecode(p.body.data);
      p.parts?.forEach(walk);
    };
    walk(part);
    return { text: (plain || htmlToText(html)).trim(), attachments };
  }

  async body(message: MailMessage): Promise<MailBody> {
    const msg: GmailMsg = await this.get(`/messages/${message.id}?format=full`, 'Opening the email');
    return this.parseBody(msg.payload);
  }

  async thread(threadId: string): Promise<FullMessage[]> {
    const labels = await this.labelMap();
    const data = await this.get(`/threads/${threadId}?format=full`, 'Opening the conversation');
    return (data.messages || []).map((m: GmailMsg) => ({ ...this.toMessage(m, labels), body: this.parseBody(m.payload) }));
  }

  private async send(raw: string, threadId?: string): Promise<void> {
    await this.post('/messages/send', { raw: base64UrlEncode(raw), ...(threadId ? { threadId } : {}) }, 'Sending');
  }

  async reply(message: MailMessage, text: string, replyAll: boolean): Promise<void> {
    const me = await this.account();
    let extra = this.extra.get(message.id);
    if (!extra?.messageId) { await this.metadata([message.id], true); extra = this.extra.get(message.id); }
    const notMe = (p: Person) => p.email !== me.email;
    const to = message.from.email === me.email ? message.to : [message.from];
    const cc = replyAll ? [...message.to, ...message.cc].filter(notMe).filter((p) => !to.some((t) => t.email === p.email)) : [];
    const subject = isReplySubject(message.subject) ? message.subject : `Re: ${message.subject}`;
    const lines = [
      `To: ${to.map(encodeAddress).join(', ')}`,
      ...(cc.length ? [`Cc: ${cc.map(encodeAddress).join(', ')}`] : []),
      `Subject: ${encodeHeader(subject)}`,
      ...(extra?.messageId ? [`In-Reply-To: ${extra.messageId}`, `References: ${[extra.references, extra.messageId].filter(Boolean).join(' ')}`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(textToBase64(text)),
    ];
    await this.send(lines.join('\r\n'), message.threadId);
  }

  async forward(message: MailMessage, to: Person[], note: string): Promise<void> {
    const full: GmailMsg = await this.get(`/messages/${message.id}?format=full`, 'Reading the email to forward');
    const body = this.parseBody(full.payload);
    const quoted = [
      note, '', '---------- Forwarded message ---------',
      `From: ${formatPerson(message.from)}`, `Date: ${new Date(message.date).toString()}`,
      `Subject: ${message.subject}`, `To: ${message.to.map(formatPerson).join(', ')}`, '', body.text,
    ].join('\n');
    const boundary = `pa_${Math.random().toString(36).slice(2)}`;
    const parts: string[] = [
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      wrap76(textToBase64(quoted)),
    ];
    // carry the original attachments along (submittals, drawings, invoices)
    const files: GmailPart[] = [];
    const walk = (p?: GmailPart) => { if (!p) return; if (p.filename && p.body?.attachmentId) files.push(p); p.parts?.forEach(walk); };
    walk(full.payload);
    for (const file of files) {
      const data = await this.get(`/messages/${message.id}/attachments/${file.body!.attachmentId}`, 'Reading an attachment');
      const b64 = String(data.data).replace(/-/g, '+').replace(/_/g, '/');
      parts.push(`--${boundary}`, `Content-Type: ${file.mimeType || 'application/octet-stream'}; name="${encodeHeader(file.filename!)}"`,
        `Content-Disposition: attachment; filename="${encodeHeader(file.filename!)}"`, 'Content-Transfer-Encoding: base64', '', wrap76(b64));
    }
    parts.push(`--${boundary}--`);
    const subject = isForwardSubject(message.subject) ? message.subject : `Fwd: ${cleanSubject(message.subject)}`;
    const raw = [`To: ${to.map(encodeAddress).join(', ')}`, `Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
    await this.send(raw, message.threadId);
  }

  private async modify(message: MailMessage, add: string[], remove: string[]): Promise<void> {
    await this.post(`/messages/${message.id}/modify`, { addLabelIds: add, removeLabelIds: remove }, 'Updating the email');
    this.meta.delete(message.id);
  }

  async moveToFolder(message: MailMessage, folderId: string) { await this.modify(message, [folderId], ['INBOX']); }

  async moveToInbox(message: MailMessage) {
    if (message.inTrash) await this.post(`/messages/${message.id}/untrash`, {}, 'Restoring the email');
    await this.modify(message, ['INBOX'], message.folderId ? [message.folderId] : []);
  }

  async trash(message: MailMessage) { await this.post(`/messages/${message.id}/trash`, {}, 'Moving to trash'); this.meta.delete(message.id); }
  async archive(message: MailMessage) { await this.modify(message, [], ['INBOX']); }
  async markRead(message: MailMessage, read: boolean) { await this.modify(message, read ? [] : ['UNREAD'], read ? ['UNREAD'] : []); }
  async setFlag(message: MailMessage, flagged: boolean) { await this.modify(message, flagged ? ['STARRED'] : [], flagged ? [] : ['STARRED']); }

  async ensureFolder(name: string, color?: { backgroundColor: string; textColor: string }): Promise<Folder> {
    const labels = await this.labelMap();
    const existing = [...labels].find(([, n]) => n.toLowerCase() === name.toLowerCase());
    if (existing) return { id: existing[0], name: existing[1] };
    const created = await this.post('/labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show', ...(color ? { color } : {}) }, `Creating the "${name}" label`);
    labels.set(created.id, created.name);
    return { id: created.id, name: created.name };
  }

  async setTier(message: MailMessage, tier: Tier | null): Promise<void> {
    const urgent = await this.ensureFolder(TIER_NAMES.urgent, TIER_COLORS.urgent);
    const important = await this.ensureFolder(TIER_NAMES.important, TIER_COLORS.important);
    const add = tier === 'urgent' ? [urgent.id] : tier === 'important' ? [important.id] : [];
    const remove = [urgent.id, important.id].filter((id) => !add.includes(id));
    await this.modify(message, add, remove);
  }

  private async findSyncFile(): Promise<string | null> {
    if (this.syncFileId) return this.syncFileId;
    const q = encodeURIComponent(`name='${SYNC_FILE}'`);
    const data = await jsonOrThrow(await authedFetch(this.tm, `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`), 'Finding your saved assistant data');
    this.syncFileId = data.files?.[0]?.id || null;
    return this.syncFileId;
  }

  async loadSyncDoc(): Promise<string | null> {
    const id = await this.findSyncFile();
    if (!id) return null;
    const response = await authedFetch(this.tm, `${DRIVE}/files/${id}?alt=media`);
    if (response.status === 404) { this.syncFileId = null; return null; }
    if (!response.ok) await jsonOrThrow(response, 'Loading your saved assistant data');
    return response.text();
  }

  async saveSyncDoc(json: string): Promise<void> {
    const id = await this.findSyncFile();
    if (id) {
      await jsonOrThrow(await authedFetch(this.tm, `${DRIVE_UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', body: json, headers: { 'Content-Type': 'application/json' } }), 'Saving assistant data');
      return;
    }
    const boundary = `pa_${Math.random().toString(36).slice(2)}`;
    const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'] }),
      `--${boundary}`, 'Content-Type: application/json', '', json, `--${boundary}--`].join('\r\n');
    const created = await jsonOrThrow(await authedFetch(this.tm, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    }), 'Saving assistant data');
    this.syncFileId = created.id;
  }
}
