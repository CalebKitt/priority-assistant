/* Outlook (Microsoft 365 work/school and personal outlook.com) via Microsoft Graph. Uses immutable IDs so a
   message keeps its id when moved, delta queries for incremental sync, and OneDrive's app folder for the
   learned-state file. */
import type { AccountInfo, Folder, FullMessage, MailBody, MailMessage, Person, PullResult, SentMessage, Tier } from '../types';
import { authedFetch, jsonOrThrow, type TokenManager } from '../auth';
import { htmlToText, mapLimit } from '../util';
import { isForwardSubject, isReplySubject, looksBulk, TIER_NAMES, type MailProvider } from './provider';

const API = 'https://graph.microsoft.com/v1.0/me';
const SYNC_PATH = '/drive/special/approot:/priority-assistant.json:/content';
const SELECT = 'id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,receivedDateTime,isRead,flag,hasAttachments,parentFolderId,importance,webLink,inferenceClassification';
const TIER_PRESETS: Record<Tier, string> = { urgent: 'preset0', important: 'preset1' }; // red, orange

interface GraphRecipient { emailAddress?: { name?: string; address?: string } }
interface GraphMsg {
  id: string; conversationId: string; from?: GraphRecipient; sender?: GraphRecipient; toRecipients?: GraphRecipient[]; ccRecipients?: GraphRecipient[];
  subject?: string; bodyPreview?: string; receivedDateTime?: string; sentDateTime?: string; isRead?: boolean; flag?: { flagStatus?: string };
  hasAttachments?: boolean; parentFolderId?: string; importance?: 'low' | 'normal' | 'high'; webLink?: string; inferenceClassification?: string;
  body?: { contentType: string; content: string }; categories?: string[]; '@removed'?: unknown;
}

const person = (r?: GraphRecipient): Person => ({ name: r?.emailAddress?.name || r?.emailAddress?.address || 'Unknown', email: String(r?.emailAddress?.address || '').toLowerCase() });
const recipient = (p: Person) => ({ emailAddress: { address: p.email, name: p.name } });
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

export class OutlookProvider implements MailProvider {
  readonly kind = 'outlook' as const;
  private wellKnown: Record<string, string> | null = null;
  private me: AccountInfo | null = null;

  constructor(private tm: TokenManager) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=50', ...extra };
  }

  private async call(path: string, what: string, init: RequestInit = {}): Promise<any> {
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    return jsonOrThrow(await authedFetch(this.tm, url, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string> || {}) } }), what);
  }

  async account(): Promise<AccountInfo> {
    if (!this.me) {
      const data = await jsonOrThrow(await authedFetch(this.tm, 'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName'), 'Reading your Outlook profile');
      this.me = { kind: 'outlook', email: String(data.mail || data.userPrincipalName).toLowerCase(), name: data.displayName || data.mail };
    }
    return this.me;
  }

  private async folderIds(): Promise<Record<string, string>> {
    if (!this.wellKnown) {
      const names = ['inbox', 'deleteditems', 'archive', 'sentitems', 'drafts', 'junkemail', 'outbox'];
      const ids: Record<string, string> = {};
      await Promise.all(names.map(async (name) => {
        const response = await authedFetch(this.tm, `${API}/mailFolders/${name}?$select=id`);
        if (response.ok) ids[name] = (await response.json()).id;
      }));
      this.wellKnown = ids;
    }
    return this.wellKnown;
  }

  private toMessage(m: GraphMsg, wk: Record<string, string>): MailMessage {
    const from = person(m.from || m.sender);
    const parent = m.parentFolderId || '';
    const system = new Set(Object.values(wk));
    return {
      id: m.id,
      threadId: m.conversationId,
      from,
      to: (m.toRecipients || []).map(person),
      cc: (m.ccRecipients || []).map(person),
      subject: m.subject || '(no subject)',
      snippet: (m.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 200),
      date: Date.parse(m.receivedDateTime || m.sentDateTime || '') || Date.now(),
      isRead: Boolean(m.isRead),
      flagged: m.flag?.flagStatus === 'flagged',
      hasAttachments: Boolean(m.hasAttachments),
      inInbox: parent === wk.inbox,
      inTrash: parent === wk.deleteditems,
      folderId: parent && !system.has(parent) ? parent : null,
      isBulk: m.inferenceClassification === 'other' || looksBulk(from.email, {}),
      isSent: parent === wk.sentitems,
      importance: m.importance,
      webLink: m.webLink,
    };
  }

  private toSent(m: GraphMsg): SentMessage {
    const subject = m.subject || '';
    return {
      id: m.id, threadId: m.conversationId, subject,
      to: [...(m.toRecipients || []), ...(m.ccRecipients || [])].map(person),
      date: Date.parse(m.sentDateTime || m.receivedDateTime || '') || Date.now(),
      kind: isForwardSubject(subject) ? 'forward' : isReplySubject(subject) ? 'reply' : 'new',
    };
  }

  /** Follow a delta query to its end; returns items and the new deltaLink. */
  private async delta(start: string): Promise<{ items: GraphMsg[]; deltaLink: string }> {
    const items: GraphMsg[] = [];
    let url = start;
    for (let pages = 0; pages < 60; pages++) {
      const data = await this.call(url, 'Checking for new email');
      items.push(...(data.value || []));
      if (data['@odata.deltaLink']) return { items, deltaLink: data['@odata.deltaLink'] };
      url = data['@odata.nextLink'];
      if (!url) break;
    }
    throw new Error('Outlook sync did not finish (too many pages). It will retry.');
  }

  async pull(cursor: string | null): Promise<PullResult> {
    const wk = await this.folderIds();
    let links: { inbox?: string; sent?: string } = {};
    try { links = cursor ? JSON.parse(cursor) : {}; } catch { links = {}; }
    const full = !links.inbox;
    const inboxStart = links.inbox || `${API}/mailFolders/inbox/messages/delta?$select=${SELECT}&$filter=receivedDateTime+ge+${iso(21)}`;
    const sentStart = links.sent || `${API}/mailFolders/sentitems/messages/delta?$select=${SELECT},sentDateTime&$filter=receivedDateTime+ge+${iso(2)}`;
    let inbox: { items: GraphMsg[]; deltaLink: string };
    let sent: { items: GraphMsg[]; deltaLink: string };
    try {
      [inbox, sent] = await Promise.all([this.delta(inboxStart), this.delta(sentStart)]);
    } catch (error) {
      if (cursor && /\((410|400)\)/.test(String((error as Error).message))) return this.pull(null); // delta token expired
      throw error;
    }
    // Items that left the inbox (moved/archived/deleted), plus any partial change records: look each one up.
    const lookup = inbox.items.filter((m) => m['@removed'] || m.subject === undefined).map((m) => m.id);
    const upserts = inbox.items.filter((m) => !m['@removed'] && m.subject !== undefined).map((m) => this.toMessage(m, wk));
    const removedIds: string[] = [];
    await mapLimit(lookup, 6, async (id) => {
      const response = await authedFetch(this.tm, `${API}/messages/${id}?$select=${SELECT}`, { headers: this.headers() });
      if (response.status === 404) { removedIds.push(id); return; }
      if (response.ok) upserts.push(this.toMessage(await response.json(), wk));
    });
    return {
      cursor: JSON.stringify({ inbox: inbox.deltaLink, sent: sent.deltaLink }),
      upserts,
      removedIds,
      sent: full ? [] : sent.items.filter((m) => !m['@removed'] && m.subject !== undefined).map((m) => this.toSent(m)),
      full,
    };
  }

  private async pages(path: string, max: number, what: string): Promise<GraphMsg[]> {
    const out: GraphMsg[] = [];
    let url: string | undefined = path;
    while (url && out.length < max) {
      const data = await this.call(url, what);
      out.push(...(data.value || []));
      url = data['@odata.nextLink'];
    }
    return out.slice(0, max);
  }

  async history(days: number, max: number): Promise<MailMessage[]> {
    const wk = await this.folderIds();
    const skip = new Set([wk.sentitems, wk.drafts, wk.junkemail, wk.outbox]);
    const items = await this.pages(`/messages?$select=${SELECT}&$filter=receivedDateTime+ge+${iso(days)}&$orderby=receivedDateTime+desc&$top=50`, max, 'Reading recent email');
    return items.filter((m) => !skip.has(m.parentFolderId || '')).map((m) => this.toMessage(m, wk));
  }

  async sentHistory(days: number, max: number): Promise<SentMessage[]> {
    const items = await this.pages(`/mailFolders/sentitems/messages?$select=${SELECT},sentDateTime&$filter=sentDateTime+ge+${iso(days)}&$orderby=sentDateTime+desc&$top=50`, max, 'Reading sent email');
    return items.map((m) => this.toSent(m));
  }

  async folders(): Promise<Folder[]> {
    const wk = await this.folderIds();
    const system = new Set(Object.values(wk));
    const out: Folder[] = [];
    const walk = async (path: string, prefix: string, depth: number) => {
      const data = await this.call(`${path}?$select=id,displayName,childFolderCount&$top=200`, 'Reading your Outlook folders');
      for (const f of data.value || []) {
        const name = prefix ? `${prefix}/${f.displayName}` : f.displayName;
        if (!system.has(f.id) && !/^(conversation history|rss|sync issues|scheduled|clutter|notes|outbox)/i.test(f.displayName)) out.push({ id: f.id, name });
        if (f.childFolderCount > 0 && depth < 3) await walk(`/mailFolders/${f.id}/childFolders`, f.id === wk.inbox ? '' : name, depth + 1);
      }
    };
    await walk('/mailFolders', '', 0);
    return out;
  }

  async folderMessages(folderId: string, max: number): Promise<MailMessage[]> {
    const wk = await this.folderIds();
    const items = await this.pages(`/mailFolders/${folderId}/messages?$select=${SELECT}&$orderby=receivedDateTime+desc&$top=50`, max, 'Reading a folder');
    return items.map((m) => this.toMessage(m, wk));
  }

  async body(message: MailMessage): Promise<MailBody> {
    const [msg, atts] = await Promise.all([
      this.call(`/messages/${message.id}?$select=body`, 'Opening the email'),
      message.hasAttachments ? this.call(`/messages/${message.id}/attachments?$select=name,size,contentType`, 'Reading attachments') : Promise.resolve({ value: [] }),
    ]);
    const text = msg.body?.contentType === 'html' ? htmlToText(msg.body.content) : String(msg.body?.content || '');
    return { text: text.trim(), attachments: (atts.value || []).map((a: any) => ({ name: a.name, size: a.size, mimeType: a.contentType })) };
  }

  async thread(threadId: string): Promise<FullMessage[]> {
    const wk = await this.folderIds();
    const filter = encodeURIComponent(`conversationId eq '${threadId.replace(/'/g, "''")}'`);
    const items = await this.pages(`/messages?$select=${SELECT},body,sentDateTime&$filter=${filter}&$top=50`, 100, 'Opening the conversation');
    return items
      .map((m) => ({ ...this.toMessage(m, wk), body: { text: m.body?.contentType === 'html' ? htmlToText(m.body.content) : String(m.body?.content || ''), attachments: [] } }))
      .sort((a, b) => a.date - b.date);
  }

  async reply(message: MailMessage, text: string, replyAll: boolean): Promise<void> {
    await this.call(`/messages/${message.id}/${replyAll ? 'replyAll' : 'reply'}`, 'Sending your reply', { method: 'POST', body: JSON.stringify({ comment: text }) });
  }

  async forward(message: MailMessage, to: Person[], note: string): Promise<void> {
    await this.call(`/messages/${message.id}/forward`, 'Forwarding', { method: 'POST', body: JSON.stringify({ comment: note, toRecipients: to.map(recipient) }) });
  }

  private async move(message: MailMessage, destinationId: string) {
    await this.call(`/messages/${message.id}/move`, 'Moving the email', { method: 'POST', body: JSON.stringify({ destinationId }) });
  }

  async moveToFolder(message: MailMessage, folderId: string) { await this.move(message, folderId); }
  async moveToInbox(message: MailMessage) { await this.move(message, 'inbox'); }
  async trash(message: MailMessage) { await this.move(message, 'deleteditems'); }
  async archive(message: MailMessage) { await this.move(message, 'archive'); }

  private async patch(message: MailMessage, body: unknown) {
    await this.call(`/messages/${message.id}`, 'Updating the email', { method: 'PATCH', body: JSON.stringify(body) });
  }

  async markRead(message: MailMessage, read: boolean) { await this.patch(message, { isRead: read }); }
  async setFlag(message: MailMessage, flagged: boolean) { await this.patch(message, { flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } }); }

  async ensureFolder(name: string): Promise<Folder> {
    const filter = encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`);
    const found = await this.call(`/mailFolders?$filter=${filter}&$select=id,displayName`, 'Finding a folder');
    if (found.value?.[0]) return { id: found.value[0].id, name: found.value[0].displayName };
    const created = await this.call('/mailFolders', `Creating the "${name}" folder`, { method: 'POST', body: JSON.stringify({ displayName: name }) });
    return { id: created.id, name: created.displayName };
  }

  private categoriesReady = false;
  private async ensureCategories() {
    if (this.categoriesReady) return;
    const data = await this.call('/outlook/masterCategories', 'Reading Outlook categories');
    const have = new Set((data.value || []).map((c: any) => c.displayName));
    for (const tier of ['urgent', 'important'] as Tier[]) {
      if (!have.has(TIER_NAMES[tier])) {
        await this.call('/outlook/masterCategories', 'Creating a priority category', { method: 'POST', body: JSON.stringify({ displayName: TIER_NAMES[tier], color: TIER_PRESETS[tier] }) });
      }
    }
    this.categoriesReady = true;
  }

  async setTier(message: MailMessage, tier: Tier | null): Promise<void> {
    await this.ensureCategories();
    const current = await this.call(`/messages/${message.id}?$select=categories`, 'Reading categories');
    const ours = new Set(Object.values(TIER_NAMES));
    const next = (current.categories || []).filter((c: string) => !ours.has(c));
    if (tier) next.push(TIER_NAMES[tier]);
    await this.patch(message, { categories: next });
  }

  /** Outlook on the web opens messages by EWS id; translate our immutable id so the email opens in this tab. */
  async webPath(message: MailMessage): Promise<string | null> {
    const data = await this.call('/translateExchangeIds', 'Finding the email in Outlook', {
      method: 'POST', body: JSON.stringify({ inputIds: [message.id], sourceIdType: 'restImmutableEntryId', targetIdType: 'ewsId' }),
    });
    const ews = data.value?.[0]?.targetId;
    return ews ? `/mail/inbox/id/${encodeURIComponent(ews)}` : null;
  }

  async loadSyncDoc(): Promise<string | null> {
    const response = await authedFetch(this.tm, `${API}${SYNC_PATH}`);
    if (response.status === 404) return null;
    if (!response.ok) await jsonOrThrow(response, 'Loading your saved assistant data');
    return response.text();
  }

  async saveSyncDoc(json: string): Promise<void> {
    await jsonOrThrow(await authedFetch(this.tm, `${API}${SYNC_PATH}`, { method: 'PUT', body: json, headers: { 'Content-Type': 'application/json' } }), 'Saving assistant data');
  }
}
