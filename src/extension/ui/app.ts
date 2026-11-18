/* The in-page Priority Assistant: a ranked inbox drawn over the native list, our own reading view, and the
   side panel (next move, up next, due this week, what I moved, confidence). Same code on Gmail and Outlook. */
import type { CalendarItem, RowVM, View } from '../../core/service';
import type { Analysis, FullMessage, Person, ThreadSummary } from '../../core/types';
import { avatar, dueLabel, esc, firstName, plural, shortTime, startOfDay } from '../../core/util';
import type { Backend } from './backend';
import type { Site } from '../sites';
import css from './styles.css';

type Handler = (el: HTMLElement, event: Event) => void | Promise<void>;
const DAY = 86400000;

interface SheetCtx { kind: 'draft' | 'forward' | 'remind' | 'confirm'; id: string; [key: string]: unknown }

export class PaApp {
  private shadow: ShadowRoot;
  private els: { overlay: HTMLElement; panel: HTMLElement; sheet: HTMLElement; toasts: HTMLElement; pill: HTMLElement };
  private view: View | null = null;
  private reason = 'starting';
  private message = '';
  private handlers: Record<string, Handler> = {};
  private ui = {
    tab: 'inbox' as 'inbox' | 'cc',
    query: '',
    reading: null as null | { id: string; threadId: string },
    conv: null as FullMessage[] | null,
    convError: '',
    expanded: new Set<string>(),
    threads: new Map<string, ThreadSummary | 'loading' | { error: string }>(),
    analyses: new Map<string, Analysis | 'loading'>(),
    panelOpen: true,
    priorityView: true,
    calOpen: true,
    movedOpen: false,
    whyOpen: false,
  };
  private sheet: SheetCtx | null = null;
  private root: HTMLElement;
  private lastRoute = '';

  constructor(private site: Site, private backend: Backend, private host: HTMLElement) {
    this.shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    const root = document.createElement('div');
    root.className = 'pa-root';
    root.innerHTML = '<div class="pa-overlay" hidden></div><button class="pa-pill" hidden></button><div class="pa-panel" hidden></div><div class="sheet-host" hidden></div><div class="toast-host" aria-live="polite"></div>';
    this.shadow.append(style, root);
    this.root = root;
    this.els = {
      overlay: root.querySelector('.pa-overlay')!, panel: root.querySelector('.pa-panel')!, sheet: root.querySelector('.sheet-host')!,
      toasts: root.querySelector('.toast-host')!, pill: root.querySelector('.pa-pill')!,
    };
    try {
      const saved = JSON.parse(localStorage.getItem('pa-ui') || '{}');
      if (typeof saved.panelOpen === 'boolean') this.ui.panelOpen = saved.panelOpen;
      if (typeof saved.priorityView === 'boolean') this.ui.priorityView = saved.priorityView;
    } catch { /* page storage unavailable: defaults are fine */ }
    this.registerActions();
    this.listen(root);
  }

  togglePanel() { this.ui.panelOpen = !this.ui.panelOpen; this.saveUi(); this.render(); }

  private saveUi() { try { localStorage.setItem('pa-ui', JSON.stringify({ panelOpen: this.ui.panelOpen, priorityView: this.ui.priorityView })); } catch { /* ignore */ } }

  async start() {
    this.backend.onChange(() => void this.refresh());
    await this.refresh();
    const tick = () => {
      // Each step on its own, so a failure in one never stops the others (popups must still be lifted).
      try {
        const route = `${location.pathname}${location.hash}`;
        if (route !== this.lastRoute) { this.lastRoute = route; this.render(); }
      } catch (error) { console.error('Priority Assistant render failed', error); }
      try { this.layout(); } catch (error) { console.error('Priority Assistant layout failed', error); }
      try { this.liftPopups(); } catch (error) { console.error('Priority Assistant popup check failed', error); }
    };
    setInterval(tick, 400);
    window.addEventListener('resize', () => this.layout());
    // Capture phase, so it runs before Gmail/Outlook handle (and maybe swallow) the click.
    // mousedown so it's instant; click still covers keyboard activation.
    document.addEventListener('mousedown', (event) => this.onPageClick(event), true);
    document.addEventListener('click', (event) => this.onPageClick(event), true);
    // A click on the page may open Compose or a menu: lift it above our layer right away instead of on the next tick.
    for (const type of ['mouseup', 'keyup']) {
      document.addEventListener(type, () => { for (const ms of [0, 60, 200, 500]) setTimeout(() => { try { this.liftPopups(); } catch { /* next tick retries */ } }, ms); }, true);
    }
  }

  private lifted = new WeakSet<Element>();
  /** Containers we raised but had to put back because they would have blocked clicks on our overlay. */
  private unliftable = new WeakSet<Element>();
  /** A popup we could not raise above our layer (its page container blocks it); we step aside while it is open. */
  private yieldFor: Element | null = null;

  /** Gmail/Outlook's own popups (Compose windows, menus, dialogs) go above our overlay and panel. We find the
      outermost positioned box around each one (but never one that holds the inbox list) and raise its z-index. */
  private liftPopups() {
    if (!this.site.popupSelector) return;
    const main = document.querySelector(this.site.hideSelector);
    // Containers we know hold the page's popups (Gmail's Compose dock) are raised directly.
    if (this.site.liftSelector) for (const box of document.querySelectorAll<HTMLElement>(this.site.liftSelector)) this.lift(box);
    for (const el of document.querySelectorAll(this.site.popupSelector)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue; // hidden for now; looked at again once it shows
      let box: HTMLElement | null = null;
      for (let a: HTMLElement | null = el as HTMLElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        if (main && a.contains(main)) break;
        if (this.lifted.has(a)) { box = null; break; } // already handled
        if (getComputedStyle(a).position !== 'static') box = a;
      }
      if (box) this.lift(box);
    }
    this.checkStillCovered(main);
  }

  /** Raise one page container above our layer, unless doing so would block clicks on our overlay or panel. */
  private lift(box: HTMLElement) {
    if (this.lifted.has(box) || this.unliftable.has(box)) return;
    if (getComputedStyle(box).position === 'static') return; // z-index would do nothing
    box.style.setProperty('z-index', '2147483000', 'important');
    const probes = [this.els.overlay, this.els.panel].filter((e) => !e.hidden).map((e) => e.getBoundingClientRect()).map((r) => [r.left + 24, r.top + 24]);
    const blocks = probes.some(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && hit !== this.host && box.contains(hit)); });
    if (blocks) { box.style.removeProperty('z-index'); this.unliftable.add(box); return; }
    this.lifted.add(box);
  }

  /** Backup for the lift: if an open popup is still underneath our overlay or panel, hide them until it closes. */
  private checkStillCovered(main: Element | null) {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const onScreen = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      return el.isConnected && r.width > 0 && r.height > 0 && onScreen && getComputedStyle(el).visibility !== 'hidden';
    };
    let next: Element | null = this.yieldFor && visible(this.yieldFor) ? this.yieldFor : null;
    if (!next) {
      for (const el of document.querySelectorAll(this.site.popupSelector!)) {
        if (main?.contains(el) || !visible(el)) continue;
        const r = el.getBoundingClientRect();
        const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
        if (document.elementFromPoint(x, y) === this.host) { next = el; break; }
      }
    }
    if (next !== this.yieldFor) { this.yieldFor = next; this.layout(); }
  }

  /** A click in the mail page's own sidebar (Starred, Sent, a label…) turns Priority view off right away,
      so whatever they picked is never hidden under the overlay. */
  private onPageClick(event: MouseEvent) {
    if (this.els.overlay.hidden || event.button !== 0 || event.composedPath().includes(this.host)) return;
    const target = event.target instanceof Element ? event.target : null;
    // Compose opens on top of the overlay, so it can stay in Priority view.
    if (this.site.keepPriorityViewSelector && target?.closest(this.site.keepPriorityViewSelector)) return;
    // Dragging a sidebar's scrollbar isn't "picking something".
    if (target && target.clientWidth && event.offsetX > target.clientWidth) return;
    const o = this.els.overlay.getBoundingClientRect();
    // The left column starts under the mail page's top bar (Compose sits above the inbox list's top edge).
    const bannerBottom = document.querySelector('header[role="banner"], [role="banner"], #gb')?.getBoundingClientRect().bottom || 0;
    const top = bannerBottom > 0 ? Math.min(o.top, bannerBottom) : o.top;
    const inSidebar = Boolean(this.site.sidebarSelector && target?.closest(this.site.sidebarSelector))
      || (event.clientX > 0 && event.clientX < o.left && event.clientY >= top);
    if (!inSidebar) return;
    this.ui.priorityView = false; this.ui.reading = null; this.saveUi(); this.render();
    this.toast(`Priority view is off so you can use ${this.site.label}. Turn it back on in the assistant panel.`, 'ok', () => void this.handlers['priority-view'](this.root, new Event('click')));
  }

  async refresh() {
    try {
      const result = await this.backend.view();
      this.view = result.view;
      this.reason = result.reason || '';
      this.message = result.message || '';
    } catch (error) {
      this.view = null; this.reason = 'error'; this.message = (error as Error).message;
    }
    if (this.ui.reading && this.view && !this.findRow(this.ui.reading.id)) { /* email left the list; keep the reading view open */ }
    this.render();
  }

  /* ------------------------------------------------------------ helpers */

  private $(sel: string, root: ParentNode = this.shadow) { return root.querySelector(sel) as HTMLElement | null; }
  private allRows(): RowVM[] { const v = this.view; return v ? [...v.priority, ...v.others, ...v.cc] : []; }
  private findRow(id: string): RowVM | undefined { return this.allRows().find((r) => r.id === id); }

  toast(message: string, kind: 'ok' | 'error' = 'ok', undo?: () => void) {
    if (!message) return;
    const node = document.createElement('div');
    node.className = `toast${kind === 'error' ? ' toast-error' : ''}`;
    node.textContent = message;
    if (undo) { const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => { undo(); node.remove(); }; node.append(b); }
    while (this.els.toasts.children.length >= 2) this.els.toasts.firstChild!.remove();
    this.els.toasts.append(node);
    setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3800);
  }

  private async run(promise: Promise<string>, after?: () => void) {
    try { const msg = await promise; this.toast(msg); after?.(); } catch (error) { console.error(error); this.toast((error as Error).message || 'That did not work.', 'error'); }
  }

  private matches(r: RowVM) {
    const q = this.ui.query.trim().toLowerCase();
    return !q || [r.from, r.fromEmail, r.subject, r.snippet].some((t) => t.toLowerCase().includes(q));
  }

  /* ------------------------------------------------------------ layout */

  private showOverlay(): boolean {
    return Boolean(this.view) && this.ui.priorityView && (this.site.isListRoute() || Boolean(this.ui.reading));
  }

  /** While the overlay is up, hide the native list underneath so the two never show through each other. */
  private hideNative(hide: boolean) {
    const id = 'priority-assistant-hide-native';
    let style = document.getElementById(id);
    if (hide && !style) {
      style = document.createElement('style');
      style.id = id;
      style.textContent = `${this.site.hideSelector} { visibility: hidden !important; }`;
      (document.head || document.documentElement).append(style);
    } else if (!hide && style) style.remove();
  }

  layout() {
    this.root.classList.toggle('dark', this.site.isDark());
    this.root.classList.toggle('yield', Boolean(this.yieldFor));
    this.hideNative(!this.els.overlay.hidden && !this.yieldFor);
    const insets = this.site.panelInsets();
    const panelW = 360;
    const panelVisible = !this.els.panel.hidden;
    const p = this.els.panel;
    p.style.top = `${insets.top}px`; p.style.right = `${insets.right}px`; p.style.bottom = `${insets.bottom}px`;
    this.els.pill.style.top = `${insets.top}px`; this.els.pill.style.right = `${insets.right}px`;
    if (!this.els.overlay.hidden) {
      const rect = this.site.listRect() || new DOMRect(256, 64, window.innerWidth - 256, window.innerHeight - 64);
      const panelLeft = window.innerWidth - insets.right - panelW - 12;
      const right = panelVisible ? Math.min(rect.right, panelLeft) : rect.right;
      const o = this.els.overlay;
      o.style.left = `${rect.left}px`; o.style.top = `${rect.top}px`;
      o.style.width = `${Math.max(320, right - rect.left)}px`;
      o.style.height = `${Math.max(240, Math.min(rect.bottom, window.innerHeight - 8) - rect.top)}px`; // Gmail's list can be taller than the window
    }
  }

  render() {
    this.renderOverlay();
    this.renderPanel();
    this.layout();
  }

  /* ------------------------------------------------------------ overlay */

  private renderOverlay() {
    const o = this.els.overlay;
    const show = this.showOverlay();
    o.hidden = !show;
    if (!show || !this.view) return;
    const v = this.view;
    const scroll = this.$('.ov-body', o)?.scrollTop || 0;
    const searchFocused = this.shadow.activeElement?.id === 'pa-search';
    const ccCount = v.cc.filter((r) => !r.handled).length;
    o.innerHTML = `
      <div class="ov-bar">
        <span class="ov-title"><span class="spark">✦</span> ${v.mode === 'assisting' ? 'Priority inbox' : 'Inbox'}</span>
        <div class="seg"><button class="${this.ui.tab === 'inbox' ? 'on' : ''}" data-act="tab" data-tab="inbox">Inbox</button><button class="${this.ui.tab === 'cc' ? 'on' : ''}" data-act="tab" data-tab="cc">CC'd${ccCount ? ` <span class="badge">${ccCount}</span>` : ''}</button></div>
        <label class="ov-search"><span aria-hidden="true">⌕</span><input id="pa-search" type="search" placeholder="Search these emails" value="${esc(this.ui.query)}" autocomplete="off"></label>
        <span class="ov-tools">
          ${v.account.kind === 'demo' ? '<button class="btn btn-small btn-ghost" data-act="simulate" title="Demo: deliver a new email">+ New email</button>' : ''}
          <button class="icon-btn" data-act="sync" title="Check for new mail">${v.status.syncing ? '<span class="spinner"></span>' : '↻'}</button>
          <label class="switch-row" style="flex:none" title="Turn off to see your normal ${this.site.label} inbox"><button class="switch on" role="switch" aria-checked="true" data-act="native"><span></span></button>Priority view</label>
        </span>
      </div>
      <div class="ov-body">${this.ui.reading ? this.readingHtml() : this.listHtml()}</div>`;
    const body = this.$('.ov-body', o)!;
    body.scrollTop = this.ui.reading ? body.scrollTop : scroll;
    if (searchFocused) { const input = this.$('#pa-search', o) as HTMLInputElement; input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  private renderListBody() {
    const body = this.$('.ov-body', this.els.overlay);
    if (body && !this.ui.reading) { const s = body.scrollTop; body.innerHTML = this.listHtml(); body.scrollTop = s; }
  }

  private notices(): string {
    const v = this.view!;
    const out: string[] = [];
    if (v.status.error) out.push(`<div class="notice-bar error">⚠ ${esc(v.status.error)} <button class="link-btn" data-act="sync">Try again</button>${/sign/i.test(v.status.error) ? ' <button class="link-btn" data-act="connect">Reconnect</button>' : ''}</div>`);
    if (!v.status.backfilled) out.push('<div class="notice-bar"><span class="spinner"></span> Studying the last 60 days of your email so I can learn your habits. This takes a minute the first time.</div>');
    else if (v.mode === 'learning') out.push(`<div class="notice-bar">✦ Learning how you work: ${Math.round(v.learning.rate * 100)}% match so far. Your inbox stays as it is until I reach 85%.</div>`);
    return out.join('');
  }

  private listHtml(): string {
    const v = this.view!;
    if (this.ui.tab === 'cc') {
      const rows = v.cc.filter((r) => this.matches(r));
      return `${this.notices()}<div class="section-label">Copied on <span class="sub">emails where you were only CC'd${v.settings.ccFolder && v.mode === 'assisting' ? ', filed in your CC folder' : ''}</span><span class="count">${rows.length}</span></div>
        ${rows.map((r) => this.rowHtml(r, 'cc')).join('') || '<div class="empty">Nothing here. Emails you are only CC\'d on will collect here.</div>'}`;
    }
    if (v.mode === 'learning') {
      const rows = [...v.priority, ...v.others].filter((r) => this.matches(r)).sort((a, b) => b.date - a.date);
      return `${this.notices()}<div class="section-label">Inbox <span class="count">${rows.length}</span></div>${rows.map((r) => this.rowHtml(r, 'plain')).join('') || '<div class="empty">No messages.</div>'}`;
    }
    const pri = v.priority.filter((r) => this.matches(r));
    const rest = v.others.filter((r) => this.matches(r));
    return `${this.notices()}
      <section class="zone" data-zone="priority">
        <div class="section-label priority-label"><span class="dot"></span>Priority <span class="sub">ranked by how you usually act</span><span class="count">${pri.length}</span></div>
        ${pri.map((r) => this.rowHtml(r, 'priority')).join('') || `<div class="empty">${this.ui.query ? 'No priority emails matched.' : 'Nothing needs you right now. Drag an email here, or use ↑ Make priority.'}</div>`}
      </section>
      <section class="zone" data-zone="other">
        <div class="section-label">Everything else <span class="sub">${v.settings.everythingElseOrder === 'newest' ? 'newest first' : 'most likely to need you first'}</span><span class="count">${rest.length}</span></div>
        ${rest.map((r) => this.rowHtml(r, 'other')).join('') || '<div class="empty">No other messages.</div>'}
      </section>`;
  }

  private handledChip(r: RowVM): string {
    if (!r.handled) return '';
    const text = ({ replied: 'Replied ✓', forwarded: `Forwarded${r.handled.to ? ` to ${firstName(r.handled.to)}` : ''} ✓`, done: 'Done ✓', filed: `Filed${r.handled.to ? ` in ${r.handled.to}` : ''}` } as Record<string, string>)[r.handled.type] || '';
    return text ? `<span class="pill pill-ok">${esc(text)}</span>` : '';
  }

  private rowHtml(r: RowVM, zone: 'priority' | 'other' | 'cc' | 'plain'): string {
    const isPri = zone === 'priority';
    const sug = r.suggestion;
    const due = r.analysis?.due ? `<span class="pill ${Date.parse(r.analysis.due.iso) - Date.now() < DAY ? 'pill-urgent' : 'pill-warn'}">Due ${esc(r.analysis.due.label || dueLabel(Date.parse(r.analysis.due.iso)))}</span>` : '';
    const reminder = r.task?.due ? `<span class="pill pill-accent">⏰ ${esc(dueLabel(r.task.due))}</span>` : '';
    const suggestPill = !isPri && sug && zone === 'other' ? `<button class="pill-btn suggest" data-act="suggest" data-id="${r.id}">${esc(sug.label)}?</button>` : '';
    const thread = zone === 'cc' && r.threadCount >= 2 ? `<button class="pill-btn suggest" data-act="thread-sum" data-thread="${esc(r.threadId)}">✦ Where did this end up? (${r.threadCount})</button>` : '';
    const actions = isPri
      ? `<button class="pill-btn primary" data-act="draft" data-id="${r.id}">${r.analysis?.action === 'reply' ? 'Draft' : 'Reply'}</button>
         ${sug?.type === 'forward' ? `<button class="pill-btn" data-act="forward" data-id="${r.id}">${esc(sug.label)}</button>` : ''}
         <button class="pill-btn" data-act="remind" data-id="${r.id}">${r.task ? 'Reminded' : 'Remind'}</button>
         <button class="pill-btn" data-act="not-priority" data-id="${r.id}">↓ Not priority</button>`
      : `<button class="pill-btn" data-act="draft" data-id="${r.id}">Reply</button>
         <button class="pill-btn" data-act="remind" data-id="${r.id}">Remind</button>
         ${zone !== 'plain' ? `<button class="pill-btn" data-act="make-priority" data-id="${r.id}">↑ Make priority</button>` : ''}`;
    const summary = this.ui.threads.get(r.threadId);
    const sumHtml = zone === 'cc' && summary ? this.threadSumHtml(summary) : '';
    return `<div class="mail-row ${isPri ? `priority ${r.tier || ''}` : ''} ${r.unread ? 'unread' : ''} ${r.bulk && !isPri ? 'dim' : ''}" ${zone === 'priority' || zone === 'other' ? 'draggable="true"' : ''} tabindex="0" data-act="open" data-id="${r.id}" data-zone="${zone}">
        ${isPri ? `<span class="rank" title="${r.tier === 'urgent' ? 'Urgent' : 'Important'}">${r.rank}</span>` : '<span class="check"></span>'}
        <span class="star${r.flagged ? ' on' : ''}" aria-hidden="true">${r.flagged ? '★' : '☆'}</span>
        <span class="from">${esc(r.from)}${r.threadCount > 1 ? ` <span class="muted small">${r.threadCount}</span>` : ''}</span>
        <span class="subject"><span class="subject-line"><b>${esc(r.analysis?.headline && isPri ? r.analysis.headline : r.subject)}</b> – ${esc(r.snippet)}</span>${isPri ? `<span class="row-reason">✦ ${esc(r.reason)}</span>` : ''}</span>
        <span class="meta">${this.handledChip(r)}${due}${reminder}${suggestPill}${thread}${r.attachment ? '<span class="clip" title="Attachment">📎</span>' : ''}</span>
        <span class="time">${esc(shortTime(r.date))}</span>
        <span class="row-actions">${actions}</span>
      </div>${sumHtml}`;
  }

  private threadSumHtml(s: ThreadSummary | 'loading' | { error: string }): string {
    if (s === 'loading') return '<div class="thread-sum"><span class="spinner"></span> Reading the whole thread…</div>';
    if ('error' in s) return `<div class="thread-sum">Could not summarize: ${esc(s.error)}</div>`;
    return `<div class="thread-sum"><b>Where it ended up:</b> ${esc(s.whereItEnded)}
      ${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${s.openItems.length ? `<div class="open-items"><b>Still open:</b> ${s.openItems.map(esc).join('; ')}</div>` : ''}
      <div class="muted small">${s.messageCount} messages · last from ${esc(s.lastFrom)}</div></div>`;
  }

  /* ------------------------------------------------------------ reading view */

  private readingHtml(): string {
    const reading = this.ui.reading!;
    const row = this.findRow(reading.id);
    const conv = this.ui.conv;
    const subject = row?.subject || conv?.[conv.length - 1]?.subject || '';
    const tools = `<div class="reading-tools"><button class="icon-btn" data-act="back" title="Back to inbox">←</button><span class="muted">Back to inbox</span>
      <span style="margin-left:auto" class="btn-row">
        ${row ? `<button class="btn btn-small btn-ghost" data-act="${row.priority ? 'not-priority' : 'make-priority'}" data-id="${row.id}">${row.priority ? '↓ Not priority' : '↑ Make priority'}</button>` : ''}
        ${row ? `<button class="btn btn-small btn-ghost" data-act="archive" data-id="${row.id}">Archive</button><button class="btn btn-small btn-ghost" data-act="trash" data-id="${row.id}">Delete</button>` : ''}
        <button class="btn btn-small" data-act="open-native" data-id="${esc(reading.id)}">Open in ${this.site.label} ↗</button>
      </span></div>`;
    const banner = row?.suggestion ? `<div class="suggest-banner"><span class="spark">✦</span><div><b>Suggested: ${esc(row.suggestion.label)}</b><div class="muted">${esc(row.suggestion.why)}</div></div>
        <button class="btn btn-primary btn-small" data-act="suggest" data-id="${row.id}">Review</button><button class="btn btn-ghost btn-small" data-act="dismiss" data-id="${row.id}">Dismiss</button></div>` : '';
    let messages = '<div class="empty"><span class="spinner"></span> Loading…</div>';
    if (this.ui.convError) messages = `<div class="empty">${esc(this.ui.convError)}</div>`;
    else if (conv) {
      messages = conv.map((m, i) => {
        const last = i === conv.length - 1;
        const open = last || this.ui.expanded.has(m.id);
        return `<div class="msg${open ? '' : ' collapsed'}" ${open ? '' : `data-act="expand" data-id="${m.id}"`}>
          <div class="msg-head">${avatar(m.from.name, 36)}<div><b>${esc(m.from.name)}</b> <span class="muted small">&lt;${esc(m.from.email)}&gt;</span>
            <div class="msg-to">to ${esc(m.to.map((p) => p.name).join(', ') || '—')}${m.cc.length ? ` · cc ${esc(m.cc.map((p) => p.name).join(', '))}` : ''}</div></div>
            <span class="when">${esc(new Date(m.date).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span></div>
          <div class="msg-snip">${esc(m.snippet)}</div>
          <div class="msg-body">${esc(m.body.text || m.snippet)}</div>
          ${m.body.attachments.length ? `<div class="atts">${m.body.attachments.map((a) => `<span class="att">📎 ${esc(a.name)}</span>`).join('')}</div>` : ''}
        </div>`;
      }).join('');
    }
    const threadBtn = conv && conv.length >= 3 && row ? `<button class="btn btn-soft" data-act="thread-sum" data-thread="${esc(reading.threadId)}">✦ Summarize this thread</button>` : '';
    const summary = this.ui.threads.get(reading.threadId);
    const actions = row ? `<div class="reading-actions">
        <button class="btn btn-primary" data-act="draft" data-id="${row.id}">↩ ${row.analysis?.action === 'reply' ? 'Review drafted reply' : 'Reply'}</button>
        <button class="btn" data-act="forward" data-id="${row.id}">Forward</button>
        <button class="btn" data-act="remind" data-id="${row.id}">Remind me</button>
        ${row.handled ? `<button class="btn btn-ghost" data-act="undone" data-id="${row.id}">Not done</button>` : `<button class="btn btn-ghost" data-act="done" data-id="${row.id}">Mark done</button>`}
        ${threadBtn}</div>` : '';
    return `<div class="reading">${tools}${banner}
      <h1 class="reading-subject">${esc(subject)} ${row?.priority ? `<span class="pill ${row.tier === 'urgent' ? 'pill-urgent' : 'pill-accent'}">Priority #${row.rank}</span>` : ''}${row ? this.handledChip(row) : ''}</h1>
      ${summary ? this.threadSumHtml(summary).replace('class="thread-sum"', 'class="thread-sum" style="margin:0 0 12px"') : ''}
      ${messages}${actions}</div>`;
  }

  private async openReading(id: string) {
    const row = this.findRow(id);
    if (!row) return;
    this.ui.reading = { id, threadId: row.threadId };
    this.ui.conv = null; this.ui.convError = ''; this.ui.expanded.clear();
    this.render();
    void this.backend.act({ type: 'opened', id }).catch(() => undefined);
    void this.ensureAnalysis(id);
    try {
      this.ui.conv = await this.backend.conversation(row.threadId);
      if (!this.ui.conv.length) this.ui.convError = 'This conversation could not be loaded.';
    } catch (error) { this.ui.convError = (error as Error).message; }
    if (this.ui.reading?.id === id) this.renderOverlay();
  }

  private async ensureAnalysis(id: string, force = false) {
    if (this.ui.analyses.get(id) === 'loading' || (!force && this.ui.analyses.has(id))) return;
    this.ui.analyses.set(id, 'loading');
    this.renderPanel();
    try { this.ui.analyses.set(id, await this.backend.analyze(id, force)); } catch (error) { console.warn(error); this.ui.analyses.delete(id); }
    this.renderPanel();
  }

  /* ------------------------------------------------------------ panel */

  private renderPanel() {
    const p = this.els.panel;
    const pill = this.els.pill;
    if (!this.ui.panelOpen) {
      p.hidden = true; pill.hidden = false;
      const waiting = this.view?.mode === 'assisting' ? this.view.priority.length : 0;
      pill.innerHTML = `✦ Priority Assistant${waiting ? ` <span class="badge">${waiting}</span>` : ''}`;
      pill.dataset.act = 'panel-toggle';
      this.layout();
      return;
    }
    p.hidden = false; pill.hidden = true;
    const scroll = this.$('.as-body', p)?.scrollTop || 0;
    const v = this.view;
    const subtitle = !v ? 'Not connected on this page' : `${v.mode === 'learning' ? 'Learning mode' : 'Suggestions on'} · ${v.account.email}`;
    p.innerHTML = `
      <div class="as-head"><span class="logo">✦</span><div><b>Priority Assistant</b><div class="muted">${esc(subtitle)}</div></div>
        ${v ? `<button class="icon-btn small" data-act="sync" title="Check for new mail">${v.status.syncing ? '<span class="spinner"></span>' : '↻'}</button>` : ''}
        <button class="icon-btn small" data-act="settings" title="Settings">⚙</button>
        <button class="icon-btn small" data-act="panel-toggle" title="Collapse">–</button></div>
      <div class="as-body">${this.panelBody()}</div>
      ${v ? `<div class="as-foot"><label class="switch-row"><button class="switch${v.mode === 'learning' ? ' on' : ''}" role="switch" aria-checked="${v.mode === 'learning'}" data-act="set-mode" data-mode="${v.mode === 'learning' ? 'assisting' : 'learning'}"><span></span></button>Learning mode</label>
        ${((on) => `<label class="switch-row" style="flex:none" title="${on ? `Show your normal ${this.site.label}` : 'Show your inbox sorted by priority'}"><button class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-act="${on ? 'native' : 'priority-view'}"><span></span></button>Priority view</label>`)(this.showOverlay())}</div>` : ''}`;
    const body = this.$('.as-body', p);
    if (body) body.scrollTop = scroll;
    this.layout();
  }

  private panelBody(): string {
    const v = this.view;
    if (!v) {
      if (this.reason === 'starting') return '<div class="empty"><span class="spinner"></span> Starting…</div>';
      return `<div class="featured"><div class="eyebrow">GET STARTED</div><div class="featured-title">Connect this ${this.site.label} account</div>
        <p class="muted">${esc(this.message || `I learn how you handle email (who you answer first, what you forward, what you skip) and rank your inbox by priority. Nothing is ever sent without your OK.`)}</p>
        <div class="btn-row"><button class="btn btn-primary" data-act="connect">Connect ${this.site.label}</button><button class="btn" data-act="demo">Try the demo inbox</button></div></div>`;
    }
    const parts: string[] = [];
    const reading = this.ui.reading ? this.findRow(this.ui.reading.id) : null;
    const nativeThread = !reading ? this.site.nativeThreadId() : null;
    const nativeRow = nativeThread ? this.allRows().filter((r) => r.threadId === nativeThread).sort((a, b) => b.date - a.date)[0] : null;
    const current = reading || nativeRow;
    if (current) parts.push(this.thisEmailHtml(current));
    if (v.mode === 'learning') parts.push(this.learningHtml());
    else {
      if (!current) parts.push(v.featured ? this.featuredHtml(v.featured) : '<div class="featured"><div class="featured-title">You are caught up</div><p class="muted">Nothing in Priority needs you right now.</p></div>');
      const next = v.upNext.filter((r) => r.id !== current?.id);
      if (next.length) parts.push(`<div class="field-label">Up next</div><div class="next-list">${next.map((r) => this.nextRowHtml(r)).join('')}</div>`);
    }
    parts.push(this.calendarHtml(v.calendar));
    if (v.moved.length) parts.push(this.movedHtml());
    if (v.mode === 'assisting') parts.push(this.confidenceHtml());
    return parts.join('');
  }

  private thisEmailHtml(r: RowVM): string {
    const a = this.ui.analyses.get(r.id) ?? r.analysis;
    if (!a && !this.ui.analyses.has(r.id)) void this.ensureAnalysis(r.id);
    const loading = a === 'loading' || !a;
    const an = a && a !== 'loading' ? a : null;
    return `<div class="this-email"><div class="eyebrow">THIS EMAIL</div>
      <div class="featured-title" style="font-size:15px">${esc(an?.headline || r.subject)}</div>
      ${loading ? '<div class="muted small"><span class="spinner"></span> Reading it for you…</div>' : ''}
      ${an?.bullets?.length ? `<ul>${an.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${an?.nextStep ? `<p class="small" style="margin:4px 0 8px"><b>Next step:</b> ${esc(an.nextStep)}</p>` : ''}
      <div class="muted small" style="margin-bottom:8px">${r.priority ? `Priority #${r.rank}: ` : ''}${esc(r.reason)}</div>
      <div class="btn-row">
        <button class="btn btn-primary btn-small" data-act="draft" data-id="${r.id}">${an?.action === 'reply' ? 'Draft reply' : 'Reply'}</button>
        ${r.suggestion?.type === 'forward' ? `<button class="btn btn-soft btn-small" data-act="forward" data-id="${r.id}">✦ ${esc(r.suggestion.label)}</button>` : `<button class="btn btn-small" data-act="forward" data-id="${r.id}">Forward</button>`}
        <button class="btn btn-small" data-act="remind" data-id="${r.id}">Remind</button>
        ${an?.phone ? `<button class="btn btn-small" data-act="call" data-phone="${esc(an.phone)}">Call ${esc(firstName(r.from))}</button>` : ''}
      </div>
      <label class="check-row"><button class="switch${r.senderPref === 'always' ? ' on' : ''}" data-act="always" data-email="${esc(r.fromEmail)}" data-name="${esc(r.from)}" data-on="${r.senderPref === 'always'}"><span></span></button>Always prioritize ${esc(firstName(r.from))}</label>
    </div>`;
  }

  private featuredHtml(r: RowVM): string {
    const a = r.analysis;
    const sug = r.suggestion;
    return `<div class="featured ${r.tier === 'urgent' ? 'urgent' : ''}">
      <div class="eyebrow">NEXT MOVE${r.tier === 'urgent' ? ' · URGENT' : ''}</div>
      <div class="featured-title">${esc(a?.headline || r.subject)}</div>
      ${a?.nextStep ? `<p>${esc(a.nextStep)}</p>` : ''}
      <p class="muted">${esc(r.from)} · ${esc(r.reason)}</p>
      <div class="btn-row">
        <button class="btn btn-primary" data-act="open" data-id="${r.id}">Open email</button>
        ${sug ? `<button class="btn btn-soft" data-act="suggest" data-id="${r.id}">✦ ${esc(sug.label)}</button>` : `<button class="btn" data-act="draft" data-id="${r.id}">Reply</button>`}
        <button class="btn" data-act="remind" data-id="${r.id}">Remind</button>
      </div></div>`;
  }

  private nextRowHtml(r: RowVM): string {
    const sug = r.suggestion;
    const chip = sug?.type === 'forward' ? { act: 'forward', label: 'Forward' } : sug?.type === 'remind' ? { act: 'remind', label: 'Remind' } : { act: 'draft', label: r.analysis?.action === 'reply' ? 'Draft' : 'Reply' };
    return `<div class="next-row"><span class="next-rank ${r.tier === 'urgent' && r.priority ? 'urgent' : ''}">${r.priority ? r.rank : '✦'}</span>
      <button class="next-main" data-act="open" data-id="${r.id}"><b>${esc(r.analysis?.headline || r.subject)}</b><span class="muted">${esc(sug ? sug.why : `${r.from} · ${r.reason}`)}</span></button>
      <button class="pill-btn" data-act="${chip.act}" data-id="${r.id}">${chip.label}</button>
      ${sug ? `<button class="icon-btn small" data-act="dismiss" data-id="${r.id}" title="Dismiss suggestion">×</button>` : ''}</div>`;
  }

  private calendarHtml(items: CalendarItem[]): string {
    const now = Date.now();
    const upcoming = items.filter((i) => !i.done && i.at < now + 7 * DAY);
    const head = `<button class="collapse-head field-label" data-act="toggle-cal"><span>Due this week${upcoming.length ? ` <span class="badge">${upcoming.length}</span>` : ''}</span><span>${this.ui.calOpen ? '▾' : '▸'}</span></button>`;
    if (!this.ui.calOpen) return head;
    if (!items.length) return `${head}<div class="muted small">No deadlines found yet. Use Remind on any email, and I'll add due dates I spot in your email.</div>`;
    const groups = new Map<string, CalendarItem[]>();
    for (const item of items.filter((i) => i.at < now + 7 * DAY)) {
      const days = Math.round((startOfDay(item.at) - startOfDay(now)) / DAY);
      const name = item.overdue ? 'Overdue' : item.kind === 'nudge' ? 'Follow up' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : new Date(item.at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      (groups.get(name) || groups.set(name, []).get(name)!).push(item);
    }
    return head + [...groups].map(([name, list]) => `<div class="cal-day"><div class="cal-day-name">${esc(name)}</div>${list.map((i) => `
      <div class="cal-item ${i.overdue ? 'overdue' : ''} ${i.kind === 'nudge' ? 'nudge' : ''} ${i.done ? 'done' : ''}">
        <span class="cal-time">${i.kind === 'nudge' ? '↺' : esc(new Date(i.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span>
        <button class="cal-text" data-act="open" data-id="${i.msgId}"><b>${esc(i.title)}</b><span>${esc(i.sub)}</span></button>
        ${i.kind === 'nudge' ? `<button class="icon-btn small" data-act="remind" data-id="${i.msgId}" title="Remind me">⏰</button>` : `<button class="icon-btn small" data-act="task-done" data-task="${esc(i.id)}" data-done="${!i.done}" title="${i.done ? 'Not done' : 'Done'}">${i.done ? '↺' : '✓'}</button>`}
      </div>`).join('')}</div>`).join('');
  }

  private movedHtml(): string {
    const moved = this.view!.moved;
    const head = `<button class="collapse-head field-label" data-act="toggle-moved"><span>Moved for you <span class="badge">${moved.length}</span></span><span>${this.ui.movedOpen ? '▾' : '▸'}</span></button>`;
    if (!this.ui.movedOpen) return head;
    return head + moved.slice(0, 30).map((m) => `<div class="moved-row"><div><b>${esc(m.subject)}</b><span class="muted">${esc(m.from)} → ${esc(m.folderName)} · ${esc(m.reason)}</span></div><button class="btn btn-small" data-act="undo-move" data-id="${esc(m.msgId)}">Undo</button></div>`).join('')
      + '<p class="fine">Undo puts it back in your inbox and teaches me not to file emails like it.</p>';
  }

  private confidenceHtml(): string {
    const v = this.view!;
    const why = this.ui.whyOpen ? `<ul class="why-list">${v.confidence.why.map((w, i) => `<li><b>${i + 1}. ${esc(w.who)}</b>: ${esc(w.why)}</li>`).join('') || '<li class="muted">Nothing in Priority yet.</li>'}</ul>` : '';
    return `<div class="confidence"><div class="conf-head"><span>Sorting confidence</span><b>${v.confidence.value}%</b></div>
      <div class="meter"><span style="width:${v.confidence.value}%"></span></div>
      <div class="muted small">${esc(v.confidence.lastLearned)}</div>
      <button class="link-btn" data-act="toggle-why">${this.ui.whyOpen ? 'Hide' : 'Why this order?'}</button>${why}</div>`;
  }

  private learningHtml(): string {
    const v = this.view!;
    const pct = Math.round(v.learning.rate * 100);
    return `<div class="learn-card"><div class="learn-title">Learning how you work</div>
      <p class="muted small">I'm watching quietly: who you answer first, what you forward, what you skip and where you file things. No changes to your inbox until my guesses match what you actually do 85% of the time.</p>
      <div class="conf-head" style="margin-top:10px"><span>My guesses match you</span><b>${v.learning.n ? `${pct}%` : '—'}</b></div>
      <div class="meter"><span style="width:${pct}%"></span><i title="85% turns suggestions on"></i></div>
      <div class="muted small">${v.learning.n < v.learning.needed ? `${v.learning.n} of ${v.learning.needed} checks so far.` : pct >= 85 ? 'Ready. Suggestions turn on automatically.' : 'Getting closer with every email you handle.'}</div></div>
      <div class="stat-grid">${v.learning.stats.map(([label, n]) => `<div class="stat"><b>${n}</b><span>${esc(label)}</span></div>`).join('')}</div>
      ${v.learning.notes.length ? `<div class="field-label">What I've noticed</div><ul class="notes">${v.learning.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <button class="btn btn-primary" style="width:100%;margin-top:8px" data-act="set-mode" data-mode="assisting">Turn on suggestions now</button>`;
  }

  /* ------------------------------------------------------------ sheets */

  private openSheet(ctx: SheetCtx, html: string) {
    this.sheet = ctx;
    this.els.sheet.hidden = false;
    this.els.sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    (this.$('textarea, .btn-primary', this.els.sheet) as HTMLElement | null)?.focus();
  }

  private closeSheet() { this.sheet = null; this.els.sheet.hidden = true; this.els.sheet.innerHTML = ''; }

  private async openDraft(id: string, preset?: string) {
    const r = this.findRow(id);
    if (!r) return;
    const multi = (this.ui.conv?.[this.ui.conv.length - 1]?.cc.length || 0) > 0 || r.cc;
    this.openSheet({ kind: 'draft', id }, `
      <div class="sheet-head"><b>Reply to ${esc(firstName(r.from))}</b><span class="pill pill-warn">Draft · not sent yet</span></div>
      <div class="sheet-meta">To: ${esc(r.from)} &lt;${esc(r.fromEmail)}&gt;<br>Subject: Re: ${esc(r.subject)}</div>
      ${r.analysis?.nextStep ? `<div class="why">✦ ${esc(r.analysis.nextStep)}</div>` : ''}
      <textarea id="pa-draft" class="draft-edit" rows="8" placeholder="Drafting a reply in your style…">${esc(preset || '')}</textarea>
      ${multi ? '<label class="check-row"><input type="checkbox" id="pa-replyall"> Reply all</label>' : ''}
      <div class="sheet-actions"><button class="btn btn-primary" data-act="draft-send">Approve &amp; send</button><button class="btn btn-ghost" data-act="sheet-close">Discard</button></div>
      <p class="fine">Nothing is sent until you approve it. Your edits teach me your style.</p>`);
    if (preset) return;
    const box = this.$('#pa-draft', this.els.sheet) as HTMLTextAreaElement;
    box.disabled = true;
    try {
      const text = await this.backend.draft(id);
      if (this.sheet?.id === id && this.sheet.kind === 'draft') { box.value = text; box.disabled = false; box.focus(); (this.sheet as SheetCtx).original = text; }
    } catch (error) {
      box.disabled = false; box.placeholder = 'Write your reply'; this.toast(`Could not draft a reply: ${(error as Error).message}`, 'error');
    }
  }

  private openForward(id: string, to?: Person) {
    const r = this.findRow(id);
    if (!r || !this.view) return;
    const suggested = r.suggestion?.type === 'forward' ? r.suggestion.to : undefined;
    const target = to || suggested;
    const people = this.view.coworkers.filter((p) => p.email !== target?.email);
    const me = firstName(this.view.account.name);
    this.openSheet({ kind: 'forward', id, to: target }, `
      <div class="sheet-head"><b>Forward this email</b><span class="pill pill-warn">Not sent yet</span></div>
      <div class="sheet-meta">${esc(r.from)} · ${esc(r.subject)}${r.attachment ? ' · 📎 attachments included' : ''}</div>
      ${target ? `<div class="person-card">${avatar(target.name, 38)}<div><b>Forward to ${esc(firstName(target.name))}</b>${target.email === suggested?.email ? ' <span class="pill pill-accent">Suggested</span>' : ''}<div class="muted small">${esc(target.email)}</div></div></div>
        ${target.email === suggested?.email ? `<div class="why">Why: ${esc(r.suggestion!.why)}</div>` : ''}` : ''}
      <div class="chips"><span class="muted small">${target ? 'Someone else?' : 'Send to:'}</span>${people.map((p) => `<button class="chip" data-act="fwd-pick" data-email="${esc(p.email)}" data-name="${esc(p.name)}">${esc(firstName(p.name))}</button>`).join('')}</div>
      <div style="display:flex;gap:6px;margin-top:8px"><input id="pa-fwd-email" class="text-input" type="email" placeholder="or type an email address"><button class="btn btn-small" data-act="fwd-typed">Use</button></div>
      <div class="field-label">Note to add</div>
      <textarea id="pa-fwd-note" class="draft-edit" rows="3">${esc(target ? `${firstName(target.name)}, can you take care of this? Thanks, ${me}` : `Can you take a look at this? Thanks, ${me}`)}</textarea>
      <div class="sheet-actions"><button class="btn btn-primary" data-act="fwd-send" ${target ? '' : 'disabled'}>Approve &amp; forward</button><button class="btn btn-ghost" data-act="sheet-close">Cancel</button></div>
      <p class="fine">Nothing is sent until you approve it.</p>`);
  }

  private openRemind(id: string) {
    const r = this.findRow(id);
    if (!r) return;
    const now = new Date();
    const at = (d: Date, h: number, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
    const tomorrow = new Date(now.getTime() + DAY);
    const monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
    const options: Array<[string, number]> = [
      ['In 1 hour', now.getTime() + 3600000],
      [now.getHours() < 14 ? 'This afternoon' : 'Tomorrow afternoon', now.getHours() < 14 ? at(now, 15) : at(tomorrow, 15)],
      ['Tomorrow morning', at(tomorrow, 7)],
      ['Next Monday', at(monday, 7)],
    ];
    const due = r.analysis?.due ? Date.parse(r.analysis.due.iso) : 0;
    if (due > Date.now() + 3600000) options.unshift([`Before it's due (${r.analysis!.due!.label || dueLabel(due)})`, due - 2 * 3600000]);
    const local = new Date(now.getTime() + 2 * 3600000 - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    this.openSheet({ kind: 'remind', id }, `
      <div class="sheet-head"><b>Remind me</b><button class="icon-btn" data-act="sheet-close" aria-label="Close">×</button></div>
      <div class="sheet-meta">${esc(r.from)} · ${esc(r.subject)}</div>
      <div class="remind-list">${options.map(([label, t], i) => `<button class="remind-option" data-act="remind-pick" data-at="${t}"><span>${esc(label)}</span><span class="muted">${esc(dueLabel(t))}</span>${i === 0 && due ? '<span class="pill pill-accent">Suggested</span>' : ''}</button>`).join('')}</div>
      <div class="remind-custom"><input id="pa-remind-at" type="datetime-local" value="${local}"><button class="btn btn-primary" data-act="remind-custom">Set</button></div>
      <p class="fine">It shows up in Due this week and on your phone.</p>`);
  }

  private async confirmSend(kind: 'reply' | 'forward', id: string, text: string, to: Person[], send: () => Promise<string>) {
    let check;
    try { check = await this.backend.sendCheck(kind, id, text, to); } catch { check = { reasons: [], needsConfirm: false }; }
    if (!check.needsConfirm) { await this.run(send(), () => this.closeSheet()); return; }
    const back = this.sheet;
    this.openSheet({ kind: 'confirm', id, send, back }, `
      <div class="sheet-head"><b>Are you sure?</b></div>
      <p>Please double-check before this ${kind === 'forward' ? 'forward' : 'reply'} goes to <b>${esc(to.map((p) => p.email).join(', '))}</b>:</p>
      <div class="warn-box"><ul>${check.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="sheet-actions"><button class="btn btn-danger" data-act="confirm-yes">Yes, send it</button><button class="btn" data-act="sheet-close">Cancel</button></div>`);
  }

  /* ------------------------------------------------------------ events */

  private listen(root: HTMLElement) {
    root.addEventListener('click', (event) => {
      const el = (event.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!el || !root.contains(el)) return;
      const handler = this.handlers[el.dataset.act!];
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(handler(el, event)).catch((error) => { console.error(error); this.toast((error as Error).message, 'error'); });
    });
    root.addEventListener('input', (event) => {
      const t = event.target as HTMLInputElement;
      if (t.id === 'pa-search') { this.ui.query = t.value; this.renderListBody(); }
    });
    root.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'Escape') { if (this.sheet) this.closeSheet(); else if (this.ui.reading) { this.ui.reading = null; this.render(); } }
      if (e.key === 'Enter' && (e.target as HTMLElement).matches?.('.mail-row')) (e.target as HTMLElement).click();
      e.stopPropagation(); // keep Gmail/Outlook keyboard shortcuts from firing while typing in our UI
    });
    root.addEventListener('keypress', (e) => e.stopPropagation());
    this.els.sheet.addEventListener('click', (event) => { if (event.target === this.els.sheet) this.closeSheet(); });
    // drag between Priority and Everything else (teaches the model, like the MVP)
    root.addEventListener('dragstart', (event) => {
      const row = (event.target as HTMLElement).closest?.('.mail-row[draggable]') as HTMLElement | null;
      if (!row) return;
      event.dataTransfer!.setData('text/plain', row.dataset.id!);
      row.classList.add('dragging');
    });
    root.addEventListener('dragend', () => root.querySelectorAll('.dragging, .drop-over').forEach((n) => n.classList.remove('dragging', 'drop-over')));
    root.addEventListener('dragover', (event) => {
      const zone = (event.target as HTMLElement).closest?.('.zone');
      if (!zone) return;
      event.preventDefault();
      root.querySelectorAll('.drop-over').forEach((n) => n.classList.remove('drop-over'));
      zone.classList.add('drop-over');
    });
    root.addEventListener('drop', (event) => {
      const zone = (event.target as HTMLElement).closest?.('.zone') as HTMLElement | null;
      const id = event.dataTransfer?.getData('text/plain');
      if (!zone || !id) return;
      event.preventDefault();
      const row = this.findRow(id);
      if (!row) return;
      if (zone.dataset.zone === 'priority' && !row.priority) void this.run(this.backend.act({ type: 'make-priority', id }));
      if (zone.dataset.zone === 'other' && row.priority) void this.run(this.backend.act({ type: 'not-priority', id }));
    });
  }

  private registerActions() {
    const act = (type: 'make-priority' | 'not-priority' | 'done' | 'undone' | 'dismiss') => (el: HTMLElement) => this.run(this.backend.act({ type, id: el.dataset.id! }));
    this.handlers = {
      open: (el) => this.openReading(el.dataset.id!),
      back: () => { this.ui.reading = null; this.render(); },
      expand: (el) => { this.ui.expanded.add(el.dataset.id!); this.renderOverlay(); },
      tab: (el) => { this.ui.tab = el.dataset.tab as 'inbox' | 'cc'; this.ui.reading = null; this.render(); },
      native: () => { this.ui.priorityView = false; this.ui.reading = null; this.saveUi(); this.render(); },
      'priority-view': () => {
        this.ui.priorityView = true; this.saveUi();
        // Turned on from Starred, Sent, a label…: go to the inbox, which is what Priority view sorts.
        if (!this.site.isListRoute() && !this.ui.reading) this.site.goToInbox();
        this.render();
      },
      'open-native': async (el) => {
        const row = this.findRow(el.dataset.id!);
        if (!row) return;
        const path = await this.backend.webPath(row.id).catch(() => null);
        this.ui.reading = null; this.ui.priorityView = this.site.name === 'outlook' ? this.ui.priorityView : true;
        this.site.openNative(row, path);
        this.render();
      },
      'make-priority': act('make-priority'),
      'not-priority': act('not-priority'),
      done: act('done'),
      undone: act('undone'),
      dismiss: act('dismiss'),
      trash: (el) => this.run(this.backend.act({ type: 'trash', id: el.dataset.id! }), () => { this.ui.reading = null; this.render(); }),
      archive: (el) => this.run(this.backend.act({ type: 'archive', id: el.dataset.id! }), () => { this.ui.reading = null; this.render(); }),
      always: (el) => this.run(this.backend.act({ type: 'sender-pref', email: el.dataset.email!, name: el.dataset.name!, pref: el.dataset.on === 'true' ? null : 'always' })),
      suggest: (el) => {
        const r = this.findRow(el.dataset.id!);
        const type = r?.suggestion?.type;
        if (type === 'forward') this.openForward(r!.id);
        else if (type === 'remind') this.openRemind(r!.id);
        else if (type === 'call' && r?.analysis?.phone) this.toast(`Call ${firstName(r.from)}: ${r.analysis.phone}`);
        else return this.openDraft(el.dataset.id!);
      },
      draft: (el) => this.openDraft(el.dataset.id!),
      forward: (el) => this.openForward(el.dataset.id!),
      remind: (el) => this.openRemind(el.dataset.id!),
      call: (el) => { void navigator.clipboard?.writeText(el.dataset.phone!).catch(() => undefined); this.toast(`${el.dataset.phone} (copied)`); },
      'thread-sum': async (el) => {
        const threadId = el.dataset.thread!;
        if (this.ui.threads.get(threadId) && this.ui.threads.get(threadId) !== 'loading' && !this.ui.reading) { this.ui.threads.delete(threadId); this.renderOverlay(); return; }
        this.ui.threads.set(threadId, 'loading'); this.renderOverlay();
        try { this.ui.threads.set(threadId, await this.backend.thread(threadId)); } catch (error) { this.ui.threads.set(threadId, { error: (error as Error).message }); }
        this.renderOverlay();
      },
      'undo-move': (el) => this.run(this.backend.act({ type: 'undo-move', id: el.dataset.id! })),
      'task-done': (el) => this.run(this.backend.act({ type: 'task-done', taskId: el.dataset.task!, done: el.dataset.done === 'true' })),
      'set-mode': (el) => this.run(this.backend.act({ type: 'set-mode', mode: el.dataset.mode as 'learning' | 'assisting' })),
      'panel-toggle': () => this.togglePanel(),
      'toggle-why': () => { this.ui.whyOpen = !this.ui.whyOpen; this.renderPanel(); },
      'toggle-cal': () => { this.ui.calOpen = !this.ui.calOpen; this.renderPanel(); },
      'toggle-moved': () => { this.ui.movedOpen = !this.ui.movedOpen; this.renderPanel(); },
      sync: () => this.run(this.backend.act({ type: 'sync' }).then(() => 'Up to date.')),
      simulate: () => this.run(this.backend.act({ type: 'simulate-arrival' })),
      settings: () => this.backend.openSettings(),
      connect: () => this.backend.connect(),
      demo: () => this.backend.startDemo(),
      'sheet-close': () => this.closeSheet(),
      'draft-send': async () => {
        const ctx = this.sheet!;
        const r = this.findRow(ctx.id);
        const text = (this.$('#pa-draft', this.els.sheet) as HTMLTextAreaElement).value.trim();
        if (!text) { this.toast('Write something before sending.', 'error'); return; }
        const replyAll = Boolean((this.$('#pa-replyall', this.els.sheet) as HTMLInputElement | null)?.checked);
        const edited = typeof ctx.original === 'string' && ctx.original !== text;
        await this.confirmSend('reply', ctx.id, text, r ? [{ name: r.from, email: r.fromEmail }] : [], () => this.backend.act({ type: 'reply', id: ctx.id, text, replyAll, edited }));
      },
      'fwd-pick': (el) => { const note = (this.$('#pa-fwd-note', this.els.sheet) as HTMLTextAreaElement)?.value; this.openForward(this.sheet!.id, { email: el.dataset.email!, name: el.dataset.name! }); if (note && !/^\S+, can you take care/.test(note)) (this.$('#pa-fwd-note', this.els.sheet) as HTMLTextAreaElement).value = note; },
      'fwd-typed': () => {
        const email = (this.$('#pa-fwd-email', this.els.sheet) as HTMLInputElement).value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { this.toast('Type a full email address.', 'error'); return; }
        this.openForward(this.sheet!.id, { email: email.toLowerCase(), name: email.split('@')[0] });
      },
      'fwd-send': async () => {
        const ctx = this.sheet!;
        const to = ctx.to as Person | undefined;
        if (!to) { this.toast('Pick who to forward to.', 'error'); return; }
        const note = (this.$('#pa-fwd-note', this.els.sheet) as HTMLTextAreaElement).value.trim();
        await this.confirmSend('forward', ctx.id, note, [to], () => this.backend.act({ type: 'forward', id: ctx.id, to: [to], note }));
      },
      'remind-pick': (el) => { const id = this.sheet!.id; return this.run(this.backend.act({ type: 'remind', id, due: Number(el.dataset.at) }), () => this.closeSheet()); },
      'remind-custom': () => {
        const value = (this.$('#pa-remind-at', this.els.sheet) as HTMLInputElement).value;
        const due = Date.parse(value);
        if (!value || Number.isNaN(due)) { this.toast('Pick a date and time first.', 'error'); return; }
        const id = this.sheet!.id;
        return this.run(this.backend.act({ type: 'remind', id, due }), () => this.closeSheet());
      },
      'confirm-yes': async () => { const send = this.sheet!.send as () => Promise<string>; await this.run(send(), () => this.closeSheet()); },
    };
  }
}

export const describeCount = (n: number, word: string) => plural(n, word);
