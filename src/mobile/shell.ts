/* Phone app shell: routing, the account/service, toasts, bottom sheets and the click-action registry.
   Screens register themselves in `screens` and read everything through `app`. */
import type { AssistantService, RowVM, View } from '../core/service';
import type { Person } from '../core/types';
import { avatar, dueLabel, esc, firstName } from '../core/util';

export interface Route { name: string; id?: string }
export interface Screen {
  tab?: string;
  dark?: boolean;
  render(route: Route): string;
  mount?(root: HTMLElement, route: Route): void;
  unmount?(): void;
  /** Called when mailbox data changes. Return false to skip the default full re-render (live screens). */
  onChange?(): boolean | void;
}

type Handler = (el: HTMLElement, event: Event) => unknown;

export const screens: Record<string, Screen> = {};

export const app = {
  service: null as AssistantService | null,
  view: null as View | null,
  route: { name: 'inbox' } as Route,
  handlers: {} as Record<string, Handler>,
  root: null as unknown as HTMLElement,
  current: null as Screen | null,
  signOut: () => {},

  on(map: Record<string, Handler>) { Object.assign(this.handlers, map); },

  rows(): RowVM[] { const v = this.view; return v ? [...v.priority, ...v.others, ...v.cc] : []; },
  row(id: string) { return this.rows().find((r) => r.id === id); },

  parseRoute(): Route {
    const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
    return { name: name || 'inbox', id: id ? decodeURIComponent(id) : undefined };
  },

  go(path: string) { if (location.hash !== `#/${path}`) location.hash = `#/${path}`; else this.render(); },

  refreshView() { this.view = this.service ? this.service.view() : null; },

  render() {
    this.route = this.parseRoute();
    const name = this.service ? this.route.name : 'welcome';
    const screen = screens[name] || screens.inbox;
    if (this.current !== screen) this.current?.unmount?.();
    this.current = screen;
    this.refreshView();
    const host = this.root.querySelector('#screen') as HTMLElement;
    const scroller = host.querySelector('.scroll');
    const keep = scroller && host.dataset.route === location.hash ? scroller.scrollTop : 0;
    host.className = `screen${screen.dark ? ' dark' : ''}`;
    host.dataset.route = location.hash;
    host.innerHTML = screen.render(this.route);
    const sc = host.querySelector('.scroll');
    if (sc && keep) sc.scrollTop = keep;
    screen.mount?.(host, this.route);
    this.renderTabs(screen);
  },

  renderTabs(screen: Screen) {
    const bar = this.root.querySelector('#tabbar') as HTMLElement;
    bar.hidden = !this.service || !screen.tab;
    if (bar.hidden) return;
    const v = this.view;
    const pri = v?.mode === 'assisting' ? v.priority.filter((r) => r.unread).length : 0;
    const tabs: Array<[string, string, string, number]> = [['inbox', 'Inbox', '✉', pri], ['sort', 'Sort', '⇆', 0], ['speak', 'Speak', '🎙', 0], ['summary', 'Summary', '✦', 0]];
    bar.innerHTML = tabs.map(([key, label, icon, badge]) => `<button class="tab${screen.tab === key ? ' active' : ''}" data-act="go" data-to="${key}">
      <span class="pill-ico">${icon}${badge ? `<span class="badge">${badge}</span>` : ''}</span><span>${label}</span></button>`).join('');
  },

  onData() {
    if (!this.service) return;
    this.refreshView();
    if (this.current?.onChange?.() === false) { this.renderTabs(this.current); return; }
    if (this.root.querySelector('.sheet-host')) return; // never redraw under an open sheet
    this.render();
  },

  toast(message: string, kind: 'ok' | 'error' = 'ok', undo?: () => void) {
    if (!message) return;
    const host = this.root.querySelector('.toasts') as HTMLElement;
    const node = document.createElement('div');
    node.className = `toast${kind === 'error' ? ' error' : ''}`;
    node.textContent = message;
    if (undo) { const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => { node.remove(); undo(); }; node.append(b); }
    while (host.children.length >= 2) host.firstChild!.remove();
    host.append(node);
    setTimeout(() => node.remove(), kind === 'error' ? 6000 : undo ? 5000 : 3200);
  },

  async run(work: Promise<string> | (() => Promise<string>), after?: () => void): Promise<boolean> {
    try { const msg = await (typeof work === 'function' ? work() : work); this.toast(msg); after?.(); return true; }
    catch (error) { console.error(error); this.toast((error as Error).message || 'That did not work.', 'error'); return false; }
  },

  sheet(html: string, onClose?: () => void) {
    this.closeSheet(false);
    const host = document.createElement('div');
    host.className = 'sheet-host';
    host.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
    host.addEventListener('click', (e) => { if (e.target === host) this.closeSheet(); });
    (host as HTMLElement & { _onClose?: () => void })._onClose = onClose;
    this.root.append(host);
    return host;
  },

  closeSheet(notify = true) {
    const host = this.root.querySelector('.sheet-host') as (HTMLElement & { _onClose?: () => void }) | null;
    if (!host) return;
    host.remove();
    if (notify) host._onClose?.();
  },
};

/* ------------------------------------------------------------------ shared sheets */

/** Draft reply: AI draft in your style, edit, then approve. Nothing is sent before Approve. */
export async function openDraft(id: string, opts: { preset?: string; note?: string; onClose?: () => void; onSent?: () => void } = {}) {
  const r = app.row(id);
  if (!r || !app.service) return;
  const host = app.sheet(`
    <div class="sheet-head"><b>Reply to ${esc(firstName(r.from))}</b><span class="pill pill-orange">Not sent yet</span></div>
    <div class="sheet-meta">Re: ${esc(r.subject)}</div>
    ${opts.note || r.analysis?.nextStep ? `<div class="why">✦ ${esc(opts.note || r.analysis!.nextStep)}</div>` : ''}
    <textarea class="draft-edit" id="m-draft" rows="7" placeholder="Drafting in your style…">${esc(opts.preset || '')}</textarea>
    <div class="sheet-actions"><button class="btn btn-primary" data-act="m-draft-send" data-id="${r.id}">Approve &amp; send</button><button class="btn" data-act="m-voice-reply" data-id="${r.id}">🎙 Say it</button><button class="btn btn-ghost" data-act="m-sheet-close">Discard</button></div>
    <p class="fine">Nothing is sent until you approve it.</p>`, opts.onClose);
  (host as HTMLElement & { _onSent?: () => void })._onSent = opts.onSent;
  if (opts.preset !== undefined) return;
  const box = host.querySelector('#m-draft') as HTMLTextAreaElement;
  box.disabled = true;
  try { const text = await app.service.draftFor(id); if (box.isConnected) { box.value = text; box.dataset.original = text; } }
  catch (error) { app.toast(`Could not draft: ${(error as Error).message}`, 'error'); }
  box.disabled = false;
}

export function openForward(id: string, opts: { to?: Person; onClose?: () => void; onSent?: () => void } = {}) {
  const r = app.row(id);
  if (!r || !app.view) return;
  const suggested = r.suggestion?.type === 'forward' ? r.suggestion.to : undefined;
  const target = opts.to || suggested;
  const me = firstName(app.view.account.name);
  const people = app.view.coworkers.filter((p) => p.email !== target?.email);
  const host = app.sheet(`
    <div class="sheet-head"><b>Forward</b><span class="pill pill-orange">Not sent yet</span></div>
    <div class="sheet-meta">${esc(r.from)} · ${esc(r.subject)}${r.attachment ? ' · 📎 attachments included' : ''}</div>
    ${target ? `<div class="person">${avatar(target.name, 40)}<div><b>To ${esc(target.name)}</b>${target.email === suggested?.email ? ' <span class="pill pill-orange">Suggested</span>' : ''}<div class="muted small">${esc(target.email)}</div></div></div>
      ${target.email === suggested?.email ? `<div class="why">${esc(r.suggestion!.why)}</div>` : ''}` : ''}
    <div class="chips">${people.map((p) => `<button class="chip" data-act="m-fwd-pick" data-id="${r.id}" data-email="${esc(p.email)}" data-name="${esc(p.name)}">${esc(firstName(p.name))}</button>`).join('')}</div>
    <div style="display:flex;gap:8px;margin-top:10px"><input class="text-input" id="m-fwd-email" type="email" inputmode="email" placeholder="or type an email"><button class="btn btn-small" data-act="m-fwd-typed" data-id="${r.id}">Use</button></div>
    <div class="field-label">Note</div>
    <textarea class="draft-edit" id="m-fwd-note" rows="3">${esc(target ? `${firstName(target.name)}, can you take care of this? Thanks, ${me}` : `Can you take a look at this? Thanks, ${me}`)}</textarea>
    <div class="sheet-actions"><button class="btn btn-primary" data-act="m-fwd-send" data-id="${r.id}" ${target ? '' : 'disabled'}>Approve &amp; forward</button><button class="btn btn-ghost" data-act="m-sheet-close">Cancel</button></div>`, opts.onClose);
  Object.assign(host, { _to: target, _onSent: opts.onSent, _onCloseOuter: opts.onClose });
}

export function openRemind(id: string, onClose?: () => void, onSet?: () => void) {
  const r = app.row(id);
  if (!r) return;
  const now = new Date();
  const at = (d: Date, h: number) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x.getTime(); };
  const tomorrow = new Date(now.getTime() + 86400000);
  const options: Array<[string, number]> = [
    ['In 1 hour', now.getTime() + 3600000],
    [now.getHours() < 14 ? 'This afternoon' : 'Tomorrow afternoon', now.getHours() < 14 ? at(now, 15) : at(tomorrow, 15)],
    ['Tomorrow morning', at(tomorrow, 7)],
  ];
  const due = r.analysis?.due ? Date.parse(r.analysis.due.iso) : 0;
  if (due > Date.now() + 3600000) options.unshift([`Before it's due`, due - 2 * 3600000]);
  const local = new Date(now.getTime() + 2 * 3600000 - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const host = app.sheet(`
    <div class="sheet-head"><b>Remind me</b></div><div class="sheet-meta">${esc(r.from)} · ${esc(r.subject)}</div>
    ${options.map(([label, t]) => `<button class="option" data-act="m-remind" data-id="${r.id}" data-at="${t}"><span>${esc(label)}</span><span class="muted">${esc(dueLabel(t))}</span></button>`).join('')}
    <div style="display:flex;gap:8px"><input class="text-input" id="m-remind-at" type="datetime-local" value="${local}"><button class="btn btn-primary" data-act="m-remind-custom" data-id="${r.id}">Set</button></div>`, onClose);
  Object.assign(host, { _onSet: onSet });
}

/** "Are you sure?" when a send has attachments, money words or outside recipients. */
async function guardedSend(kind: 'reply' | 'forward', id: string, text: string, to: Person[], send: () => Promise<string>, after: () => void) {
  const check = app.service!.sendCheck(kind, id, text, to);
  if (!check.needsConfirm) { if (await app.run(send)) after(); return; }
  const host = app.sheet(`
    <div class="sheet-head"><b>Are you sure?</b></div>
    <p>Double-check before this goes to <b>${esc(to.map((p) => p.email).join(', '))}</b>:</p>
    <div class="warn-box"><ul>${check.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    <div class="sheet-actions"><button class="btn btn-danger" data-act="m-confirm-yes">Yes, send it</button><button class="btn" data-act="m-sheet-close">Cancel</button></div>`);
  Object.assign(host, { _send: send, _after: after });
}

app.on({
  'm-sheet-close': () => app.closeSheet(),
  'm-draft-send': async (el) => {
    const host = el.closest('.sheet-host') as HTMLElement & { _onSent?: () => void };
    const box = host.querySelector('#m-draft') as HTMLTextAreaElement;
    const text = box.value.trim();
    const r = app.row(el.dataset.id!);
    if (!text || !r) { app.toast('Write something before sending.', 'error'); return; }
    const onSent = host._onSent;
    await guardedSend('reply', r.id, text, [{ name: r.from, email: r.fromEmail }], () => app.service!.act({ type: 'reply', id: r.id, text, edited: box.dataset.original !== undefined && box.dataset.original !== text }), () => { app.closeSheet(false); onSent?.(); });
  },
  'm-fwd-pick': (el) => openForward(el.dataset.id!, { to: { email: el.dataset.email!, name: el.dataset.name! }, ...outer(el) }),
  'm-fwd-typed': (el) => {
    const email = ((el.closest('.sheet') as HTMLElement).querySelector('#m-fwd-email') as HTMLInputElement).value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { app.toast('Type a full email address.', 'error'); return; }
    openForward(el.dataset.id!, { to: { email, name: email.split('@')[0] }, ...outer(el) });
  },
  'm-fwd-send': async (el) => {
    const host = el.closest('.sheet-host') as HTMLElement & { _to?: Person; _onSent?: () => void };
    const to = host._to;
    if (!to) { app.toast('Pick who to forward to.', 'error'); return; }
    const note = (host.querySelector('#m-fwd-note') as HTMLTextAreaElement).value.trim();
    const onSent = host._onSent;
    await guardedSend('forward', el.dataset.id!, note, [to], () => app.service!.act({ type: 'forward', id: el.dataset.id!, to: [to], note }), () => { app.closeSheet(false); onSent?.(); });
  },
  'm-confirm-yes': async (el) => {
    const host = el.closest('.sheet-host') as HTMLElement & { _send: () => Promise<string>; _after: () => void };
    if (await app.run(host._send)) host._after();
  },
  'm-remind': async (el) => {
    const host = el.closest('.sheet-host') as HTMLElement & { _onSet?: () => void };
    const onSet = host._onSet;
    if (await app.run(app.service!.act({ type: 'remind', id: el.dataset.id!, due: Number(el.dataset.at) }))) { app.closeSheet(false); onSet?.(); }
  },
  'm-remind-custom': async (el) => {
    const host = el.closest('.sheet-host') as HTMLElement & { _onSet?: () => void };
    const due = Date.parse((host.querySelector('#m-remind-at') as HTMLInputElement).value);
    if (Number.isNaN(due)) { app.toast('Pick a date and time.', 'error'); return; }
    const onSet = host._onSet;
    if (await app.run(app.service!.act({ type: 'remind', id: el.dataset.id!, due }))) { app.closeSheet(false); onSet?.(); }
  },
});

function outer(el: HTMLElement) {
  const host = el.closest('.sheet-host') as HTMLElement & { _onSent?: () => void; _onCloseOuter?: () => void };
  return { onSent: host?._onSent, onClose: host?._onCloseOuter };
}

export const header = (title: string, { back = '', eyebrow = '', right = '' } = {}) => `
  <div class="head">${back ? `<button class="icon-btn" data-act="go" data-to="${back}" aria-label="Back">←</button>` : ''}
    <div class="head-text">${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${esc(title)}</h1></div>${right}</div>`;

export const accountButton = () => {
  const v = app.view;
  if (!v) return '';
  return `<button class="account-btn" style="background:${'#2F6F9F'}" data-act="go" data-to="settings" aria-label="Settings">${esc(firstName(v.account.name)[0] || '?')}</button>`;
};
