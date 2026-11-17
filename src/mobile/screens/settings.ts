/* Sign-in (welcome) and Settings screens. */
import { CONFIG } from '../../core/config';
import type { Settings } from '../../core/types';
import { esc } from '../../core/util';
import { app, header, screens } from '../shell';

export const auth = {
  accounts: [] as Array<{ kind: string; email: string; name: string }>,
  signIn: (_provider: 'google' | 'microsoft') => {},
  startDemo: () => {},
  switchTo: (_email: string) => {},
  remove: (_email: string) => {},
  error: '',
};

screens.welcome = {
  render() {
    const ready = Boolean(CONFIG.proxyUrl);
    return `<div class="welcome">
      <img class="logo" src="icons/icon192.png" alt="">
      <h1>Your inbox, sorted by what matters to you</h1>
      <p class="muted">Priority Assistant learns how you handle email (who you answer first, what you forward, what you skip) and puts what needs you on top. Swipe to sort, and go hands-free on the drive home.</p>
      ${auth.error ? `<div class="notice error" style="margin:0">${esc(auth.error)}</div>` : ''}
      <button class="btn btn-primary big" data-act="sign-in" data-provider="google" ${ready && CONFIG.googleClientId ? '' : 'disabled'}>Continue with Google (Gmail)</button>
      <button class="btn big" data-act="sign-in" data-provider="microsoft" ${ready && CONFIG.microsoftClientId ? '' : 'disabled'}>Continue with Microsoft (Outlook)</button>
      <button class="btn btn-ghost big" data-act="start-demo">Try the demo inbox</button>
      ${ready ? '' : '<p class="fine">Sign-in is not set up in this build yet (see docs/SETUP.md). The demo works without it.</p>'}
      <p class="fine">Nothing is ever sent without your OK. What it learns stays in your own Google Drive or OneDrive.</p>
    </div>`;
  },
};

screens.settings = {
  render() {
    const v = app.view!;
    const st = v.settings;
    const toggle = (key: keyof Settings, title: string, sub: string) => `<label class="toggle"><input type="checkbox" data-act="set" data-key="${key}" ${st[key] ? 'checked' : ''}><span><b>${title}</b><br><span class="muted small">${sub}</span></span></label>`;
    return `${header('Settings', { back: 'inbox' })}
      <div class="scroll pad">
        <div class="card"><b>Accounts</b>
          ${auth.accounts.map((a) => `<div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-top:1px solid var(--line)"><div style="flex:1;min-width:0"><div>${esc(a.name)}</div><div class="muted small">${esc(a.email)} · ${a.kind === 'gmail' ? 'Gmail' : a.kind === 'outlook' ? 'Outlook' : 'Demo'}</div></div>
            ${a.email === v.account.email ? '<span class="pill pill-green">Active</span>' : `<button class="btn btn-small" data-act="switch" data-email="${esc(a.email)}">Use</button>`}
            <button class="btn btn-small btn-ghost" data-act="remove" data-email="${esc(a.email)}">Sign out</button></div>`).join('')}
          <div class="btn-row" style="margin-top:8px"><button class="btn btn-small" data-act="sign-in" data-provider="google" ${CONFIG.googleClientId ? '' : 'disabled'}>+ Gmail</button><button class="btn btn-small" data-act="sign-in" data-provider="microsoft" ${CONFIG.microsoftClientId ? '' : 'disabled'}>+ Outlook</button>${auth.accounts.some((a) => a.kind === 'demo') ? '' : '<button class="btn btn-small" data-act="start-demo">+ Demo</button>'}</div>
        </div>
        <div class="card"><b>Learning</b>
          <p class="muted small">${v.mode === 'assisting' ? `Suggestions are on. My guesses match yours ${Math.round(v.learning.rate * 100)}% of the time.` : `Learning quietly: ${Math.round(v.learning.rate * 100)}% match after ${v.learning.n} checks. Suggestions turn on at 85%.`}</p>
          <label class="toggle"><input type="checkbox" data-act="mode" ${v.mode === 'learning' ? 'checked' : ''}><span><b>Learning mode</b><br><span class="muted small">Watch only. No suggestions, no changes to your inbox.</span></span></label>
          ${v.learning.notes.length ? `<ul class="muted small" style="padding-left:18px">${v.learning.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="card"><b>What it may do</b>
          ${toggle('autoFile', 'File into your folders once confident', 'Only after 85% match. Undo any move from your computer.')}
          ${toggle('ccFolder', 'CC folder', "Emails you're only copied on go to a CC folder.")}
          ${toggle('colorLabels', 'Color-coded priority labels', 'Red and orange labels you can see in any mail app.')}
          <p class="muted small">It never sends, replies or forwards on its own.</p>
        </div>
        <div class="card"><b>AI features (optional)</b>
          ${toggle('aiEnabled', 'Turn on AI features', 'Summaries, next steps, reply drafts, the daily brief, chat and voice-reply cleanup. Sorting works the same with this off.')}
          <div class="privacy-box"><b>Your privacy</b><br>With AI on, the text of the emails it reads is sent to Google's Gemini. If you add your own <b>paid</b> Gemini key, your emails stay private: Google doesn't use them for training. With the team's key (or a free key), Google may use them to improve and train its AI.</div>
          <p class="muted small">Your own key (optional), from Google AI Studio with billing turned on.${st.ownGeminiKey ? ` Saved key ends in ${esc(st.ownGeminiKey.slice(-4))}.` : ''}</p>
          <div style="display:flex;gap:8px"><input class="text-input" id="own-key" type="password" placeholder="Gemini API key" autocomplete="off"><button class="btn btn-small" data-act="save-key">Save</button></div>
          ${st.ownGeminiKey ? '<button class="btn btn-small btn-ghost" data-act="clear-key" style="margin-top:6px">Use the team key instead</button>' : ''}
        </div>
        <div class="card"><b>Add to your home screen</b><p class="muted small">iPhone: tap Share, then "Add to Home Screen". Android: tap ⋮, then "Install app". It then opens full screen like a regular app.</p></div>
      </div>`;
  },
};

app.on({
  'sign-in': (el) => auth.signIn(el.dataset.provider as 'google' | 'microsoft'),
  'start-demo': () => auth.startDemo(),
  switch: (el) => auth.switchTo(el.dataset.email!),
  remove: (el) => { if (confirm(`Sign out of ${el.dataset.email} on this phone?`)) auth.remove(el.dataset.email!); },
  set: (el) => app.run(app.service!.act({ type: 'settings', patch: { [el.dataset.key!]: (el as HTMLInputElement).checked } as Partial<Settings> })),
  mode: (el) => app.run(app.service!.act({ type: 'set-mode', mode: (el as HTMLInputElement).checked ? 'learning' : 'assisting' })),
  'save-key': () => {
    const key = (document.querySelector('#own-key') as HTMLInputElement).value.trim();
    if (!/^[\w-]{20,}$/.test(key)) { app.toast('That does not look like a Gemini API key.', 'error'); return; }
    return app.run(app.service!.act({ type: 'settings', patch: { ownGeminiKey: key, aiEnabled: true } }).then(() => 'Saved. AI features are on and use your key.'));
  },
  'clear-key': () => app.run(app.service!.act({ type: 'settings', patch: { ownGeminiKey: '' } }).then(() => "AI features use the team's key again.")),
});
