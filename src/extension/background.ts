/* Background service worker: owns the accounts, tokens and one AssistantService per mailbox. Syncs every
   minute, raises reminder notifications, and answers the Gmail/Outlook pages and the options page. */
import type { KV } from '../core/state';
import { beginAuth, completeAuth, AuthError, type TokenSet } from '../core/auth';
import { openService, demoAccount, aiAuthFor, type StoredAccount } from '../core/accounts';
import type { AssistantService } from '../core/service';
import type { TokenManager } from '../core/auth';
import type { Request, Response } from './messages';

class ChromeKV implements KV {
  async get<T>(key: string): Promise<T | null> { const r = await chrome.storage.local.get(key); return (r[key] as T) ?? null; }
  async set(key: string, value: unknown) { await chrome.storage.local.set({ [key]: value }); }
  async remove(key: string) { await chrome.storage.local.remove(key); }
}

const kv = new ChromeKV();
const MAIL_TABS = ['https://mail.google.com/*', 'https://outlook.office.com/*', 'https://outlook.office365.com/*', 'https://outlook.live.com/*', 'https://outlook.cloud.microsoft/*'];
const opened = new Map<string, Promise<{ service: AssistantService; tm: TokenManager | null }>>();

async function accounts(): Promise<StoredAccount[]> { return (await kv.get<StoredAccount[]>('accounts')) || []; }
async function saveAccounts(list: StoredAccount[]) { await kv.set('accounts', list); }

async function saveTokens(email: string, tokens: TokenSet) {
  const list = await accounts();
  const acc = list.find((a) => a.email === email);
  if (acc) { acc.tokens = tokens; await saveAccounts(list); }
}

/** The demo mailbox has no AI sign-in of its own; borrow the first real account's, if any. */
let firstRealTm: TokenManager | null = null;

function service(account: StoredAccount) {
  let p = opened.get(account.email);
  if (!p) {
    p = openService(account, { kv, saveTokens, fallbackAiAuth: () => (firstRealTm ? aiAuthFor(firstRealTm) : null) }).then((r) => {
      if (r.tm && !firstRealTm) firstRealTm = r.tm;
      r.service.onChange(() => broadcast());
      return r;
    });
    p.catch(() => opened.delete(account.email));
    opened.set(account.email, p);
  }
  return p.then((r) => r.service);
}

async function serviceFor(email: string): Promise<AssistantService> {
  const acc = (await accounts()).find((a) => a.email === email);
  if (!acc) throw new Error('That account is no longer connected. Open Priority Assistant settings to reconnect.');
  return service(acc);
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    const tabs = await chrome.tabs.query({ url: MAIL_TABS });
    for (const tab of tabs) if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'changed' }).catch(() => undefined);
    chrome.runtime.sendMessage({ type: 'changed' }).catch(() => undefined);
    void updateBadge();
  }, 250);
}

async function updateBadge() {
  const list = await accounts();
  const real = list.find((a) => a.kind !== 'demo') || list[0];
  if (!real) { await chrome.action.setBadgeText({ text: '' }); return; }
  try {
    const v = (await service(real)).view();
    const n = v.mode === 'assisting' ? v.priority.filter((r) => r.unread).length : 0;
    await chrome.action.setBadgeBackgroundColor({ color: '#E8590C' });
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  } catch { /* badge is best effort */ }
}

/** Pick the account that belongs to this page: the page's email if we can read it, else the first of that kind. */
async function accountForPage(site: string, hint: string): Promise<StoredAccount | null> {
  const list = await accounts();
  const exact = hint ? list.find((a) => a.email === hint) : undefined;
  if (exact) return exact;
  const ofKind = list.filter((a) => a.kind === site);
  // Gmail's page email is reliable: a different Gmail account on this page is simply not connected.
  // Outlook's is not always readable, so fall back to the connected Outlook account.
  if (ofKind.length && (!hint || site === 'outlook')) return ofKind[0];
  return list.find((a) => a.kind === 'demo') || (site === 'harness' ? list[0] : null) || null;
}

async function connect(provider: 'google' | 'microsoft'): Promise<StoredAccount> {
  const redirect = chrome.identity.getRedirectURL();
  const pending = await beginAuth(provider, redirect);
  let redirected: string | undefined;
  try {
    redirected = await chrome.identity.launchWebAuthFlow({ url: pending.url, interactive: true });
  } catch (error) {
    throw new AuthError(`Sign-in window closed or failed: ${(error as Error).message}`);
  }
  if (!redirected) throw new AuthError('Sign-in was cancelled.');
  const tokens = await completeAuth(pending, redirected);
  const account: StoredAccount = { kind: provider === 'google' ? 'gmail' : 'outlook', email: tokens.email, name: tokens.name, tokens };
  const list = (await accounts()).filter((a) => a.email !== account.email);
  list.push(account);
  await saveAccounts(list);
  opened.delete(account.email);
  const svc = await service(account);
  void svc.sync().catch((error) => console.warn('First sync failed', error));
  broadcast();
  return account;
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'view': {
      const acc = await accountForPage(req.site, req.hint);
      if (!acc) return { view: null, reason: 'no-account', accounts: (await accounts()).length };
      const svc = await service(acc);
      if (!svc.state.lastSync && !svc.isSyncing) void svc.sync().catch((error) => console.warn('Sync failed', error));
      return { view: svc.view() };
    }
    case 'act': return (await serviceFor(req.email)).act(req.action);
    case 'analyze': return (await serviceFor(req.email)).analyze(req.id, req.force);
    case 'thread': return (await serviceFor(req.email)).threadSummary(req.threadId, req.force);
    case 'conversation': return (await serviceFor(req.email)).conversation(req.threadId);
    case 'draft': return (await serviceFor(req.email)).draftFor(req.id);
    case 'send-check': return (await serviceFor(req.email)).sendCheck(req.kind, req.id, req.text, req.to);
    case 'web-path': return (await serviceFor(req.email)).webPath(req.id);
    case 'connect': { const a = await connect(req.provider); return { email: a.email, name: a.name, kind: a.kind }; }
    case 'disconnect': {
      const p = opened.get(req.email);
      if (p) { const r = await p.catch(() => null); await r?.service.flush().catch(() => undefined); }
      opened.delete(req.email);
      await saveAccounts((await accounts()).filter((a) => a.email !== req.email));
      await kv.remove(`acct:${req.email}`);
      broadcast();
      return true;
    }
    case 'demo': {
      const list = (await accounts()).filter((a) => a.kind !== 'demo');
      if (req.on) list.push(demoAccount());
      else { opened.delete(demoAccount().email); await kv.remove(`acct:${demoAccount().email}`); await kv.remove('demo-mailbox'); }
      await saveAccounts(list);
      broadcast();
      return true;
    }
    case 'accounts': {
      const list = await accounts();
      return Promise.all(list.map(async (a) => {
        let status = null;
        try { const v = (await service(a)).view(); status = { mode: v.mode, rate: v.learning.rate, n: v.learning.n, lastSync: v.status.lastSync, error: v.status.error, settings: v.settings, ai: v.status.ai }; } catch (error) { status = { error: (error as Error).message }; }
        return { kind: a.kind, email: a.email, name: a.name, status };
      }));
    }
    case 'open-options': await chrome.runtime.openOptionsPage(); return true;
  }
}

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse: (r: Response) => void) => {
  handle(req).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => { console.error(req.type, error); sendResponse({ ok: false, error: (error as Error).message || String(error), needsSignIn: error instanceof AuthError && error.needsSignIn }); },
  );
  return true;
});

async function syncAll() {
  for (const acc of await accounts()) {
    try { await (await service(acc)).sync(); } catch (error) { console.warn(`Sync failed for ${acc.email}`, error); }
  }
  await checkReminders();
}

/** Desktop notification when a reminder or due date arrives (it also shows on the phone through sync). */
async function checkReminders() {
  const notified = new Set((await kv.get<string[]>('notified')) || []);
  const now = Date.now();
  for (const acc of await accounts()) {
    const svc = await service(acc).catch(() => null);
    if (!svc) continue;
    for (const task of Object.values(svc.state.synced.tasks)) {
      if (task.done || !task.due || task.due > now || now - task.due > 6 * 3600000 || notified.has(`${task.id}:${task.due}`)) continue;
      notified.add(`${task.id}:${task.due}`);
      chrome.notifications.create(`pa:${acc.email}:${task.msgId}`, {
        type: 'basic', iconUrl: 'icons/icon128.png', priority: 2,
        title: task.kind === 'due' ? `Due now: ${task.title}` : `Reminder: ${task.title}`,
        message: task.sub,
      });
    }
  }
  await kv.set('notified', [...notified].slice(-300));
}

chrome.notifications.onClicked.addListener(async (id) => {
  const [, email] = id.split(':');
  const acc = (await accounts()).find((a) => a.email === email);
  await chrome.tabs.create({ url: acc?.kind === 'outlook' ? 'https://outlook.office.com/mail/' : 'https://mail.google.com/mail/' });
});

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'sync') void syncAll(); });
chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.alarms.create('sync', { periodInMinutes: 1 });
  if (details.reason === 'install') await chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('sync', { periodInMinutes: 1 }); });

chrome.action.onClicked.addListener(async (tab) => {
  if (!(await accounts()).length || !tab.id || !MAIL_TABS.some((p) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace('*', '.*')}$`).test(tab.url || ''))) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => chrome.runtime.openOptionsPage());
});

