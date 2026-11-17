/* Settings page: connect accounts, demo inbox, behavior toggles, personal Gemini key, phone link, setup check. */
import { send } from './messages';
import { CONFIG } from '../core/config';
import type { Settings } from '../core/types';
import { esc } from '../core/util';

interface AccountRow {
  kind: 'gmail' | 'outlook' | 'demo'; email: string; name: string;
  status: { mode?: string; rate?: number; n?: number; lastSync?: number; error?: string; settings?: Settings; ai?: boolean } | null;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
let accounts: AccountRow[] = [];

function toast(message: string, error = false) {
  const t = $('#toast');
  t.textContent = message; t.className = error ? 'error' : ''; t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, error ? 6000 : 3000);
}

async function load() {
  try { accounts = await send<AccountRow[]>({ type: 'accounts' }); } catch (error) { toast((error as Error).message, true); return; }
  const list = $('#accounts');
  list.innerHTML = accounts.length ? accounts.map((a) => {
    const s = a.status || {};
    const label = a.kind === 'gmail' ? 'Gmail' : a.kind === 'outlook' ? 'Outlook' : 'Demo';
    const mode = s.mode === 'assisting' ? '<span class="pill ok">Suggestions on</span>' : `<span class="pill accent">Learning${s.n ? ` · ${Math.round((s.rate || 0) * 100)}% match` : ''}</span>`;
    return `<div class="acct"><div><b>${esc(a.name)}</b> <span class="muted">${esc(a.email)}</span><br><span class="pill">${label}</span>${mode}
      ${s.error ? `<span class="pill bad" title="${esc(s.error)}">Needs attention</span>` : s.lastSync ? `<span class="muted">synced ${new Date(s.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>` : '<span class="muted">first sync running…</span>'}
      ${s.error ? `<div class="muted" style="color:#8b2b1f">${esc(s.error)}</div>` : ''}</div>
      ${a.kind === 'demo' ? '' : `<button class="btn btn-danger" data-act="disconnect" data-email="${esc(a.email)}">Disconnect</button>`}</div>`;
  }).join('') : '<p class="muted">No accounts yet. Connect Gmail or Outlook, or turn on the demo inbox to look around first.</p>';
  ($('#demo') as HTMLInputElement).checked = accounts.some((a) => a.kind === 'demo');

  const behavior = $('#behavior');
  behavior.hidden = !accounts.length;
  const select = $('#settings-account') as HTMLSelectElement;
  const current = select.value;
  select.innerHTML = accounts.map((a) => `<option value="${esc(a.email)}">${esc(a.email)}</option>`).join('');
  if (accounts.some((a) => a.email === current)) select.value = current;
  fillSettings();
  const ai = $('#ai-enabled') as HTMLInputElement;
  ai.checked = accounts.some((a) => a.status?.settings?.aiEnabled);
  ai.disabled = !accounts.length;
  const own = accounts.find((a) => a.status?.settings?.ownGeminiKey)?.status?.settings?.ownGeminiKey || '';
  ($('#own-key') as HTMLInputElement).placeholder = own ? `Saved: ••••${own.slice(-4)}` : 'Your Gemini API key (optional)';
}

function selected(): AccountRow | undefined { return accounts.find((a) => a.email === ($('#settings-account') as HTMLSelectElement).value); }

function fillSettings() {
  const acc = selected();
  const settings = acc?.status?.settings;
  if (!settings) return;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach((el) => {
    const key = el.dataset.setting as keyof Settings;
    if (el instanceof HTMLInputElement) el.checked = Boolean(settings[key]); else el.value = String(settings[key]);
  });
  ($('#learning') as HTMLInputElement).checked = acc.status?.mode !== 'assisting';
}

async function saveSetting(patch: Partial<Settings>, emails = [selected()?.email].filter(Boolean) as string[]) {
  for (const email of emails) await send({ type: 'act', email, action: { type: 'settings', patch } });
}

function setupCheck() {
  const id = chrome.runtime.id;
  const redirect = chrome.identity.getRedirectURL();
  const item = (ok: boolean, text: string) => `<span>${ok ? '✅' : '⚠️'}</span><span>${text}</span>`;
  $('#setup').innerHTML = [
    item(Boolean(CONFIG.googleClientId), CONFIG.googleClientId ? 'Google sign-in is configured.' : 'Google client ID missing in config.json (Gmail sign-in disabled).'),
    item(Boolean(CONFIG.microsoftClientId), CONFIG.microsoftClientId ? 'Microsoft sign-in is configured.' : 'Microsoft client ID missing in config.json (Outlook sign-in disabled).'),
    item(Boolean(CONFIG.proxyUrl), CONFIG.proxyUrl ? `Proxy: <code>${esc(CONFIG.proxyUrl)}</code>` : 'Proxy URL missing in config.json (needed for sign-in and the team Gemini key).'),
    item(Boolean(CONFIG.extensionKey), `Extension ID <code>${esc(id)}</code>${CONFIG.extensionKey ? '' : ' (not pinned: run <code>npm run keygen</code> so it never changes)'}`),
    item(true, `OAuth redirect URL to register with Google and Microsoft: <code>${esc(redirect)}</code>`),
    item(true, `Proxy ALLOWED_ORIGINS needs: <code>chrome-extension://${esc(id)}</code>`),
  ].join('');
  $('#mobile-link').innerHTML = CONFIG.mobileAppUrl
    ? `<a class="btn" href="${esc(CONFIG.mobileAppUrl)}" target="_blank" rel="noopener">Open the phone app</a> <code>${esc(CONFIG.mobileAppUrl)}</code><p class="muted">Open that link on your phone and use "Add to Home Screen" so it works like an app.</p>`
    : '<p class="muted">Set mobileAppUrl in config.json once the phone app is hosted.</p>';
}

document.addEventListener('click', async (event) => {
  const el = (event.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el) return;
  try {
    switch (el.dataset.act) {
      case 'connect': {
        el.setAttribute('disabled', '');
        const a = await send<{ email: string }>({ type: 'connect', provider: el.dataset.provider as 'google' | 'microsoft' });
        toast(`Connected ${a.email}. Studying your last 60 days of email…`);
        break;
      }
      case 'disconnect':
        if (!confirm(`Disconnect ${el.dataset.email}? What it learned stays in your cloud app folder, so reconnecting later picks up where you left off.`)) return;
        await send({ type: 'disconnect', email: el.dataset.email! }); toast('Disconnected.'); break;
      case 'save-key': {
        const key = ($('#own-key') as HTMLInputElement).value.trim();
        if (!/^[\w-]{20,}$/.test(key)) { toast('That does not look like a Gemini API key.', true); return; }
        await saveSetting({ ownGeminiKey: key, aiEnabled: true }, accounts.map((a) => a.email));
        ($('#own-key') as HTMLInputElement).value = ''; toast('Saved. AI features are on and use your own key.'); break;
      }
      case 'clear-key': await saveSetting({ ownGeminiKey: '' }, accounts.map((a) => a.email)); toast("Removed. AI features use the team's key again."); break;
    }
  } catch (error) { toast((error as Error).message, true); } finally { el.removeAttribute('disabled'); await load(); }
});

document.addEventListener('change', async (event) => {
  const el = event.target as HTMLInputElement | HTMLSelectElement;
  try {
    if (el.id === 'ai-enabled') { const on = (el as HTMLInputElement).checked; await saveSetting({ aiEnabled: on }, accounts.map((a) => a.email)); toast(on ? 'AI features on.' : 'AI features off. Sorting keeps working.'); }
    else if (el.id === 'demo') { await send({ type: 'demo', on: (el as HTMLInputElement).checked }); toast((el as HTMLInputElement).checked ? 'Demo inbox on. Open Gmail or Outlook to see it.' : 'Demo inbox removed.'); }
    else if (el.id === 'settings-account') fillSettings();
    else if (el.id === 'learning') { const email = selected()?.email; if (email) await send({ type: 'act', email, action: { type: 'set-mode', mode: (el as HTMLInputElement).checked ? 'learning' : 'assisting' } }); }
    else if (el.dataset.setting) await saveSetting({ [el.dataset.setting]: el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value } as Partial<Settings>);
  } catch (error) { toast((error as Error).message, true); }
  await load();
});

chrome.runtime.onMessage.addListener((msg: { type: string }) => { if (msg.type === 'changed') void load(); });
setupCheck();
void load();
