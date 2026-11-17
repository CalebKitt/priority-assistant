/* Per-account state. The "synced" part travels between the extension and the phone through a JSON file in the
   user's own Drive/OneDrive app folder; merging is conflict-free (union of decisions, newest-wins per key). */
import type { AccountInfo, Analysis, Decision, MailMessage, MovedItem, Settings, Task, ThreadSummary } from './types';

export type Mode = 'learning' | 'assisting';

export interface Handled { type: 'replied' | 'forwarded' | 'done' | 'trashed' | 'filed'; at: number; to?: string }
export interface SenderPref { pref: 'always' | 'later' | null; at: number; name: string }
export interface Manual { priority: boolean; at: number }
export interface Match { at: number; ok: boolean; kind: 'priority' | 'folder' }
export interface Coworker { email: string; name: string; count: number; at: number }

/** Everything that syncs across devices. */
export interface Synced {
  decisions: Decision[];
  senderPrefs: Record<string, SenderPref>;
  manual: Record<string, Manual>;
  handled: Record<string, Handled>;
  tasks: Record<string, Task>;
  moved: MovedItem[];
  matches: Match[];
  coworkers: Record<string, Coworker>;
  mode: Mode;
  modeAt: number;
  modeSetBy: 'auto' | 'user';
  settings: Settings;
  settingsAt: number;
  lastLearned: string;
  backfilledAt: number;
}

/** Tracked email: the message plus what we observed and guessed about it. */
export interface Tracked {
  m: MailMessage;
  firstSeen: number;
  arrivedLive: boolean;          // seen arriving (vs. already there on first sync)
  readAt?: number;
  predicted?: { priority: boolean; p: number; folder: string | null; at: number };
  outcome?: string;              // first decisive outcome already recorded
  swept?: boolean;               // 24h sweep done
}

export interface AccountState {
  v: 1;
  account: AccountInfo;
  cursor: string | null;
  tracked: Record<string, Tracked>;
  synced: Synced;
  analyses: Record<string, Analysis>;
  threads: Record<string, ThreadSummary>;
  styleSamples: string[];
  senderNames?: Record<string, string>;
  lastSync: number;
  lastPush: number;
  lastPull: number;
  dirty: boolean;
  error: string;
}

export const DEFAULT_SETTINGS: Settings = { autoFile: true, ccFolder: true, colorLabels: true, aiEnabled: false, ownGeminiKey: '', everythingElseOrder: 'priority' };

export function emptySynced(): Synced {
  return {
    decisions: [], senderPrefs: {}, manual: {}, handled: {}, tasks: {}, moved: [], matches: [], coworkers: {},
    mode: 'learning', modeAt: 0, modeSetBy: 'auto', settings: { ...DEFAULT_SETTINGS }, settingsAt: 0, lastLearned: '', backfilledAt: 0,
  };
}

export function emptyState(account: AccountInfo): AccountState {
  return { v: 1, account, cursor: null, tracked: {}, synced: emptySynced(), analyses: {}, threads: {}, styleSamples: [], lastSync: 0, lastPush: 0, lastPull: 0, dirty: false, error: '' };
}

const MAX_DECISIONS = 2000;
const MAX_MATCHES = 60;
const WEEK = 7 * 86400000;

function lwwRecord<T extends { at?: number; updatedAt?: number }>(a: Record<string, T>, b: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = { ...a };
  const time = (x: T) => x.updatedAt ?? x.at ?? 0;
  for (const [key, value] of Object.entries(b || {})) if (!out[key] || time(value) > time(out[key])) out[key] = value;
  return out;
}

/** Merge a remote synced doc into the local one. Pure; returns a new object. */
export function mergeSynced(local: Synced, remote: Partial<Synced>): Synced {
  const decisions = new Map(local.decisions.map((d) => [d.id, d]));
  for (const d of remote.decisions || []) if (!decisions.has(d.id) || d.at > decisions.get(d.id)!.at) decisions.set(d.id, d);
  const matches = new Map(local.matches.map((m) => [`${m.kind}:${m.at}`, m]));
  for (const m of remote.matches || []) matches.set(`${m.kind}:${m.at}`, m);
  const moved = new Map(local.moved.map((m) => [`${m.msgId}:${m.at}`, m]));
  for (const m of remote.moved || []) { const key = `${m.msgId}:${m.at}`; moved.set(key, { ...m, undone: m.undone || moved.get(key)?.undone }); }
  const remoteNewerMode = (remote.modeAt || 0) > local.modeAt;
  const remoteNewerSettings = (remote.settingsAt || 0) > local.settingsAt;
  return {
    decisions: [...decisions.values()].sort((a, b) => a.at - b.at).slice(-MAX_DECISIONS),
    senderPrefs: lwwRecord(local.senderPrefs, remote.senderPrefs || {}),
    manual: lwwRecord(local.manual, remote.manual || {}),
    handled: lwwRecord(local.handled, remote.handled || {}),
    tasks: lwwRecord(local.tasks, remote.tasks || {}),
    moved: [...moved.values()].filter((m) => Date.now() - m.at < WEEK).sort((a, b) => b.at - a.at),
    matches: [...matches.values()].sort((a, b) => a.at - b.at).slice(-MAX_MATCHES * 2),
    coworkers: lwwRecord(local.coworkers, remote.coworkers || {}),
    mode: remoteNewerMode ? remote.mode! : local.mode,
    modeAt: Math.max(local.modeAt, remote.modeAt || 0),
    modeSetBy: remoteNewerMode ? remote.modeSetBy || 'auto' : local.modeSetBy,
    settings: remoteNewerSettings ? { ...DEFAULT_SETTINGS, ...remote.settings } : local.settings,
    settingsAt: Math.max(local.settingsAt, remote.settingsAt || 0),
    lastLearned: (remote.decisions?.length || 0) > local.decisions.length ? remote.lastLearned || local.lastLearned : local.lastLearned,
    backfilledAt: Math.max(local.backfilledAt, remote.backfilledAt || 0),
  };
}

export function serializeSynced(s: Synced): string {
  return JSON.stringify({ app: 'priority-assistant', v: 1, savedAt: Date.now(), synced: s });
}

export function parseSynced(json: string | null): Partial<Synced> | null {
  if (!json) return null;
  try {
    const doc = JSON.parse(json);
    return doc?.app === 'priority-assistant' ? doc.synced : null;
  } catch { return null; }
}

/** Rolling match rate over the last N comparisons of one kind. */
export function matchRate(matches: Match[], kind: Match['kind'] = 'priority', window = 40): { rate: number; n: number } {
  const recent = matches.filter((m) => m.kind === kind).slice(-window);
  if (!recent.length) return { rate: 0, n: 0 };
  return { rate: recent.filter((m) => m.ok).length / recent.length, n: recent.length };
}

export const ASSIST_THRESHOLD = 0.85;
export const MIN_COMPARISONS = 15;

/** Small key-value persistence, so the core works in the extension (chrome.storage) and on the phone (localStorage). */
export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export class LocalStorageKV implements KV {
  constructor(private prefix = 'pa:') {}
  async get<T>(key: string): Promise<T | null> {
    try { const raw = localStorage.getItem(this.prefix + key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
  }
  async set(key: string, value: unknown) {
    try { localStorage.setItem(this.prefix + key, JSON.stringify(value)); } catch (error) { console.warn('Could not save locally (storage full or blocked).', error); }
  }
  async remove(key: string) { try { localStorage.removeItem(this.prefix + key); } catch { /* ignore */ } }
}

export class MemoryKV implements KV {
  private map = new Map<string, string>();
  async get<T>(key: string) { const v = this.map.get(key); return v ? JSON.parse(v) as T : null; }
  async set(key: string, value: unknown) { this.map.set(key, JSON.stringify(value)); }
  async remove(key: string) { this.map.delete(key); }
}
