/* Swipe to sort. Right = Priority, Left = Trash, Up = Forward (to the suggested person), Down = Later.
   Every swipe teaches the model; two in a row for one sender offers an "always" rule (Max's favorite). */
import type { RowVM } from '../../core/service';
import { esc, firstName, shortTime } from '../../core/util';
import { app, header, openDraft, openForward, screens } from '../shell';
import { attachSwipe, type Dir } from '../swipe';

const session = { done: new Set<string>(), bySender: new Map<string, Dir[]>(), prompt: null as null | { email: string; name: string; pref: 'always' | 'later' }, total: 0 };
let swiper: ReturnType<typeof attachSwipe> | null = null;

function queue(): RowVM[] {
  const v = app.view!;
  return [...v.priority, ...v.others].filter((r) => !r.handled && !session.done.has(r.id)).sort((a, b) => Number(b.unread) - Number(a.unread) || b.date - a.date).slice(0, 60);
}

function card(r: RowVM, cls: string): string {
  const a = r.analysis;
  const sug = r.suggestion;
  return `<div class="swipe-card ${cls}" ${cls === 'top' ? 'id="sort-card"' : ''}>
    <div class="swipe-meta"><span>${esc(r.from)}</span><span>${esc(shortTime(r.date))}</span></div>
    <h2>${esc(a?.headline || r.subject)}</h2>
    ${a?.bullets?.length ? `<ul>${a.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : `<p>${esc(r.snippet)}</p>`}
    <div class="swipe-foot">
      ${r.priority ? `<span class="pill ${r.tier === 'urgent' ? 'pill-red' : 'pill-orange'}">Priority #${r.rank}</span>` : ''}
      ${sug?.type === 'forward' ? `<span class="pill pill-blue">▲ ${esc(sug.label)}</span>` : ''}
      ${r.attachment ? '<span class="pill">📎</span>' : ''}
      <button class="btn btn-small" data-act="sort-reply" data-id="${r.id}" style="margin-left:auto">Reply</button>
    </div></div>`;
}

screens.sort = {
  tab: 'sort',
  render() {
    const q = queue();
    session.total = Math.max(session.total, q.length + session.done.size);
    const p = session.prompt;
    const prompt = p ? `<div class="pref-prompt"><span>${p.pref === 'always' ? `Always prioritize <b>${esc(firstName(p.name))}</b>?` : `Keep <b>${esc(firstName(p.name))}</b> out of Priority?`}</span>
      <button class="btn btn-small btn-primary" data-act="sort-pref-yes">Yes</button><button class="btn btn-small" data-act="sort-pref-no">Not now</button></div>` : '';
    if (!q.length) {
      const v = app.view!;
      return `${header('Sort', { eyebrow: 'ALL DONE' })}<div class="scroll">${prompt}<div class="done-card"><div class="done-icon">✓</div><h2>All sorted</h2>
        <p class="muted">Your inbox reordered to match your swipes, here and on your computer.</p>
        <div style="width:100%;text-align:left;margin-top:8px"><div style="display:flex;justify-content:space-between;font-weight:600"><span>Sorting confidence</span><span>${v.confidence.value}%</span></div><div class="meter"><span style="width:${v.confidence.value}%"></span></div><div class="muted small">${esc(v.confidence.lastLearned)}</div></div>
        <div class="btn-row two" style="width:100%;margin-top:10px"><button class="btn btn-primary" data-act="go" data-to="inbox">See inbox</button><button class="btn" data-act="sort-again">Sort again</button></div></div></div>`;
    }
    const [top, next] = q;
    return `${header('Sort', { eyebrow: `${q.length} LEFT`, right: `<span class="pill" style="margin-right:12px">${session.done.size} of ${session.total}</span>` })}
      <div class="scroll" style="overflow:hidden">${prompt}
        <div class="swipe-stage" id="sort-stage">
          <div class="cue cue-up">▲ FORWARD</div><div class="cue cue-left">◀ TRASH</div><div class="cue cue-right">PRIORITY ▶</div><div class="cue cue-down">▼ LATER</div>
          ${next ? card(next, 'under') : ''}${card(top, 'top')}
        </div>
        <div class="dir-buttons">
          <button class="btn" data-act="sort-dir" data-dir="left">◀ Trash</button><button class="btn" data-act="sort-dir" data-dir="up">▲ Fwd</button>
          <button class="btn" data-act="sort-dir" data-dir="down">▼ Later</button><button class="btn" data-act="sort-dir" data-dir="right">Priority ▶</button>
        </div>
        <p class="fine" style="text-align:center">Each swipe teaches the assistant. Trash can be undone.</p>
      </div>`;
  },
  mount(root) {
    const c = root.querySelector('#sort-card') as HTMLElement | null;
    swiper = c ? attachSwipe(c, root.querySelector('#sort-stage') as HTMLElement, { dirs: ['left', 'right', 'up', 'down'], onCommit: commit }) : null;
  },
  unmount() { swiper = null; },
  onChange() { return false; }, // never yank the card mid-swipe; we re-render after each decision
};

function remember(r: RowVM, dir: Dir) {
  session.done.add(r.id);
  const list = [...(session.bySender.get(r.fromEmail) || []), dir];
  session.bySender.set(r.fromEmail, list);
  const last2 = list.slice(-2);
  if (last2.length === 2 && last2.every((d) => d === 'right') && r.senderPref !== 'always') session.prompt = { email: r.fromEmail, name: r.from, pref: 'always' };
  if (last2.length === 2 && last2.every((d) => d === 'down' || d === 'left') && r.senderPref !== 'later') session.prompt = { email: r.fromEmail, name: r.from, pref: 'later' };
}

async function commit(dir: Dir, restore: () => void) {
  const r = queue()[0];
  if (!r || !app.service) return;
  const advance = () => { remember(r, dir); app.refreshView(); app.render(); };
  try {
    if (dir === 'right') { await app.service.act({ type: 'make-priority', id: r.id }); advance(); }
    else if (dir === 'down') { await app.service.act({ type: 'later', id: r.id }); advance(); }
    else if (dir === 'left') {
      await app.service.act({ type: 'trash', id: r.id });
      advance();
      app.toast(`Trashed ${firstName(r.from)}'s email`, 'ok', () => { session.done.delete(r.id); void app.run(app.service!.act({ type: 'restore', id: r.id })).then(() => app.render()); });
    } else if (dir === 'up') {
      openForward(r.id, { onSent: advance, onClose: restore });
    }
  } catch (error) {
    restore();
    app.toast((error as Error).message, 'error');
  }
}

app.on({
  'sort-dir': (el) => swiper?.fling(el.dataset.dir as Dir),
  'sort-reply': (el) => openDraft(el.dataset.id!, { onSent: () => { session.done.add(el.dataset.id!); app.render(); } }),
  'sort-again': () => { session.done.clear(); session.total = 0; app.render(); },
  'sort-pref-yes': async () => {
    const p = session.prompt; session.prompt = null;
    if (p) await app.run(app.service!.act({ type: 'sender-pref', email: p.email, name: p.name, pref: p.pref }));
    app.render();
  },
  'sort-pref-no': () => { session.prompt = null; app.render(); },
});
