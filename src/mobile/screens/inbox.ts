/* Phone Inbox: Priority (ranked, color-coded) then Everything else, with CC'd mail tucked in its own section. */
import type { RowVM } from '../../core/service';
import { avatar, dueLabel, esc, firstName, shortTime } from '../../core/util';
import { accountButton, app, openDraft, openForward, openRemind, screens } from '../shell';

const ui = { query: '', ccOpen: false, threads: new Map<string, string>() };

function rowHtml(r: RowVM, zone: 'priority' | 'other' | 'cc'): string {
  const pri = zone === 'priority';
  const sug = r.suggestion;
  const chips: string[] = [];
  if (pri) chips.push(`<button class="row-chip suggest" data-act="row-reply" data-id="${r.id}">${r.analysis?.action === 'reply' ? '✦ Draft reply' : 'Reply'}</button>`);
  if (sug?.type === 'forward') chips.push(`<button class="row-chip suggest" data-act="row-forward" data-id="${r.id}">✦ ${esc(sug.label)}</button>`);
  if (pri || sug?.type === 'remind') chips.push(`<button class="row-chip" data-act="row-remind" data-id="${r.id}">${r.task ? `⏰ ${esc(dueLabel(r.task.due || Date.now()))}` : 'Remind'}</button>`);
  if (zone === 'cc' && r.threadCount >= 2) chips.push(`<button class="row-chip suggest" data-act="row-thread" data-thread="${esc(r.threadId)}">✦ Where did this end up?</button>`);
  const due = r.analysis?.due ? `<span class="pill ${Date.parse(r.analysis.due.iso) - Date.now() < 86400000 ? 'pill-red' : 'pill-orange'}">Due ${esc(r.analysis.due.label || dueLabel(Date.parse(r.analysis.due.iso)))}</span>` : '';
  const handled = r.handled ? `<span class="pill pill-green">${esc({ replied: 'Replied', forwarded: 'Forwarded', done: 'Done', filed: 'Filed' }[r.handled.type] || 'Done')} ✓</span>` : '';
  const summary = ui.threads.get(r.threadId);
  return `<div class="row ${pri ? `priority ${r.tier || ''}` : ''} ${r.unread ? 'unread' : ''} ${r.bulk ? 'dim' : ''}">
      <button class="row-open" data-act="open" data-id="${r.id}" aria-label="Open email from ${esc(r.from)}"></button>
      <div class="row-avatar">${avatar(r.from, 40)}${pri ? `<span class="rank">${r.rank}</span>` : ''}</div>
      <div class="row-body">
        <div class="row-line"><span class="row-from">${esc(r.from)}${r.threadCount > 1 ? ` <span class="muted small">${r.threadCount}</span>` : ''}</span><span class="row-time">${esc(shortTime(r.date))}</span></div>
        <div class="row-subject">${esc(pri && r.analysis?.headline ? r.analysis.headline : r.subject)} ${due}${handled}${r.attachment ? ' 📎' : ''}</div>
        ${pri ? `<div class="row-reason">✦ ${esc(r.reason)}</div>` : `<div class="row-snippet">${esc(r.snippet)}</div>`}
        ${chips.length ? `<div class="row-chips">${chips.join('')}</div>` : ''}
      </div></div>${summary ? `<div class="thread-sum">${summary}</div>` : ''}`;
}

const match = (r: RowVM) => { const q = ui.query.trim().toLowerCase(); return !q || [r.from, r.subject, r.snippet].some((t) => t.toLowerCase().includes(q)); };

function listHtml(): string {
  const v = app.view!;
  const notices: string[] = [];
  if (v.status.error) notices.push(`<div class="notice error">⚠ ${esc(v.status.error)}</div>`);
  if (!v.status.backfilled) notices.push('<div class="notice"><span class="spinner"></span> Studying your last 60 days of email to learn your habits. One minute…</div>');
  else if (v.mode === 'learning') notices.push(`<div class="notice">✦ Learning how you work (${Math.round(v.learning.rate * 100)}% match). Your inbox stays in date order until I reach 85%. Swipe in Sort to teach me faster.</div>`);
  const cc = v.cc.filter(match);
  const ccHtml = cc.length ? `<div class="section-gap"></div><button class="section-head" style="width:100%;border:none;background:none;text-align:left" data-act="toggle-cc">
      <span class="section-title">CC'd</span><span class="section-sub">${v.settings.ccFolder && v.mode === 'assisting' ? 'filed in your CC folder' : 'you were only copied'}</span><span class="count">${cc.length}</span><span>${ui.ccOpen ? '▾' : '▸'}</span></button>
      ${ui.ccOpen ? cc.map((r) => rowHtml(r, 'cc')).join('') : ''}` : '';
  if (v.mode === 'learning') {
    const rows = [...v.priority, ...v.others].filter(match).sort((a, b) => b.date - a.date);
    return `${notices.join('')}<div class="section-head"><span class="section-title">Inbox</span><span class="section-sub"></span><span class="count">${rows.length}</span></div>${rows.map((r) => rowHtml(r, 'other')).join('') || '<div class="empty">No messages.</div>'}${ccHtml}`;
  }
  const pri = v.priority.filter(match);
  const rest = v.others.filter(match);
  return `${notices.join('')}
    <div class="section-head priority"><span class="section-title">● Priority</span><span class="section-sub">ranked by how you usually act</span><span class="count">${pri.length}</span></div>
    ${pri.map((r) => rowHtml(r, 'priority')).join('') || `<div class="empty">${ui.query ? 'No priority emails matched.' : 'Nothing needs you right now.'}</div>`}
    <div class="section-gap"></div>
    <div class="section-head"><span class="section-title">Everything else</span><span class="section-sub"></span><span class="count">${rest.length}</span></div>
    ${rest.map((r) => rowHtml(r, 'other')).join('') || '<div class="empty">No other messages.</div>'}${ccHtml}`;
}

screens.inbox = {
  tab: 'inbox',
  render() {
    const v = app.view!;
    return `<div class="head"><div class="head-text"><div class="eyebrow">${v.mode === 'assisting' ? 'PRIORITY INBOX' : 'LEARNING'}</div><h1>Inbox</h1></div>
        ${v.account.kind === 'demo' ? '<button class="icon-btn" data-act="simulate" aria-label="Deliver a demo email">＋</button>' : ''}
        <button class="icon-btn" data-act="sync" aria-label="Refresh">${v.status.syncing ? '<span class="spinner"></span>' : '↻'}</button>${accountButton()}</div>
      <label class="searchbar"><span>⌕</span><input id="m-search" type="search" placeholder="Search your inbox" value="${esc(ui.query)}" autocomplete="off"></label>
      <div class="scroll" id="m-list">${listHtml()}</div>`;
  },
  mount(root) {
    root.querySelector('#m-search')?.addEventListener('input', (e) => {
      ui.query = (e.target as HTMLInputElement).value;
      (root.querySelector('#m-list') as HTMLElement).innerHTML = listHtml();
    });
  },
  onChange() {
    const list = document.querySelector('#m-list');
    if (!list || document.activeElement?.id !== 'm-search') return true;
    list.innerHTML = listHtml();
    return false;
  },
};

app.on({
  open: (el) => app.go(`email/${encodeURIComponent(el.dataset.id!)}`),
  'row-reply': (el) => openDraft(el.dataset.id!),
  'row-forward': (el) => openForward(el.dataset.id!),
  'row-remind': (el) => openRemind(el.dataset.id!),
  'toggle-cc': () => { ui.ccOpen = !ui.ccOpen; app.render(); },
  'row-thread': async (el) => {
    const threadId = el.dataset.thread!;
    if (ui.threads.has(threadId)) { ui.threads.delete(threadId); app.render(); return; }
    ui.threads.set(threadId, '<span class="spinner"></span> Reading the whole thread…'); app.render();
    try {
      const s = await app.service!.threadSummary(threadId);
      ui.threads.set(threadId, `<b>Where it ended up:</b> ${esc(s.whereItEnded)}${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}${s.openItems.length ? `<div style="color:#b3261e"><b>Still open:</b> ${s.openItems.map(esc).join('; ')}</div>` : ''}<div class="muted small">${s.messageCount} messages · last from ${esc(firstName(s.lastFrom))}</div>`);
    } catch (error) { ui.threads.set(threadId, `Could not summarize: ${esc((error as Error).message)}`); }
    app.render();
  },
  sync: () => app.run(app.service!.sync().then(() => app.service!.flush()).then(() => 'Up to date.')),
  simulate: () => app.run(app.service!.act({ type: 'simulate-arrival' })),
});
