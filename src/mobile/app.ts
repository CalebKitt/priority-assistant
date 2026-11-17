/* Phone web app entry: sign-in (redirect flow), open the account, sync, route between screens. */
import css from './styles.css';
import { app } from './shell';
import './screens/inbox';
import './screens/reading';
import './screens/sort';
import './screens/speak';
import './screens/summary';
import { auth } from './screens/settings';
import { LocalStorageKV } from '../core/state';
import { beginAuth, completeAuth, type PendingAuth, type TokenManager, type TokenSet } from '../core/auth';
import { openService, demoAccount, aiAuthFor, type StoredAccount } from '../core/accounts';

const kv = new LocalStorageKV('pa:');
let syncTimer: ReturnType<typeof setInterval> | null = null;
let realTm: TokenManager | null = null;

const redirectUri = () => `${location.origin}${location.pathname}`;

async function accounts(): Promise<StoredAccount[]> { return (await kv.get<StoredAccount[]>('accounts')) || []; }
async function saveAccounts(list: StoredAccount[]) { await kv.set('accounts', list); auth.accounts = list.map(({ kind, email, name }) => ({ kind, email, name })); }

async function saveTokens(email: string, tokens: TokenSet) {
  const list = await accounts();
  const acc = list.find((a) => a.email === email);
  if (acc) { acc.tokens = tokens; await saveAccounts(list); }
}

async function activate(email: string | null) {
  if (syncTimer) clearInterval(syncTimer);
  app.service = null;
  const list = await accounts();
  const acc = list.find((a) => a.email === email) || list[0];
  if (!acc) { app.render(); return; }
  await kv.set('active', acc.email);
  try {
    // keep a real account's sign-in around so the demo mailbox can still use AI
    for (const a of list.filter((x) => x.kind !== 'demo' && x.email !== acc.email && !realTm)) {
      try { realTm = (await openService(a, { kv, saveTokens })).tm; } catch { /* that account needs to sign in again */ }
    }
    const { service, tm } = await openService(acc, { kv, saveTokens, fallbackAiAuth: () => (realTm ? aiAuthFor(realTm) : null) });
    if (tm) realTm = realTm || tm;
    app.service = service;
    service.onChange(() => app.onData());
  } catch (error) {
    auth.error = (error as Error).message;
    app.render();
    return;
  }
  if (!location.hash || location.hash === '#/welcome') location.hash = '#/inbox';
  app.render();
  const sync = () => app.service?.sync().then(() => app.service?.flush()).catch((error) => console.warn('Sync failed', error));
  void sync();
  syncTimer = setInterval(() => { if (document.visibilityState === 'visible') void app.service?.sync().catch(() => undefined); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync(); });
}

auth.signIn = async (provider) => {
  try {
    const pending = await beginAuth(provider, redirectUri());
    sessionStorage.setItem('pa-pending', JSON.stringify(pending));
    location.assign(pending.url);
  } catch (error) { auth.error = (error as Error).message; app.render(); app.toast(auth.error, 'error'); }
};

auth.startDemo = async () => {
  const list = (await accounts()).filter((a) => a.kind !== 'demo');
  list.push(demoAccount());
  await saveAccounts(list);
  await activate(demoAccount().email);
};

auth.switchTo = (email) => { void activate(email); };

auth.remove = async (email) => {
  await app.service?.flush().catch(() => undefined);
  await saveAccounts((await accounts()).filter((a) => a.email !== email));
  await kv.remove(`acct:${email}`);
  if (email === demoAccount().email) await kv.remove('demo-mailbox');
  await activate(null);
};

/** Coming back from Google/Microsoft with ?code=…: finish sign-in. */
async function finishRedirect(): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  if (!params.get('code') && !params.get('error')) return null;
  const raw = sessionStorage.getItem('pa-pending');
  sessionStorage.removeItem('pa-pending');
  history.replaceState(null, '', `${location.pathname}#/inbox`);
  if (!raw) { auth.error = 'Sign-in expired. Please try again.'; return null; }
  try {
    const pending = JSON.parse(raw) as PendingAuth;
    const tokens = await completeAuth(pending, `${redirectUri()}?${params}`);
    const account: StoredAccount = { kind: pending.provider === 'google' ? 'gmail' : 'outlook', email: tokens.email, name: tokens.name, tokens };
    const list = (await accounts()).filter((a) => a.email !== account.email);
    list.push(account);
    await saveAccounts(list);
    return account.email;
  } catch (error) { auth.error = (error as Error).message; return null; }
}

function mountShell() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const root = document.getElementById('app')!;
  root.innerHTML = '<div id="screen" class="screen"></div><nav id="tabbar" class="tabbar" hidden></nav><div class="toasts" aria-live="polite"></div>';
  app.root = root;
  root.addEventListener('click', (event) => {
    const el = (event.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el || !root.contains(el)) return;
    const name = el.dataset.act!;
    if (name === 'go') { event.preventDefault(); app.go(el.dataset.to!); return; }
    const handler = app.handlers[name];
    if (!handler) { console.warn(`No handler for ${name}`); return; }
    if (!(el instanceof HTMLInputElement)) event.preventDefault();
    Promise.resolve(handler(el, event)).catch((error) => { console.error(error); app.toast((error as Error).message, 'error'); });
  });
  window.addEventListener('hashchange', () => app.render());
}

async function main() {
  mountShell();
  const list = await accounts();
  auth.accounts = list.map(({ kind, email, name }) => ({ kind, email, name }));
  const fresh = await finishRedirect();
  await activate(fresh || (await kv.get<string>('active')));
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Offline support unavailable', error));
}

void main();
