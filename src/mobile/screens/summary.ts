/* Daily summary: priority in depth, quick hits, what's due this week, and "ask about today's email". */
import type { DailyBrief } from '../../core/ai';
import { esc, firstName, startOfDay } from '../../core/util';
import { accountButton, app, header, openRemind, screens } from '../shell';

const s = { brief: null as DailyBrief | null, loading: false, error: '', chat: [] as Array<{ role: 'me' | 'ai'; text: string }>, draft: '', thinking: false };
const DAY = 86400000;

async function loadBrief(force = false) {
  if (s.loading) return;
  s.loading = true; s.error = '';
  try { s.brief = await app.service!.dailyBrief(force); } catch (error) { s.error = (error as Error).message; }
  s.loading = false;
  if (app.route.name === 'summary') app.render();
}

function calendarHtml(): string {
  const items = app.view!.calendar.filter((c) => !c.done && c.at < Date.now() + 7 * DAY);
  if (!items.length) return '<p class="muted small">No deadlines yet. Use Remind on any email, and I add due dates I find in your email.</p>';
  return items.map((c) => {
    const days = Math.round((startOfDay(c.at) - startOfDay(Date.now())) / DAY);
    const when = c.kind === 'nudge' ? 'Follow up' : c.overdue ? 'Overdue' : `${days === 0 ? 'Today' : days === 1 ? 'Tmrw' : new Date(c.at).toLocaleDateString([], { weekday: 'short' })} ${new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    return `<div class="cal-item ${c.overdue ? 'overdue' : ''} ${c.kind === 'nudge' ? 'nudge' : ''}"><span class="cal-time">${esc(when)}</span>
      <button class="cal-text" data-act="open" data-id="${esc(c.msgId)}"><b>${esc(c.title)}</b><span>${esc(c.sub)}</span></button>
      ${c.kind === 'nudge' ? `<button class="icon-btn" data-act="sum-remind" data-id="${esc(c.msgId)}" aria-label="Remind me">⏰</button>` : `<button class="icon-btn" data-act="sum-done" data-task="${esc(c.id)}" aria-label="Done">✓</button>`}</div>`;
  }).join('');
}

function chips(): string[] {
  const v = app.view!;
  const top = v.priority[0];
  return [top ? `What does ${firstName(top.from)} need?` : 'What needs me today?', "What's due before Friday?", 'Any invoices or bids?', 'What happened in my CC threads?'];
}

screens.summary = {
  tab: 'summary',
  render() {
    if (!s.brief && !s.loading && !s.error) void loadBrief();
    const b = s.brief;
    const day = new Date().toLocaleDateString([], { weekday: 'long' }).toUpperCase();
    const body = s.loading && !b ? '<div class="empty"><span class="spinner"></span> Writing your brief…</div>'
      : s.error ? `<div class="notice error">${esc(s.error)}</div>`
      : b ? `<div class="field-label" style="color:#d93025">Priority · in depth</div>
          ${b.priority.map((p) => `<button class="summary-item" data-act="open" data-id="${esc(p.id)}"><b>${esc(p.who)}</b><span>${esc(p.text)}</span></button>`).join('') || '<p class="muted">Nothing urgent. 🎉</p>'}
          <div class="field-label">Everything else · quick hits</div>
          ${b.quickHits.map((q) => `<div class="quick-hit"><b>${esc(q.who)}</b>${esc(q.text)}</div>`).join('') || '<p class="muted small">Nothing notable.</p>'}` : '';
    return `${header('Daily summary', { eyebrow: day, right: `<button class="icon-btn" data-act="sum-refresh" aria-label="Refresh">↻</button>${accountButton()}` })}
      <div class="scroll pad" id="sum-scroll">${body}
        <div class="field-label">Due this week</div>${calendarHtml()}
        <div class="field-label">Ask about your email</div>
        <div class="chips">${chips().map((c) => `<button class="chip" data-act="sum-ask" data-q="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <div class="chat" id="chat">${s.chat.map((m) => `<div class="bubble ${m.role}">${esc(m.text)}</div>`).join('')}${s.thinking ? '<div class="bubble ai"><span class="spinner"></span></div>' : ''}</div>
      </div>
      <form class="chat-form" id="chat-form" autocomplete="off"><input id="chat-input" type="text" placeholder="Ask about your email…" value="${esc(s.draft)}"><button class="send-btn" aria-label="Send">➤</button></form>`;
  },
  mount(root) {
    const form = root.querySelector('#chat-form') as HTMLFormElement;
    const input = root.querySelector('#chat-input') as HTMLInputElement;
    input.addEventListener('input', () => { s.draft = input.value; });
    form.addEventListener('submit', (e) => { e.preventDefault(); void ask(input.value); });
    if (s.chat.length) { const sc = root.querySelector('#sum-scroll') as HTMLElement; sc.scrollTop = sc.scrollHeight; }
  },
  onChange() { return !document.activeElement || document.activeElement.id !== 'chat-input'; },
};

async function ask(question: string) {
  const q = question.trim();
  if (!q || s.thinking) return;
  s.chat.push({ role: 'me', text: q });
  s.draft = ''; s.thinking = true;
  app.render();
  try { s.chat.push({ role: 'ai', text: await app.service!.ask(q, s.chat.slice(0, -1)) }); }
  catch (error) { s.chat.push({ role: 'ai', text: `Sorry, I couldn't answer that: ${(error as Error).message}` }); }
  s.thinking = false;
  app.render();
}

app.on({
  'sum-ask': (el) => ask(el.dataset.q!),
  'sum-refresh': () => loadBrief(true),
  'sum-remind': (el) => openRemind(el.dataset.id!),
  'sum-done': (el) => app.run(app.service!.act({ type: 'task-done', taskId: el.dataset.task!, done: true })),
});
