/* AssistantService: one per connected mailbox. Watches what the user does (via the mailbox API, so actions taken
   in Gmail/Outlook, on the phone or in the mail apps all count), learns from it, ranks the inbox, files mail once
   it is confident, and builds the view the extension and phone app draw. Nothing is ever sent automatically. */
import type { AccountInfo, Analysis, Decision, DecisionKind, FullMessage, MailMessage, MovedItem, Person, Settings, Task, ThreadSummary, Tier } from './types';
import type { MailProvider } from './providers/provider';
import { CC_FOLDER } from './providers/provider';
import {
  ASSIST_THRESHOLD, emptyState, matchRate, mergeSynced, MIN_COMPARISONS, parseSynced, serializeSynced,
  type AccountState, type KV, type Mode, type Tracked,
} from './state';
import { describeFeature, featuresOf } from './learn/features';
import { examplesFrom, FolderModel, ForwardModel, NEGATIVE, POSITIVE, PriorityModel, type FolderExample } from './learn/models';
import { analyzeEmail, askAboutEmail, dailyBrief, fallbackVoiceReply, Gemini, heuristicAnalysis, polishVoiceReply, summarizeThread, type DailyBrief } from './ai';
import { checkSend, type SendCheck } from './sensitive';
import { domainOf, firstName, plural, stripQuoted } from './util';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PRIORITY_CAP = 15;
const AUTO_FILE_P = 0.9;

export interface Suggestion { type: 'reply' | 'forward' | 'remind' | 'call' | 'file'; label: string; why: string; to?: Person; folder?: string }

export interface RowVM {
  id: string; threadId: string; from: string; fromEmail: string; subject: string; snippet: string; date: number;
  unread: boolean; flagged: boolean; attachment: boolean; cc: boolean; bulk: boolean;
  priority: boolean; tier: Tier | null; rank: number; score: number; reason: string;
  suggestion: Suggestion | null; handled: { type: string; to?: string } | null;
  analysis: Pick<Analysis, 'headline' | 'nextStep' | 'bullets' | 'action' | 'due' | 'phone'> | null;
  threadCount: number; webLink?: string; senderPref: 'always' | 'later' | null; folderName?: string;
  task: Task | null;
}

export interface CalendarItem { id: string; at: number; title: string; sub: string; msgId: string; kind: 'reminder' | 'due' | 'nudge'; done: boolean; overdue: boolean }

export interface View {
  account: AccountInfo;
  mode: Mode; modeSetBy: 'auto' | 'user';
  status: { syncing: boolean; learning: boolean; lastSync: number; error: string; ai: boolean; backfilled: boolean };
  priority: RowVM[]; others: RowVM[]; cc: RowVM[];
  featured: RowVM | null; upNext: RowVM[];
  calendar: CalendarItem[]; tasks: Task[]; moved: MovedItem[];
  learning: { rate: number; n: number; needed: number; folderRate: number; notes: string[]; stats: Array<[string, number]> };
  confidence: { value: number; lastLearned: string; why: Array<{ who: string; why: string }> };
  coworkers: Person[]; folders: string[];
  settings: Settings;
}

export type Action =
  | { type: 'make-priority' | 'not-priority' | 'later' | 'done' | 'undone' | 'trash' | 'restore' | 'archive' | 'opened' | 'dismiss'; id: string }
  | { type: 'sender-pref'; email: string; name: string; pref: 'always' | 'later' | null }
  | { type: 'reply'; id: string; text: string; replyAll?: boolean; edited?: boolean }
  | { type: 'forward'; id: string; to: Person[]; note: string }
  | { type: 'remind'; id: string; due: number }
  | { type: 'task-done'; taskId: string; done: boolean }
  | { type: 'undo-move'; id: string }
  | { type: 'file'; id: string; folder: string }
  | { type: 'set-mode'; mode: Mode }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'sync' }
  | { type: 'simulate-arrival' };

export class AssistantService {
  private priorityModel = new PriorityModel();
  private folderModel = new FolderModel();
  private forwardModel = new ForwardModel();
  private folderIdByName = new Map<string, string>();
  private folderNameById = new Map<string, string>();
  private syncing: Promise<void> | null = null;
  private enriching = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private dismissed = new Set<string>();
  private brief: DailyBrief | null = null;
  private learningNow = false;

  private constructor(readonly provider: MailProvider, private kv: KV, readonly ai: Gemini, public state: AccountState) {}

  static async open(provider: MailProvider, kv: KV, ai: Gemini): Promise<AssistantService> {
    const account = await provider.account();
    const saved = await kv.get<AccountState>(`acct:${account.email}`);
    const state = saved?.v === 1 ? { ...emptyState(account), ...saved, account } : emptyState(account);
    const service = new AssistantService(provider, kv, ai, state);
    service.retrain();
    return service;
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((fn) => { try { fn(); } catch (error) { console.error('Assistant listener failed', error); } }); }

  private persist(now = false) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const write = () => { this.saveTimer = null; void this.kv.set(`acct:${this.state.account.email}`, this.state); };
    if (now) write(); else this.saveTimer = setTimeout(write, 400);
  }

  private changed(dirty = true) {
    if (dirty) this.state.dirty = true;
    this.persist();
    this.emit();
  }

  get me() { return this.state.account; }
  private feats(m: MailMessage) { return featuresOf(m, { me: this.me.email }); }
  private isCcOnly(m: MailMessage) { const me = this.me.email; return !m.to.some((p) => p.email === me) && m.cc.some((p) => p.email === me); }

  /* ------------------------------------------------------------------ learning */

  private retrain() {
    const decisions = this.state.synced.decisions;
    this.priorityModel.train(examplesFrom(decisions));
    const folderExamples: FolderExample[] = [];
    const seen = new Set<string>();
    for (const d of [...decisions].reverse()) {
      if (seen.has(d.msgId)) continue;
      if (d.kind === 'filed' && d.folder) { folderExamples.push({ features: d.features, folder: d.folder }); seen.add(d.msgId); }
      else if (['replied', 'read-only', 'ignored', 'flagged', 'made-priority'].includes(d.kind)) { folderExamples.push({ features: d.features, folder: '' }); seen.add(d.msgId); }
    }
    this.folderModel.train(folderExamples);
    this.forwardModel.train(decisions);
  }

  /** Model score with the user's explicit overrides applied. */
  private scoreOf(m: MailMessage, features = this.feats(m)): { p: number; source: 'manual' | 'always' | 'later' | 'model' } {
    const manual = this.state.synced.manual[m.id];
    if (manual) return { p: manual.priority ? 0.97 : 0.03, source: 'manual' };
    const pref = this.state.synced.senderPrefs[m.from.email]?.pref;
    if (pref === 'always') return { p: Math.max(0.9, this.priorityModel.score(features)), source: 'always' };
    if (pref === 'later') return { p: Math.min(0.1, this.priorityModel.score(features)), source: 'later' };
    if (!this.priorityModel.trainedOn) return { p: this.coldStartScore(features), source: 'model' };
    return { p: this.priorityModel.score(features), source: 'model' };
  }

  /** Before any learning: direct, personal, human mail first. */
  private coldStartScore(f: string[]): number {
    let z = -0.6;
    if (f.includes('direct')) z += 0.8;
    if (f.includes('only-me')) z += 0.4;
    if (f.includes('bulk')) z -= 2;
    if (f.includes('cc-only')) z -= 0.6;
    if (f.includes('question')) z += 0.4;
    if (f.includes('deadline-words') || f.includes('urgent-words')) z += 0.6;
    return 1 / (1 + Math.exp(-z));
  }

  private predict(m: MailMessage) {
    const f = this.feats(m);
    const { p } = this.scoreOf(m, f);
    const folder = this.folderModel.predict(f);
    return { priority: p >= 0.5, p, folder: folder.folder && folder.p >= 0.85 ? folder.folder : null, at: Date.now() };
  }

  private decide(t: Tracked, kind: DecisionKind, extra: Partial<Decision> = {}, source: Decision['source'] = 'observed') {
    const id = `${t.m.id}:${kind}`;
    const s = this.state.synced;
    if (s.decisions.some((d) => d.id === id)) return;
    const decision: Decision = {
      id, msgId: t.m.id, kind, at: Date.now(), arrived: t.m.date, sender: t.m.from.email, features: this.feats(t.m), source,
      predictedPriority: t.predicted?.priority, predictedFolder: t.predicted?.folder ?? null, wasRead: t.m.isRead || Boolean(t.readAt), ...extra,
    };
    s.decisions.push(decision);
    if (s.decisions.length > 2000) s.decisions.splice(0, s.decisions.length - 2000);
    // Shadow mode: compare the guess made before the user acted with what they actually did.
    const decisive = POSITIVE.includes(kind) || NEGATIVE.includes(kind);
    if (t.predicted && decisive && !t.outcome) {
      s.matches.push({ at: decision.at, ok: t.predicted.priority === POSITIVE.includes(kind), kind: 'priority' });
      if (kind === 'filed' || t.predicted.folder) s.matches.push({ at: decision.at + 1, ok: (t.predicted.folder || '') === (kind === 'filed' ? extra.folder || '' : ''), kind: 'folder' });
      t.outcome = kind;
    }
    s.lastLearned = this.learnedLine(t.m, kind, extra);
    this.learningNow = true;
  }

  private learnedLine(m: MailMessage, kind: DecisionKind, extra: Partial<Decision>): string {
    const who = firstName(m.from.name);
    switch (kind) {
      case 'replied': return `Learned: you answer ${who}${extra.latencyMin !== undefined && extra.latencyMin < 90 ? ' quickly' : ''}`;
      case 'forwarded': return `Learned: emails like “${m.subject.slice(0, 40)}” go to ${extra.to?.split('@')[0] || 'a coworker'}`;
      case 'filed': return `Learned: ${who}'s emails belong in ${extra.folder}`;
      case 'trashed': case 'ignored': return `Learned: ${who}'s emails can wait`;
      case 'made-priority': return `Learned: ${who} can be priority`;
      case 'not-priority': case 'later': return `Learned: ${who} is not always priority`;
      default: return this.state.synced.lastLearned;
    }
  }

  private updateMode() {
    const s = this.state.synced;
    if (s.modeSetBy === 'user' || s.mode === 'assisting') return;
    const { rate, n } = matchRate(s.matches, 'priority');
    if (n >= MIN_COMPARISONS && rate >= ASSIST_THRESHOLD) {
      s.mode = 'assisting'; s.modeAt = Date.now(); s.modeSetBy = 'auto';
      s.lastLearned = `I now match your choices ${Math.round(rate * 100)}% of the time, so suggestions are on.`;
    }
  }

  /* ------------------------------------------------------------------ first run */

  /** Learn from the last 60 days before showing anything, so day one is not a blank slate. */
  async backfill(): Promise<void> {
    const s = this.state.synced;
    const [history, sent, folders] = await Promise.all([this.provider.history(60, 400), this.provider.sentHistory(60, 300), this.provider.folders()]);
    this.setFolders(folders);
    const sentByThread = new Map<string, typeof sent>();
    for (const m of sent) (sentByThread.get(m.threadId) || sentByThread.set(m.threadId, []).get(m.threadId)!).push(m);
    const now = Date.now();
    const decisions: Decision[] = [];
    const add = (m: MailMessage, kind: DecisionKind, extra: Partial<Decision> = {}) => decisions.push({
      id: `${m.id}:${kind}`, msgId: m.id, kind, at: extra.at || m.date + HOUR, arrived: m.date, sender: m.from.email, features: this.feats(m), source: 'backfill', wasRead: m.isRead, ...extra,
    });
    const ccName = CC_FOLDER.toLowerCase();
    this.state.senderNames = this.state.senderNames || {};
    for (const m of history) this.state.senderNames[m.from.email] = m.from.name;
    for (const m of history) {
      if (m.from.email === this.me.email) continue;
      const replies = (sentByThread.get(m.threadId) || []).filter((x) => x.date > m.date).sort((a, b) => a.date - b.date);
      const fwd = replies.find((x) => x.kind === 'forward');
      const reply = replies.find((x) => x.kind !== 'forward');
      const folderName = m.folderId ? this.folderNameById.get(m.folderId) : undefined;
      if (reply) add(m, 'replied', { at: reply.date, latencyMin: Math.round((reply.date - m.date) / MIN) });
      if (fwd) add(m, 'forwarded', { at: fwd.date, to: fwd.to[0]?.email, latencyMin: Math.round((fwd.date - m.date) / MIN) });
      if (folderName && folderName.toLowerCase() !== ccName) add(m, 'filed', { folder: folderName });
      if (!reply && !fwd && !folderName) {
        if (m.inTrash) add(m, 'trashed');
        else if (m.flagged) add(m, 'flagged');
        else if (!m.inInbox) add(m, 'archived');
        else if (now - m.date > DAY) add(m, m.isRead ? 'read-only' : 'ignored');
      }
    }
    // Your existing folders are the best teacher for auto-filing: learn what lives in each one.
    const seen = new Set(history.map((m) => m.id));
    for (const folder of folders.slice(0, 25)) {
      if (folder.name.toLowerCase() === ccName) continue;
      const msgs = await this.provider.folderMessages(folder.id, 40).catch(() => []);
      for (const m of msgs) if (!seen.has(m.id)) { seen.add(m.id); add(m, 'filed', { folder: folder.name }); }
    }
    for (const m of sent) for (const p of m.to) this.noteCoworker(p, m.date);

    // Holdout check: train on the older 70%, score the newest 30%. That is the starting match rate.
    decisions.sort((a, b) => a.at - b.at);
    const examples = examplesFrom(decisions).sort((a, b) => a.at - b.at);
    const cut = Math.floor(examples.length * 0.7);
    if (examples.length >= 20) {
      const trial = new PriorityModel();
      trial.train(examples.slice(0, cut));
      for (const ex of examples.slice(cut).slice(-40)) s.matches.push({ at: ex.at, ok: (trial.score(ex.features) >= 0.5) === (ex.y === 1), kind: 'priority' });
      const filed = decisions.filter((d) => d.kind === 'filed');
      if (filed.length >= 10) {
        const fcut = Math.floor(filed.length * 0.7);
        const fm = new FolderModel();
        fm.train(filed.slice(0, fcut).map((d) => ({ features: d.features, folder: d.folder! })));
        for (const d of filed.slice(fcut).slice(-30)) s.matches.push({ at: d.at, ok: fm.predict(d.features).folder === d.folder, kind: 'folder' });
      }
    }
    const existing = new Set(s.decisions.map((d) => d.id));
    s.decisions = [...decisions.filter((d) => !existing.has(d.id)), ...s.decisions].slice(-2000);
    s.backfilledAt = now;
    s.lastLearned = `Learned from ${plural(history.length, 'email')} and ${plural(folders.length, 'folder')} over the last 60 days.`;
    this.retrain();
    this.updateMode();
    // A few recent replies teach the drafts your tone and sign-off.
    const replies = sent.filter((m) => m.kind === 'reply').slice(0, 3);
    this.state.styleSamples = (await Promise.all(replies.map((m) => this.provider.body({ id: m.id } as MailMessage).then((b) => stripQuoted(b.text).slice(0, 500)).catch(() => '')))).filter(Boolean);
  }

  private setFolders(folders: Array<{ id: string; name: string }>) {
    this.folderIdByName = new Map(folders.map((f) => [f.name, f.id]));
    this.folderNameById = new Map(folders.map((f) => [f.id, f.name]));
  }

  private noteCoworker(p: Person, at: number) {
    if (!p.email || p.email === this.me.email) return;
    const cw = this.state.synced.coworkers[p.email] || { email: p.email, name: p.name, count: 0, at: 0 };
    this.state.synced.coworkers[p.email] = { ...cw, name: cw.name || p.name, count: cw.count + 1, at: Math.max(cw.at, at) };
  }

  /* ------------------------------------------------------------------ sync */

  sync(): Promise<void> {
    if (!this.syncing) this.syncing = this.doSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  get isSyncing() { return Boolean(this.syncing); }

  private async doSync(): Promise<void> {
    const st = this.state;
    // Announce "syncing" only after sync() has stored this promise, or a listener that calls sync() would recurse.
    queueMicrotask(() => this.emit());
    try {
      if (!st.synced.backfilledAt || !this.folderIdByName.size) {
        const remote = parseSynced(await this.provider.loadSyncDoc().catch(() => null));
        if (remote) { st.synced = mergeSynced(st.synced, remote); st.lastPull = Date.now(); }
        if (!st.synced.backfilledAt) await this.backfill();
        else this.setFolders(await this.provider.folders());
        this.retrain();
      }
      const result = await this.provider.pull(st.cursor);
      this.apply(result.upserts, result.removedIds, result.sent, result.full);
      this.sweep();
      if (this.learningNow) { this.retrain(); this.learningNow = false; }
      this.updateMode();
      st.cursor = result.cursor;
      if (st.synced.mode === 'assisting') await this.autoFile();
      await this.cloudSync();
      st.lastSync = Date.now();
      st.error = '';
    } catch (error) {
      st.error = (error as Error).message || String(error);
      console.error('Sync failed', error);
      throw error;
    } finally {
      this.changed(false);
      void this.enrich();
    }
  }

  private apply(upserts: MailMessage[], removedIds: string[], sent: Array<{ id: string; threadId: string; to: Person[]; date: number; kind: string }>, full: boolean) {
    const now = Date.now();
    const tracked = this.state.tracked;
    const movedByUs = new Set(this.state.synced.moved.filter((m) => !m.undone).map((m) => m.msgId));
    for (const m of upserts) {
      if (m.from.email === this.me.email && !m.inInbox) continue;
      const t = tracked[m.id];
      if (!t) {
        if (!m.inInbox) continue;
        tracked[m.id] = { m, firstSeen: now, arrivedLive: !full };
        if (!this.state.synced.handled[m.id]) tracked[m.id].predicted = this.predict(m);
        continue;
      }
      const old = t.m;
      t.m = m;
      if (old.inInbox && !m.inInbox) {
        if (m.inTrash) this.decide(t, 'trashed');
        else if (m.folderId && !movedByUs.has(m.id)) {
          const folder = this.folderNameById.get(m.folderId) || 'a folder';
          if (folder.toLowerCase() !== CC_FOLDER.toLowerCase()) this.decide(t, 'filed', { folder });
        } else if (!m.folderId) this.decide(t, 'archived');
      }
      if (!old.inInbox && m.inInbox && movedByUs.has(m.id)) {
        // You moved something I filed back to the inbox: that is a correction.
        const item = this.state.synced.moved.find((x) => x.msgId === m.id && !x.undone);
        if (item) { item.undone = true; this.state.synced.matches.push({ at: now, ok: false, kind: 'folder' }); this.state.synced.lastLearned = `Learned: ${firstName(m.from.name)}'s email belongs in the inbox, not ${item.folderName}`; }
      }
      if (!old.flagged && m.flagged) this.decide(t, 'flagged');
      if (!old.isRead && m.isRead) t.readAt = now;
    }
    for (const id of removedIds) {
      const t = tracked[id];
      if (t?.m.inInbox) { t.m = { ...t.m, inInbox: false, inTrash: true }; this.decide(t, 'trashed'); }
    }
    for (const s of sent) {
      s.to.forEach((p) => this.noteCoworker(p, s.date));
      const candidates = Object.values(tracked).filter((t) => t.m.threadId === s.threadId && t.m.date <= s.date && t.m.from.email !== this.me.email).sort((a, b) => b.m.date - a.m.date);
      const t = candidates[0];
      if (!t) continue;
      const latencyMin = Math.round((s.date - t.m.date) / MIN);
      if (s.kind === 'forward') {
        this.decide(t, 'forwarded', { to: s.to[0]?.email, latencyMin });
        this.state.synced.handled[t.m.id] = { type: 'forwarded', at: s.date, to: s.to[0]?.name || s.to[0]?.email };
      } else {
        this.decide(t, 'replied', { latencyMin });
        this.state.synced.handled[t.m.id] = { type: 'replied', at: s.date };
      }
    }
    // keep the tracked set small
    for (const [id, t] of Object.entries(tracked)) if (now - t.m.date > 30 * DAY || (!t.m.inInbox && now - t.m.date > 14 * DAY)) delete tracked[id];
  }

  /** After a day untouched, an email counts as read-and-left or ignored. */
  private sweep() {
    const now = Date.now();
    for (const t of Object.values(this.state.tracked)) {
      if (t.swept || t.outcome || !t.m.inInbox || now - t.m.date < DAY || this.state.synced.handled[t.m.id]) continue;
      t.swept = true;
      this.decide(t, t.m.isRead || t.readAt ? 'read-only' : 'ignored');
    }
  }

  /** Once confident: CC-only mail to the CC folder, and mail you always file into its folder. Never sends. */
  private async autoFile() {
    const s = this.state.synced;
    if (!s.settings.autoFile && !s.settings.ccFolder) return;
    const folderReady = (() => { const { rate, n } = matchRate(s.matches, 'folder'); return n >= 10 && rate >= ASSIST_THRESHOLD; })();
    const already = new Set(s.moved.map((m) => m.msgId));
    let moves = 0;
    for (const t of Object.values(this.state.tracked).sort((a, b) => b.m.date - a.m.date)) {
      if (moves >= 20) break;
      const m = t.m;
      const actedOn = t.outcome && (POSITIVE as string[]).includes(t.outcome);
      if (!m.inInbox || already.has(m.id) || s.handled[m.id] || s.manual[m.id] || actedOn || Date.now() - m.date > 3 * DAY) continue;
      const f = this.feats(m);
      const { p, source } = this.scoreOf(m, f);
      if (p >= 0.5 || source === 'always' || m.flagged) continue;         // never file away anything that looks like priority
      let folderName = '';
      let reason = '';
      if (s.settings.ccFolder && this.isCcOnly(m)) { folderName = CC_FOLDER; reason = 'You were only CC’d'; }
      else if (s.settings.autoFile && folderReady) {
        const guess = this.folderModel.predict(f);
        if (guess.folder && guess.p >= AUTO_FILE_P && this.folderIdByName.has(guess.folder)) { folderName = guess.folder; reason = `Like the other ${m.from.name.split(' ')[0]} emails you keep in ${guess.folder}`; }
      }
      if (!folderName) continue;
      try {
        const folder = folderName === CC_FOLDER ? await this.provider.ensureFolder(CC_FOLDER) : { id: this.folderIdByName.get(folderName)!, name: folderName };
        if (folderName === CC_FOLDER) { this.folderIdByName.set(folder.name, folder.id); this.folderNameById.set(folder.id, folder.name); }
        if (already.has(m.id)) continue;
        already.add(m.id);
        await this.provider.moveToFolder(m, folder.id);
        t.m = { ...m, inInbox: false, folderId: folder.id };
        s.moved.unshift({ msgId: m.id, subject: m.subject, from: m.from.name, folderName: folder.name, folderId: folder.id, at: Date.now(), reason });
        moves += 1;
      } catch (error) { console.warn('Auto-file failed for one email; leaving it in the inbox.', error); }
    }
    if (moves) this.state.dirty = true;
    if (s.settings.colorLabels) await this.applyTiers();
  }

  private tierApplied: Record<string, Tier | null> = {};
  private async applyTiers() {
    const rows = this.view().priority;
    const ranked = new Set(rows.map((r) => r.id));
    for (const id of Object.keys(this.tierApplied)) if (!ranked.has(id) && this.tierApplied[id]) rows.push({ id, priority: false, tier: null, handled: null } as unknown as RowVM);
    let n = 0;
    for (const r of rows) {
      if (n >= 15) break;
      const want = r.priority && !r.handled ? r.tier : null;
      if ((this.tierApplied[r.id] ?? null) === want) continue;
      const t = this.state.tracked[r.id];
      if (!t) continue;
      try { await this.provider.setTier(t.m, want); this.tierApplied[r.id] = want; n += 1; } catch (error) { console.warn('Could not set the priority color label.', error); break; }
    }
  }

  /** Pull the other device's learning every few minutes; push ours when it changed. */
  private async cloudSync(force = false) {
    const st = this.state;
    const now = Date.now();
    try {
      if (force || now - st.lastPull > 5 * MIN) {
        const remote = parseSynced(await this.provider.loadSyncDoc());
        if (remote) {
          const before = st.synced.decisions.length;
          st.synced = mergeSynced(st.synced, remote);
          if (st.synced.decisions.length !== before) this.retrain();
        }
        st.lastPull = now;
      }
      if (st.dirty && (force || now - st.lastPush > 60 * 1000)) {
        await this.provider.saveSyncDoc(serializeSynced(st.synced));
        st.lastPush = now;
        st.dirty = false;
      }
    } catch (error) {
      console.warn('Could not sync learned data to your cloud app folder; will retry.', error);
    }
  }

  async flush() { await this.cloudSync(true); this.persist(true); }

  /* ------------------------------------------------------------------ AI enrichment */

  private async enrich() {
    if (this.enriching || !this.ai.available) return;
    this.enriching = true;
    try {
      const top = this.rows().filter((r) => r.priority && !r.handled).slice(0, 6);
      for (const r of top) {
        const cached = this.state.analyses[r.id];
        if (cached?.ai && Date.now() - cached.at < DAY) continue;
        try { await this.analyze(r.id); } catch (error) { console.warn('AI analysis failed; using the basic summary.', error); break; }
      }
    } finally { this.enriching = false; }
  }

  async analyze(id: string, force = false): Promise<Analysis> {
    const t = this.state.tracked[id];
    if (!t) throw new Error('That email is no longer in your recent inbox.');
    const cached = this.state.analyses[id];
    // A plain (no-AI) card is replaced once AI is on, e.g. after opting in on another device.
    if (cached && !force && (cached.ai || !this.ai.available)) return cached;
    let analysis: Analysis;
    if (this.ai.available) {
      const body = await this.provider.body(t.m);
      analysis = await analyzeEmail(this.ai, this.me, t.m, body.text, this.state.styleSamples);
    } else analysis = heuristicAnalysis(t.m, this.me.name);
    this.state.analyses[id] = analysis;
    const keys = Object.keys(this.state.analyses);
    if (keys.length > 250) keys.sort((a, b) => this.state.analyses[a].at - this.state.analyses[b].at).slice(0, keys.length - 250).forEach((k) => delete this.state.analyses[k]);
    if (analysis.due) {
      const due = Date.parse(analysis.due.iso);
      const taskId = `due:${id}`;
      if (!this.state.synced.tasks[taskId] && due > Date.now() - DAY) {
        this.state.synced.tasks[taskId] = { id: taskId, msgId: id, title: analysis.headline, sub: `${t.m.from.name} · ${t.m.subject}`, due, done: false, kind: 'due', updatedAt: Date.now() };
      }
    }
    this.changed(true);
    return analysis;
  }

  async threadSummary(threadId: string, force = false): Promise<ThreadSummary> {
    const cached = this.state.threads[threadId];
    if (cached && !force && Date.now() - cached.at < 6 * HOUR) return cached;
    const messages = await this.provider.thread(threadId);
    if (!messages.length) throw new Error('That conversation could not be loaded.');
    let summary: ThreadSummary;
    if (this.ai.available) summary = await summarizeThread(this.ai, this.me, messages);
    else {
      const last = messages[messages.length - 1];
      summary = { whereItEnded: `Latest from ${last.from.name}: ${stripQuoted(last.body.text).slice(0, 220)}`, bullets: messages.slice(-4, -1).map((m) => `${firstName(m.from.name)}: ${m.snippet.slice(0, 90)}`), openItems: [], messageCount: messages.length, lastFrom: last.from.name, at: Date.now() };
    }
    this.state.threads[threadId] = summary;
    this.persist();
    this.emit();
    return summary;
  }

  async draftFor(id: string): Promise<string> {
    const a = await this.analyze(id).catch(() => null);
    if (a?.draft) return a.draft;
    const t = this.state.tracked[id];
    return t ? `Hi ${firstName(t.m.from.name)},\n\n\n\nThanks,\n${firstName(this.me.name)}` : '';
  }

  async voiceReply(id: string, transcript: string): Promise<string> {
    const t = this.state.tracked[id];
    if (!t) throw new Error('That email is no longer in your recent inbox.');
    if (!this.ai.available) return fallbackVoiceReply(transcript, this.me.name);
    try { return await polishVoiceReply(this.ai, this.me, t.m, transcript, this.state.styleSamples); } catch (error) { console.warn('AI cleanup failed; using your words as-is.', error); return fallbackVoiceReply(transcript, this.me.name); }
  }

  async dailyBrief(force = false): Promise<DailyBrief> {
    if (this.brief && !force && Date.now() - this.brief.at < 30 * MIN) return this.brief;
    const rows = this.rows();
    const msg = (r: RowVM) => this.state.tracked[r.id].m;
    const priority = rows.filter((r) => r.priority && !r.handled).map(msg);
    const others = rows.filter((r) => !r.priority).map(msg);
    if (!this.ai.available) {
      this.brief = { priority: priority.slice(0, 6).map((m) => ({ id: m.id, who: firstName(m.from.name), text: `${m.subject}: ${m.snippet.slice(0, 100)}` })), quickHits: others.slice(0, 6).map((m) => ({ who: firstName(m.from.name), text: m.subject })), at: Date.now() };
    } else this.brief = await dailyBrief(this.ai, this.me, priority, others);
    return this.brief;
  }

  async ask(question: string, history: Array<{ role: 'me' | 'ai'; text: string }>): Promise<string> {
    const context = Object.values(this.state.tracked).filter((t) => Date.now() - t.m.date < 3 * DAY).sort((a, b) => b.m.date - a.m.date).map((t) => t.m);
    if (!this.ai.available) return 'AI features are off, so I can only rank and file. Turn on AI features in Settings to ask questions about your email.';
    return askAboutEmail(this.ai, this.me, question, context, history);
  }

  sendCheck(kind: 'reply' | 'forward', id: string, text: string, to: Person[]): SendCheck {
    const t = this.state.tracked[id];
    if (!t) return { reasons: [], needsConfirm: false };
    return checkSend({ kind, message: t.m, text, to, me: this.me.email });
  }

  message(id: string): MailMessage | null { return this.state.tracked[id]?.m || null; }

  async conversation(threadId: string): Promise<FullMessage[]> {
    return (await this.provider.thread(threadId)).sort((a, b) => a.date - b.date);
  }

  /** In-app path for opening this email natively (Outlook needs an id translation); null = use webLink. */
  async webPath(id: string): Promise<string | null> {
    const m = this.message(id);
    const p = this.provider as MailProvider & { webPath?: (m: MailMessage) => Promise<string | null> };
    return m && p.webPath ? p.webPath(m).catch(() => null) : null;
  }

  /* ------------------------------------------------------------------ actions */

  async act(action: Action): Promise<string> {
    const s = this.state.synced;
    const t = 'id' in action ? this.state.tracked[action.id] : undefined;
    const need = () => { if (!t) throw new Error('That email is no longer in your recent inbox. Try refreshing.'); return t; };
    switch (action.type) {
      case 'make-priority': {
        const x = need(); s.manual[x.m.id] = { priority: true, at: Date.now() };
        this.decide(x, 'made-priority', {}, 'explicit'); this.retrain();
        this.changed(); return 'Moved to Priority. I will learn from this.';
      }
      case 'not-priority': case 'later': {
        const x = need(); s.manual[x.m.id] = { priority: false, at: Date.now() };
        this.decide(x, action.type, {}, 'explicit'); this.retrain();
        this.changed(); return action.type === 'later' ? 'Saved for later.' : 'Moved out of Priority. I will learn from this.';
      }
      case 'sender-pref': {
        s.senderPrefs[action.email] = { pref: action.pref, at: Date.now(), name: action.name };
        s.lastLearned = action.pref === 'always' ? `Always prioritizing ${action.name}` : action.pref === 'later' ? `${action.name} goes to Lower priority` : `Back to learning ${action.name} from your behavior`;
        if (action.pref === 'always') {
          // Bring back anything from this sender that I filed away on my own.
          for (const item of s.moved.filter((x) => !x.undone)) {
            const tm = this.state.tracked[item.msgId];
            if (tm?.m.from.email !== action.email) continue;
            try { await this.provider.moveToInbox({ ...tm.m, folderId: item.folderId }); item.undone = true; tm.m = { ...tm.m, inInbox: true, folderId: null }; }
            catch (error) { console.warn('Could not move an email back to the inbox.', error); }
          }
        }
        this.changed();
        return action.pref === 'always' ? `${firstName(action.name)} will always be priority.` : action.pref === 'later' ? `${firstName(action.name)} will stay out of Priority.` : 'Rule removed.';
      }
      case 'done': { const x = need(); s.handled[x.m.id] = { type: 'done', at: Date.now() }; const task = Object.values(s.tasks).find((k) => k.msgId === x.m.id); if (task) { task.done = true; task.updatedAt = Date.now(); } this.changed(); return 'Marked done.'; }
      case 'undone': { const x = need(); delete s.handled[x.m.id]; this.changed(); return 'Back on your list.'; }
      case 'opened': {
        const x = need(); x.readAt = x.readAt || Date.now();
        if (!x.m.isRead) { x.m = { ...x.m, isRead: true }; void this.provider.markRead(x.m, true).catch((error) => console.warn('Could not mark as read.', error)); }
        this.persist(); this.emit(); return '';
      }
      case 'dismiss': { this.dismissed.add(action.id); this.emit(); return 'Suggestion dismissed.'; }
      case 'trash': {
        const x = need(); await this.provider.trash(x.m);
        this.decide(x, 'trashed', {}, 'explicit'); x.m = { ...x.m, inInbox: false, inTrash: true };
        s.handled[x.m.id] = { type: 'trashed', at: Date.now() }; this.retrain(); this.changed(); return 'Moved to trash.';
      }
      case 'restore': {
        const x = need(); await this.provider.moveToInbox(x.m); x.m = { ...x.m, inInbox: true, inTrash: false, folderId: null };
        delete s.handled[x.m.id]; s.decisions = s.decisions.filter((d) => d.id !== `${x.m.id}:trashed`); x.outcome = undefined;
        this.retrain(); this.changed(); return 'Back in your inbox.';
      }
      case 'archive': {
        const x = need(); await this.provider.archive(x.m); x.m = { ...x.m, inInbox: false };
        this.decide(x, 'archived', {}, 'explicit'); s.handled[x.m.id] = { type: 'done', at: Date.now() }; this.changed(); return 'Archived.';
      }
      case 'file': {
        const x = need(); const folder = this.folderIdByName.get(action.folder) ? { id: this.folderIdByName.get(action.folder)!, name: action.folder } : await this.provider.ensureFolder(action.folder);
        await this.provider.moveToFolder(x.m, folder.id); x.m = { ...x.m, inInbox: false, folderId: folder.id };
        this.decide(x, 'filed', { folder: folder.name }, 'explicit'); s.handled[x.m.id] = { type: 'filed', at: Date.now(), to: folder.name };
        this.retrain(); this.changed(); return `Moved to ${folder.name}.`;
      }
      case 'reply': {
        const x = need(); await this.provider.reply(x.m, action.text, Boolean(action.replyAll));
        this.decide(x, 'replied', { latencyMin: Math.round((Date.now() - x.m.date) / MIN) }, 'explicit');
        s.handled[x.m.id] = { type: 'replied', at: Date.now() };
        const task = Object.values(s.tasks).find((k) => k.msgId === x.m.id); if (task) { task.done = true; task.updatedAt = Date.now(); }
        if (action.edited) s.lastLearned = `Learned: your edits to ${firstName(x.m.from.name)} replies`;
        this.retrain(); this.changed(); return `Reply sent to ${firstName(x.m.from.name)}.`;
      }
      case 'forward': {
        const x = need(); await this.provider.forward(x.m, action.to, action.note);
        this.decide(x, 'forwarded', { to: action.to[0]?.email, latencyMin: Math.round((Date.now() - x.m.date) / MIN) }, 'explicit');
        s.handled[x.m.id] = { type: 'forwarded', at: Date.now(), to: action.to[0]?.name };
        action.to.forEach((p) => this.noteCoworker(p, Date.now()));
        this.retrain(); this.changed(); return `Forwarded to ${action.to.map((p) => firstName(p.name)).join(', ')}.`;
      }
      case 'remind': {
        const x = need(); const id = `rem:${x.m.id}`;
        s.tasks[id] = { id, msgId: x.m.id, title: this.state.analyses[x.m.id]?.headline || x.m.subject, sub: `${x.m.from.name} · ${x.m.subject}`, due: action.due, done: false, kind: 'reminder', updatedAt: Date.now() };
        if (s.handled[x.m.id]?.type === 'done') delete s.handled[x.m.id];
        this.changed(); return 'Reminder set. It will show on your phone too.';
      }
      case 'task-done': {
        const task = s.tasks[action.taskId]; if (!task) throw new Error('That reminder no longer exists.');
        task.done = action.done; task.updatedAt = Date.now();
        if (action.done) s.handled[task.msgId] = s.handled[task.msgId] || { type: 'done', at: Date.now() };
        this.changed(); return action.done ? 'Done.' : 'Back on your list.';
      }
      case 'undo-move': {
        const item = s.moved.find((m) => m.msgId === action.id && !m.undone);
        if (!item) throw new Error('Nothing to undo for that email.');
        const msg = this.state.tracked[action.id]?.m || ({ id: action.id, folderId: item.folderId, inTrash: false } as MailMessage);
        await this.provider.moveToInbox({ ...msg, folderId: item.folderId });
        item.undone = true;
        if (this.state.tracked[action.id]) this.state.tracked[action.id].m = { ...msg, inInbox: true, folderId: null };
        s.matches.push({ at: Date.now(), ok: false, kind: 'folder' });
        s.lastLearned = `Learned: ${firstName(item.from)}'s email stays in the inbox`;
        this.changed(); return `Moved back to the inbox.`;
      }
      case 'set-mode': {
        s.mode = action.mode; s.modeAt = Date.now(); s.modeSetBy = 'user';
        this.changed(); return action.mode === 'assisting' ? 'Suggestions are on.' : 'Back to learning quietly. No changes to your inbox.';
      }
      case 'settings': {
        s.settings = { ...s.settings, ...action.patch }; s.settingsAt = Date.now();
        // AI turned on/off or key changed: drop the plain/old summaries so they are rewritten the new way.
        if ('aiEnabled' in action.patch || 'ownGeminiKey' in action.patch) { this.state.analyses = {}; this.state.threads = {}; this.brief = null; }
        this.changed();
        void this.enrich();
        return 'Settings saved.';
      }
      case 'sync': { await this.sync(); return ''; }
      case 'simulate-arrival': {
        const p = this.provider as unknown as { simulateArrival?: () => Promise<void> };
        if (!p.simulateArrival) throw new Error('Only the demo mailbox can simulate new mail.');
        await p.simulateArrival(); await this.sync(); return 'A new email arrived.';
      }
    }
  }

  /* ------------------------------------------------------------------ view */

  private reasonFor(m: MailMessage, f: string[], source: string): string {
    const who = firstName(m.from.name);
    if (source === 'manual') return 'You moved this to Priority';
    if (source === 'always') return `You told me to always prioritize ${who}`;
    const replies = this.state.synced.decisions.filter((d) => d.sender === m.from.email && d.kind === 'replied');
    if (replies.length >= 2) {
      const lat = replies.map((d) => d.latencyMin ?? 600).sort((a, b) => a - b)[Math.floor(replies.length / 2)];
      return `You usually answer ${who} ${lat < 60 ? 'within the hour' : lat < 240 ? 'within a few hours' : 'the same day'}`;
    }
    const top = this.priorityModel.contributions(f).find(([feat, w]) => w > 0.15 && describeFeature(feat));
    if (top) return describeFeature(top[0])!;
    return f.includes('direct') ? 'Sent directly to you' : 'Looks like it needs you';
  }

  private suggestionFor(m: MailMessage, f: string[]): Suggestion | null {
    if (this.dismissed.has(m.id) || this.state.synced.handled[m.id]) return null;
    const fwd = this.forwardModel.predict(f);
    if (fwd) {
      const cw = this.state.synced.coworkers[fwd.to];
      const to = { email: fwd.to, name: cw?.name || fwd.to.split('@')[0] };
      const via = fwd.via.startsWith('from:') ? `${fwd.count} of ${firstName(m.from.name)}'s emails` : fwd.via.startsWith('w:') ? `${fwd.count} emails about “${fwd.via.slice(2)}”` : `${fwd.count} emails from ${fwd.via.slice(4)}`;
      return { type: 'forward', label: `Forward to ${firstName(to.name)}`, why: `You've forwarded ${via} to ${firstName(to.name)}`, to };
    }
    const a = this.state.analyses[m.id];
    if (a?.action === 'reply') return { type: 'reply', label: a.draft ? 'Review drafted reply' : 'Reply', why: a.nextStep };
    if (a?.action === 'call' && a.phone) return { type: 'call', label: `Call ${firstName(m.from.name)}`, why: a.nextStep };
    if (a?.action === 'remind' || a?.due) return { type: 'remind', label: 'Remind me', why: a.nextStep };
    return null;
  }

  rows(): RowVM[] {
    const s = this.state.synced;
    const tasksByMsg = new Map(Object.values(s.tasks).filter((k) => !k.done).map((k) => [k.msgId, k]));
    const threadCounts = new Map<string, number>();
    for (const t of Object.values(this.state.tracked)) threadCounts.set(t.m.threadId, (threadCounts.get(t.m.threadId) || 0) + 1);
    const rows: RowVM[] = [];
    for (const t of Object.values(this.state.tracked)) {
      const m = t.m;
      const ccFolderId = this.folderIdByName.get(CC_FOLDER);
      const inCc = Boolean(ccFolderId && m.folderId === ccFolderId);
      if (!m.inInbox && !inCc) continue;
      if (s.handled[m.id]?.type === 'trashed') continue;
      const f = this.feats(m);
      const { p, source } = this.scoreOf(m, f);
      const handled = s.handled[m.id] || null;
      const a = this.state.analyses[m.id];
      const dueSoon = a?.due && Date.parse(a.due.iso) - Date.now() < DAY;
      rows.push({
        id: m.id, threadId: m.threadId, from: m.from.name, fromEmail: m.from.email, subject: m.subject, snippet: m.snippet, date: m.date,
        unread: !m.isRead && !t.readAt, flagged: m.flagged, attachment: m.hasAttachments, cc: this.isCcOnly(m), bulk: m.isBulk,
        priority: p >= 0.5 && !handled && m.inInbox, tier: p >= 0.8 || dueSoon ? 'urgent' : 'important', rank: 0, score: Math.round(p * 100),
        reason: this.reasonFor(m, f, source), suggestion: this.suggestionFor(m, f), handled: handled ? { type: handled.type, to: handled.to } : null,
        analysis: a ? { headline: a.headline, nextStep: a.nextStep, bullets: a.bullets, action: a.action, due: a.due, phone: a.phone } : null,
        threadCount: threadCounts.get(m.threadId) || 1, webLink: m.webLink, senderPref: s.senderPrefs[m.from.email]?.pref || null,
        folderName: inCc ? CC_FOLDER : undefined, task: tasksByMsg.get(m.id) || null,
      });
    }
    // One row per conversation (like Gmail/Outlook): newest message shown, ranked by its strongest message.
    const byThread = new Map<string, RowVM[]>();
    for (const r of rows) {
      const key = `${r.threadId}|${r.folderName || 'inbox'}`;
      (byThread.get(key) || byThread.set(key, []).get(key)!).push(r);
    }
    const grouped: RowVM[] = [];
    for (const group of byThread.values()) {
      const newest = group.reduce((a, b) => (b.date > a.date ? b : a));
      const strongest = group.reduce((a, b) => (b.score > a.score ? b : a));
      grouped.push({ ...newest, score: strongest.score, priority: group.some((r) => r.priority), unread: group.some((r) => r.unread), threadCount: Math.max(newest.threadCount, group.length),
        reason: strongest.reason, suggestion: newest.suggestion || strongest.suggestion, analysis: newest.analysis || strongest.analysis, task: newest.task || strongest.task });
    }
    return grouped.sort((a, b) => b.score - a.score || b.date - a.date);
  }

  view(): View {
    const s = this.state.synced;
    const all = this.rows();
    const assisting = s.mode === 'assisting';
    const inInbox = all.filter((r) => !r.folderName);
    let priority = assisting ? inInbox.filter((r) => r.priority).slice(0, PRIORITY_CAP) : [];
    priority.forEach((r, i) => {
      r.rank = i + 1;
      const dueSoon = r.analysis?.due && Date.parse(r.analysis.due.iso) - Date.now() < DAY;
      r.tier = (i < 3 && r.score >= 80) || dueSoon ? 'urgent' : 'important';
    });
    const prioritySet = new Set(priority.map((r) => r.id));
    const order = s.settings.everythingElseOrder === 'newest' || !assisting ? (a: RowVM, b: RowVM) => b.date - a.date : (a: RowVM, b: RowVM) => b.score - a.score || b.date - a.date;
    const cc = all.filter((r) => !prioritySet.has(r.id) && (r.folderName === CC_FOLDER || (r.cc && !r.priority))).sort((a, b) => b.date - a.date);
    const ccSet = new Set(cc.map((r) => r.id));
    const others = inInbox.filter((r) => !prioritySet.has(r.id) && !ccSet.has(r.id)).sort(order);
    priority = priority.sort((a, b) => a.rank - b.rank);
    const featured = priority[0] || null;
    const upNext = [...priority.slice(1, 5), ...others.filter((r) => r.suggestion?.type === 'forward').slice(0, 2)].slice(0, 5);

    const { rate, n } = matchRate(s.matches, 'priority');
    const folder = matchRate(s.matches, 'folder');
    return {
      account: this.me,
      mode: s.mode, modeSetBy: s.modeSetBy,
      status: { syncing: this.isSyncing, learning: !s.backfilledAt, lastSync: this.state.lastSync, error: this.state.error, ai: this.ai.available, backfilled: Boolean(s.backfilledAt) },
      priority, others, cc, featured, upNext,
      calendar: this.calendar(all), tasks: Object.values(s.tasks).sort((a, b) => (a.due || 9e15) - (b.due || 9e15)),
      moved: s.moved.filter((m) => !m.undone && Date.now() - m.at < 3 * DAY),
      learning: { rate, n, needed: MIN_COMPARISONS, folderRate: folder.rate, notes: this.notes(), stats: this.stats() },
      confidence: {
        value: Math.round((n ? rate : 0.5) * 100),
        lastLearned: s.lastLearned || 'Gets smarter every time you act on an email or correct me.',
        why: priority.slice(0, 8).map((r) => ({ who: r.from, why: r.reason })),
      },
      coworkers: Object.values(s.coworkers).filter((c) => domainOf(c.email) === domainOf(this.me.email) || c.count >= 3).sort((a, b) => b.count - a.count).slice(0, 8).map((c) => ({ email: c.email, name: c.name })),
      folders: [...this.folderIdByName.keys()].filter((f) => f !== CC_FOLDER).sort(),
      settings: s.settings,
    };
  }

  private calendar(rows: RowVM[]): CalendarItem[] {
    const now = Date.now();
    const items: CalendarItem[] = Object.values(this.state.synced.tasks).filter((k) => k.due && k.due > now - 2 * DAY && k.due < now + 14 * DAY).map((k) => ({
      id: k.id, at: k.due!, title: k.title, sub: k.sub, msgId: k.msgId, kind: k.kind, done: k.done, overdue: !k.done && k.due! < now,
    }));
    // Max's ask: a submittal or attachment that arrived a day or two ago and is still sitting there gets a nudge.
    for (const r of rows) {
      const age = now - r.date;
      if (r.handled || r.task || r.bulk || age < DAY || age > 4 * DAY) continue;
      if (!/submittal|shop drawing|rfi|review|approve|sign[- ]off|quote|bid/i.test(`${r.subject} ${r.snippet}`)) continue;
      items.push({ id: `nudge:${r.id}`, at: now, title: `Did you review “${r.subject}”?`, sub: `${r.from} sent it ${Math.round(age / DAY)} day${age >= 2 * DAY ? 's' : ''} ago`, msgId: r.id, kind: 'nudge', done: false, overdue: false });
    }
    return items.sort((a, b) => a.at - b.at);
  }

  private stats(): Array<[string, number]> {
    const d = this.state.synced.decisions;
    const count = (k: DecisionKind[]) => d.filter((x) => k.includes(x.kind)).length;
    return [['Emails studied', new Set(d.map((x) => x.msgId)).size], ['Replies', count(['replied'])], ['Forwards', count(['forwarded'])], ['Filed or skipped', count(['filed', 'trashed', 'ignored', 'archived'])]];
  }

  /** "What I've noticed" lines, from the decision log. */
  private notes(): string[] {
    const d = this.state.synced.decisions;
    const bySender = new Map<string, Decision[]>();
    for (const x of d) (bySender.get(x.sender) || bySender.set(x.sender, []).get(x.sender)!).push(x);
    const nameOf = (email: string) => { const name = this.state.senderNames?.[email] || Object.values(this.state.tracked).find((k) => k.m.from.email === email)?.m.from.name; return name ? firstName(name) : email.split('@')[0]; };
    const fast = [...bySender].filter(([, xs]) => xs.filter((x) => x.kind === 'replied' && (x.latencyMin ?? 999) <= 60).length >= 2).map(([e]) => nameOf(e)).slice(0, 3);
    const skipped = [...bySender].filter(([, xs]) => xs.length >= 4 && !xs.some((x) => POSITIVE.includes(x.kind)) && xs.filter((x) => ['ignored', 'trashed', 'filed', 'archived'].includes(x.kind)).length >= 4).map(([e]) => nameOf(e)).slice(0, 2);
    const fwd = new Map<string, number>();
    d.filter((x) => x.kind === 'forwarded' && x.to).forEach((x) => fwd.set(x.to!, (fwd.get(x.to!) || 0) + 1));
    const topFwd = [...fwd].sort((a, b) => b[1] - a[1])[0];
    const filed = new Map<string, number>();
    d.filter((x) => x.kind === 'filed' && x.folder).forEach((x) => filed.set(x.folder!, (filed.get(x.folder!) || 0) + 1));
    const topFolders = [...filed].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([f]) => f);
    const notes: string[] = [];
    if (fast.length) notes.push(`You answer ${fast.join(' and ')} within the hour`);
    if (skipped.length) notes.push(`You skip or file ${skipped.join(' and ')} without replying`);
    if (topFwd && topFwd[1] >= 2) notes.push(`You often forward to ${this.state.synced.coworkers[topFwd[0]]?.name || topFwd[0]}`);
    if (topFolders.length) notes.push(`You keep folders for ${topFolders.join(' and ')}`);
    return notes;
  }
}
