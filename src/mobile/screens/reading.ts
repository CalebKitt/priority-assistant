/* Phone reading view: the assistant's take on top (headline, key points, next step), the conversation, actions. */
import type { Analysis, FullMessage } from '../../core/types';
import { avatar, esc, firstName } from '../../core/util';
import { app, header, openDraft, openForward, openRemind, screens } from '../shell';
import { canListen, listen } from '../voice';

const state = { id: '', conv: null as FullMessage[] | null, error: '', analysis: null as Analysis | null, expanded: new Set<string>(), summary: '' };

async function load(id: string) {
  const r = app.row(id);
  if (!r) return;
  state.id = id; state.conv = null; state.error = ''; state.analysis = null; state.expanded.clear(); state.summary = '';
  void app.service!.act({ type: 'opened', id }).catch(() => undefined);
  app.service!.analyze(id).then((a) => { if (state.id === id) { state.analysis = a; app.render(); } }).catch(() => undefined);
  try { state.conv = await app.service!.conversation(r.threadId); } catch (error) { state.error = (error as Error).message; }
  if (state.id === id) app.render();
}

screens.email = {
  render(route) {
    const r = app.row(route.id || '');
    if (!r) return `${header('Not found', { back: 'inbox' })}<div class="empty">That email is no longer in your recent inbox.</div>`;
    if (state.id !== r.id) void load(r.id);
    const a = state.analysis || (r.analysis as Analysis | null);
    const conv = state.conv;
    const msgs = state.error ? `<div class="empty">${esc(state.error)}</div>` : !conv ? '<div class="empty"><span class="spinner"></span></div>' : conv.map((m, i) => {
      const open = i === conv.length - 1 || state.expanded.has(m.id);
      return `<div class="msg${open ? '' : ' collapsed'}" ${open ? '' : `data-act="expand" data-id="${m.id}"`}>
        <div class="msg-head">${avatar(m.from.name, 36)}<div><b>${esc(m.from.name)}</b><div class="muted">to ${esc(m.to.map((p) => firstName(p.name)).join(', ') || 'you')}${m.cc.length ? ` · cc ${esc(m.cc.map((p) => firstName(p.name)).join(', '))}` : ''} · ${esc(new Date(m.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</div></div></div>
        <div class="msg-snip">${esc(m.snippet)}</div>
        <div class="msg-body">${esc(m.body.text || m.snippet)}</div>
        ${m.body.attachments.map((x) => `<span class="att">📎 ${esc(x.name)}</span>`).join('')}</div>`;
    }).join('');
    const sug = r.suggestion;
    return `<div class="head"><button class="icon-btn" data-act="go" data-to="inbox" aria-label="Back">←</button><span class="head-text"></span>
        <button class="icon-btn" data-act="r-archive" data-id="${r.id}" aria-label="Archive">🗄</button><button class="icon-btn" data-act="r-trash" data-id="${r.id}" aria-label="Delete">🗑</button></div>
      <div class="scroll"><div class="reading">
        <h1>${esc(r.subject)}</h1>
        <div class="labels">${r.priority ? `<span class="pill ${r.tier === 'urgent' ? 'pill-red' : 'pill-orange'}">Priority #${r.rank}</span>` : ''}${r.cc ? '<span class="pill">CC\'d</span>' : ''}${r.handled ? '<span class="pill pill-green">Handled ✓</span>' : ''}</div>
        <div class="assist-card"><div class="eyebrow">✦ ASSISTANT</div>
          <b>${esc(a?.headline || r.subject)}</b>
          ${a?.bullets?.length ? `<ul>${a.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
          ${a?.nextStep ? `<div>${esc(a.nextStep)}</div>` : '<div class="muted small"><span class="spinner"></span> Reading it for you…</div>'}
          <div class="muted small">${esc(r.reason)}</div>
          <div class="btn-row">${sug ? `<button class="btn btn-soft btn-small" data-act="r-suggest" data-id="${r.id}">✦ ${esc(sug.label)}</button>` : ''}
            ${a?.phone ? `<a class="btn btn-small" href="tel:${esc(a.phone.replace(/[^\d+]/g, ''))}">📞 Call ${esc(firstName(r.from))}</a>` : ''}
            ${conv && conv.length >= 3 ? `<button class="btn btn-small" data-act="r-summary" data-thread="${esc(r.threadId)}">Where did this end up?</button>` : ''}</div>
          ${state.summary ? `<div class="thread-sum" style="margin:6px 0 0">${state.summary}</div>` : ''}
        </div>
        ${msgs}
        <label class="toggle"><input type="checkbox" data-act="r-always" data-email="${esc(r.fromEmail)}" data-name="${esc(r.from)}" ${r.senderPref === 'always' ? 'checked' : ''}><span>Always prioritize ${esc(firstName(r.from))}</span></label>
      </div></div>
      <div class="actions">
        <button class="btn btn-primary" data-act="r-reply" data-id="${r.id}">↩ ${a?.action === 'reply' ? 'Drafted reply' : 'Reply'}</button>
        <button class="btn" data-act="r-voice" data-id="${r.id}">🎙 Voice reply</button>
        <button class="btn" data-act="r-forward" data-id="${r.id}">Forward</button>
        <button class="btn" data-act="r-remind" data-id="${r.id}">Remind me</button>
        <button class="btn" data-act="${r.priority ? 'not-priority' : 'make-priority'}" data-id="${r.id}">${r.priority ? '↓ Not priority' : '↑ Priority'}</button>
        <button class="btn" data-act="${r.handled ? 'undone' : 'done'}" data-id="${r.id}">${r.handled ? 'Not done' : '✓ Done'}</button>
      </div>`;
  },
  unmount() { state.id = ''; },
};

/** Tap-to-talk voice reply: listen, clean up with AI, then the normal approve/edit draft sheet. */
export async function voiceReply(id: string, onDone?: () => void, onClose?: () => void) {
  if (!canListen()) { app.toast('This browser cannot listen. Use Chrome on Android or Safari on iPhone.', 'error'); return; }
  const host = app.sheet(`<div class="sheet-head"><b>Say your reply</b></div><div class="sheet-meta">Speak naturally. I'll clean it up and show you before anything is sent.</div>
    <div style="text-align:center;padding:10px 0"><button class="mic-btn on" data-act="m-voice-stop">■</button></div>
    <div class="draft-edit" id="m-heard" style="min-height:70px;color:#444746">Listening…</div>`, onClose);
  const listening = listen((t) => { const box = host.querySelector('#m-heard'); if (box) box.textContent = t; }, { long: true, timeoutMs: 2500 });
  (host as HTMLElement & { _stop?: () => void })._stop = () => listening.stop();
  let text = '';
  try { text = await listening.result; } catch (error) { app.closeSheet(); app.toast((error as Error).message, 'error'); return; }
  if (!host.isConnected) return;
  if (!text) { app.closeSheet(); app.toast("I didn't catch that. Try again.", 'error'); return; }
  (host.querySelector('#m-heard') as HTMLElement).innerHTML = `${esc(text)}<br><span class="spinner"></span> Writing it up…`;
  const draft = await app.service!.voiceReply(id, text);
  app.closeSheet(false);
  await openDraft(id, { preset: draft, note: `From your voice note: “${text}”`, onSent: onDone, onClose });
}

app.on({
  expand: (el) => { state.expanded.add(el.dataset.id!); app.render(); },
  'r-reply': (el) => openDraft(el.dataset.id!),
  'r-voice': (el) => voiceReply(el.dataset.id!),
  'm-voice-reply': (el) => { app.closeSheet(false); return voiceReply(el.dataset.id!); },
  'm-voice-stop': (el) => (el.closest('.sheet-host') as HTMLElement & { _stop?: () => void })._stop?.(),
  'r-forward': (el) => openForward(el.dataset.id!),
  'r-remind': (el) => openRemind(el.dataset.id!),
  'r-suggest': (el) => {
    const r = app.row(el.dataset.id!);
    if (r?.suggestion?.type === 'forward') openForward(r.id);
    else if (r?.suggestion?.type === 'remind') openRemind(r.id);
    else return openDraft(el.dataset.id!);
  },
  'r-summary': async (el) => {
    state.summary = '<span class="spinner"></span> Reading the whole thread…'; app.render();
    try {
      const s = await app.service!.threadSummary(el.dataset.thread!);
      state.summary = `<b>Where it ended up:</b> ${esc(s.whereItEnded)}${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}${s.openItems.length ? `<div><b>Still open:</b> ${s.openItems.map(esc).join('; ')}</div>` : ''}`;
    } catch (error) { state.summary = esc((error as Error).message); }
    app.render();
  },
  'r-always': (el) => app.run(app.service!.act({ type: 'sender-pref', email: el.dataset.email!, name: el.dataset.name!, pref: (el as HTMLInputElement).checked ? 'always' : null })),
  'r-archive': (el) => app.run(app.service!.act({ type: 'archive', id: el.dataset.id! }), () => app.go('inbox')),
  'r-trash': async (el) => {
    const id = el.dataset.id!;
    try {
      await app.service!.act({ type: 'trash', id });
      app.go('inbox');
      app.toast('Moved to trash.', 'ok', () => void app.run(app.service!.act({ type: 'restore', id })));
    } catch (error) { app.toast((error as Error).message, 'error'); }
  },
  'make-priority': (el) => app.run(app.service!.act({ type: 'make-priority', id: el.dataset.id! })),
  'not-priority': (el) => app.run(app.service!.act({ type: 'not-priority', id: el.dataset.id! })),
  done: (el) => app.run(app.service!.act({ type: 'done', id: el.dataset.id! })),
  undone: (el) => app.run(app.service!.act({ type: 'undone', id: el.dataset.id! })),
});
