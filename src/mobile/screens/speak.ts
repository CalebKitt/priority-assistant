/* Hands-free mode (for the drive home): reads your priority email aloud and takes spoken commands.
   "Reply ...", "next", "back", "repeat", "read it all", "remind me tomorrow", "priority", "later", "trash",
   "done", "forward to Thomas", "call", "stop". Replies are read back and only sent when you say "send". */
import type { RowVM } from '../../core/service';
import type { Person } from '../../core/types';
import { dueLabel, esc, firstName, stripQuoted } from '../../core/util';
import { app, header, screens } from '../shell';
import { animateWave, canListen, canSpeak, listen, speak, stopSpeaking, waveHtml, type Listening } from '../voice';

const s = {
  running: false,
  token: 0,
  queue: [] as RowVM[],
  index: 0,
  status: 'Ready',
  heard: '',
  draft: '',
  pushToTalk: false,
  listening: null as Listening | null,
  stopWave: null as null | (() => void),
};

const DAY = 86400000;

function buildQueue(): RowVM[] {
  const v = app.view!;
  const pri = v.priority.filter((r) => !r.handled);
  const rest = v.others.filter((r) => !r.handled && !r.bulk && r.unread);
  return [...pri, ...rest].slice(0, 15);
}

const current = () => s.queue[s.index] || null;

function paint() {
  const root = document.querySelector('#speak-root');
  if (!root) return;
  const r = current();
  (root.querySelector('#sp-state') as HTMLElement).textContent = s.status;
  const count = document.querySelector('#sp-count');
  if (count) count.textContent = s.queue.length ? `${Math.min(s.index + 1, s.queue.length)} of ${s.queue.length}` : '';
  (root.querySelector('#sp-title') as HTMLElement).textContent = r ? `${firstName(r.from)}: ${r.analysis?.headline || r.subject}` : 'Hands-free inbox';
  (root.querySelector('#sp-text') as HTMLElement).textContent = r ? (r.analysis?.nextStep || r.snippet) : 'I read your priority email out loud and you answer by voice. Nothing is sent until you say "send".';
  (root.querySelector('#sp-heard') as HTMLElement).textContent = s.heard ? `“${s.heard}”` : '';
  const draft = root.querySelector('#sp-draft') as HTMLElement;
  draft.hidden = !s.draft; draft.textContent = s.draft;
  const main = root.querySelector('#sp-main') as HTMLElement;
  main.textContent = s.running ? '❚❚' : '▶';
  main.classList.toggle('on', Boolean(s.listening));
  (root.querySelector('#sp-ptt') as HTMLElement).hidden = !(s.running && s.pushToTalk);
}

function setStatus(status: string) { s.status = status; paint(); }

async function say(text: string, token: number) {
  if (token !== s.token) return;
  const wave = document.querySelector('#sp-wave') as HTMLElement | null;
  const stop = wave ? animateWave(wave) : null;
  await speak(text);
  stop?.();
}

/** Listen once. In push-to-talk mode (some phones block auto-listening) wait for the mic tap instead. */
async function hear(token: number, long = false): Promise<string> {
  if (token !== s.token) return '';
  if (s.pushToTalk) {
    setStatus('Tap the mic to answer');
    await new Promise<void>((resolve) => { (s as unknown as { ptt: () => void }).ptt = resolve; });
    if (token !== s.token) return '';
  }
  s.heard = '';
  setStatus('Listening…');
  s.listening = listen((t) => { s.heard = t; paint(); }, { long, timeoutMs: long ? 2500 : 7000 });
  paint();
  try {
    return (await s.listening.result).toLowerCase().trim();
  } catch (error) {
    if (/permission|not-allowed/i.test((error as Error).message)) throw error;
    s.pushToTalk = true;
    return '';
  } finally { s.listening = null; paint(); }
}

function whenFrom(text: string): number {
  const now = new Date();
  const at = (days: number, h: number) => { const d = new Date(now.getTime() + days * DAY); d.setHours(h, 0, 0, 0); return d.getTime(); };
  if (/hour/.test(text)) return now.getTime() + 3600000;
  if (/tonight|this evening/.test(text)) return at(0, 19);
  if (/afternoon|later today|later/.test(text)) return now.getHours() < 14 ? at(0, 15) : at(1, 15);
  if (/monday/.test(text)) { const d = (8 - now.getDay()) % 7 || 7; return at(d, 7); }
  return at(1, 7);
}

function findPerson(name: string, r: RowVM): Person | null {
  const v = app.view!;
  const q = name.replace(/^(to|it to)\s+/, '').trim();
  if (!q && r.suggestion?.to) return r.suggestion.to;
  return v.coworkers.find((p) => p.name.toLowerCase().includes(q) || firstName(p.name).toLowerCase() === q.split(' ')[0] || p.email.startsWith(q.replace(/\s+/g, '')))
    || (r.suggestion?.to && r.suggestion.to.name.toLowerCase().includes(q) ? r.suggestion.to : null);
}

const YES = /^(yes|yeah|yep|send|send it|do it|sure|ok|okay|confirm|send anyway)\b/;

async function confirmAndSend(token: number, kind: 'reply' | 'forward', r: RowVM, text: string, to: Person[], send: () => Promise<string>): Promise<boolean> {
  const check = app.service!.sendCheck(kind, r.id, text, to);
  if (check.needsConfirm) {
    await say(`Heads up. ${check.reasons.join('. ')}. Say send anyway to confirm, or cancel.`, token);
    const answer = await hear(token);
    if (!/send anyway|^yes|confirm/.test(answer)) { await say('Okay, not sent.', token); return false; }
  }
  setStatus('Sending…');
  try { await send(); return true; } catch (error) { await say(`That didn't send. ${(error as Error).message}`, token); return false; }
}

async function replyFlow(token: number, r: RowVM, initial: string) {
  let dictation = initial.trim();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!dictation) { await say('Go ahead.', token); dictation = await hear(token, true); }
    if (token !== s.token) return;
    if (!dictation) { await say("I didn't hear a reply.", token); return; }
    setStatus('Writing it up…');
    s.draft = await app.service!.voiceReply(r.id, dictation);
    paint();
    await say(`Here's your reply to ${firstName(r.from)}. ${s.draft.replace(/\n+/g, '. ')}. Say send, change it, or cancel.`, token);
    const answer = await hear(token);
    if (YES.test(answer)) {
      const ok = await confirmAndSend(token, 'reply', r, s.draft, [{ name: r.from, email: r.fromEmail }], () => app.service!.act({ type: 'reply', id: r.id, text: s.draft }));
      s.draft = '';
      if (ok) await say('Sent.', token);
      return;
    }
    if (/change|redo|again|start over|no wait/.test(answer)) { dictation = ''; s.draft = ''; continue; }
    s.draft = ''; paint();
    await say('Okay, I dropped that reply.', token);
    return;
  }
}

async function handle(token: number, cmd: string, r: RowVM): Promise<'next' | 'prev' | 'stay' | 'stop'> {
  const svc = app.service!;
  if (/^(stop|pause|quit|exit|that's all|that is all|i'm done|im done)\b/.test(cmd)) return 'stop';
  if (/^(next|skip|move on|pass|go on)\b/.test(cmd)) return 'next';
  if (/^(back|previous|go back|last one)\b/.test(cmd)) return 'prev';
  if (/(repeat|again|say that again|what was that)/.test(cmd)) return 'stay';
  if (/^(read|full|details|more)\b|read (it|the whole|all)/.test(cmd)) {
    setStatus('Reading the full email…');
    const body = await svc.provider.body(svc.message(r.id)!);
    await say(stripQuoted(body.text).slice(0, 1800) || r.snippet, token);
    return 'stay';
  }
  const reply = /^(reply|respond|answer|tell (him|her|them))\b[,:]?\s*(.*)$/.exec(cmd);
  if (reply) { await replyFlow(token, r, reply[1].startsWith('tell') ? cmd : reply[3]); return 'next'; }
  if (/remind/.test(cmd)) {
    const due = whenFrom(cmd);
    await svc.act({ type: 'remind', id: r.id, due });
    await say(`Okay, I'll remind you ${dueLabel(due).toLowerCase()}.`, token);
    return 'next';
  }
  const fwd = /^forward\b(?:\s+(?:it|this))?(?:\s+to)?\s*(.*)$/.exec(cmd);
  if (fwd) {
    const person = findPerson(fwd[1], r);
    if (!person) { await say(`I don't know who ${fwd[1] || 'that'} is. Try a first name, like ${firstName(app.view!.coworkers[0]?.name || 'Thomas')}.`, token); return 'stay'; }
    await say(`Forward to ${person.name}? Say yes or no.`, token);
    if (!YES.test(await hear(token))) { await say('Okay, not forwarded.', token); return 'stay'; }
    const note = `${firstName(person.name)}, can you take care of this? Thanks, ${firstName(app.view!.account.name)}`;
    if (await confirmAndSend(token, 'forward', r, note, [person], () => svc.act({ type: 'forward', id: r.id, to: [person], note }))) await say(`Forwarded to ${firstName(person.name)}.`, token);
    return 'next';
  }
  if (/(not (important|priority)|can wait|^later\b|low priority)/.test(cmd)) { await svc.act({ type: 'later', id: r.id }); await say('Got it, it can wait.', token); return 'next'; }
  if (/(priority|important|keep (it|this))/.test(cmd)) { await svc.act({ type: 'make-priority', id: r.id }); await say('Marked as priority.', token); return 'next'; }
  if (/(trash|delete|junk|throw (it )?away|get rid)/.test(cmd)) { await svc.act({ type: 'trash', id: r.id }); await say('Deleted.', token); return 'next'; }
  if (/(archive|done|mark (it )?(as )?done|handled)/.test(cmd)) { await svc.act({ type: 'done', id: r.id }); await say('Marked done.', token); return 'next'; }
  if (/^call\b/.test(cmd)) {
    const phone = r.analysis?.phone;
    if (!phone) { await say(`I don't see a phone number in ${firstName(r.from)}'s email.`, token); return 'stay'; }
    await say(`Calling ${firstName(r.from)}.`, token);
    location.href = `tel:${phone.replace(/[^\d+]/g, '')}`;
    return 'stop';
  }
  await say(cmd ? `Sorry, I heard ${cmd}. Say reply, next, remind me, or stop.` : 'Say reply, next, remind me, or stop.', token);
  return 'stay';
}

async function loop(token: number) {
  let silent = 0;
  let intro = true;
  while (token === s.token && s.index < s.queue.length) {
    const r = current()!;
    setStatus('Reading');
    let a = r.analysis;
    if (!a) { try { a = await app.service!.analyze(r.id); } catch { /* read the snippet instead */ } }
    const lead = intro ? `You have ${s.queue.length} email${s.queue.length === 1 ? '' : 's'} to go through. ` : '';
    intro = false;
    await say(`${lead}${s.index === 0 ? 'First' : 'Next'}, from ${r.from}. ${a?.headline || r.subject}. ${a?.nextStep || r.snippet}`, token);
    let outcome: 'next' | 'prev' | 'stay' | 'stop' = 'stay';
    while (outcome === 'stay' && token === s.token) {
      const cmd = await hear(token);
      if (token !== s.token) return;
      if (!cmd) {
        silent += 1;
        if (silent >= 2) { await say("I'll pause here. Tap play when you're ready.", token); outcome = 'stop'; break; }
        if (!s.pushToTalk) await say('Say reply, next, remind me, or stop.', token);
        continue;
      }
      silent = 0;
      outcome = await handle(token, cmd, r);
      if (outcome === 'stay' && /(repeat|again|what was that)/.test(cmd)) break;
    }
    if (token !== s.token) return;
    if (outcome === 'stop') { stopRun('Paused'); return; }
    if (outcome === 'prev') s.index = Math.max(0, s.index - 1);
    else if (outcome === 'next') s.index += 1;
    s.heard = '';
    paint();
  }
  if (token === s.token && s.index >= s.queue.length) {
    await say("That's everything. Nice work.", token);
    stopRun('All caught up');
  }
}

function stopRun(status = 'Paused') {
  s.token += 1;
  s.running = false;
  stopSpeaking();
  s.listening?.abort(); s.listening = null;
  (s as unknown as { ptt?: () => void }).ptt?.();
  setStatus(status);
}

function start() {
  if (!canSpeak()) { app.toast('This browser cannot read aloud.', 'error'); return; }
  if (!canListen()) s.pushToTalk = false;
  if (!s.queue.length || s.index >= s.queue.length) { s.queue = buildQueue(); s.index = 0; }
  if (!s.queue.length) { void speak('Nothing needs you right now.'); app.toast('Nothing needs you right now.'); return; }
  s.running = true;
  const token = ++s.token;
  loop(token).catch((error) => { stopRun('Paused'); app.toast((error as Error).message, 'error'); });
}

screens.speak = {
  tab: 'speak',
  dark: true,
  render() {
    if (!s.running) s.queue = buildQueue();
    const unsupported = !canListen() ? '<p class="speak-help">This browser can read aloud but cannot listen. Use the buttons below, or open this page in Chrome on Android or Safari on iPhone.</p>' : '';
    return `${header('Hands-free', { eyebrow: 'VOICE INBOX', right: '<span class="pill" id="sp-count" style="margin-right:12px;background:rgba(255,255,255,.12);color:#fff"></span>' })}
      <div class="speak-body" id="speak-root">
        <div class="speak-state" id="sp-state"></div>
        <h1 class="speak-title" id="sp-title"></h1>
        <p class="speak-text" id="sp-text"></p>
        <div id="sp-wave">${waveHtml(28)}</div>
        <button class="mic-btn" id="sp-main" data-act="sp-toggle" aria-label="Start or pause hands-free"></button>
        <button class="btn btn-outline-light" id="sp-ptt" data-act="sp-ptt" hidden>🎙 Tap to talk</button>
        <div class="speak-heard" id="sp-heard"></div>
        <div class="draft-preview" id="sp-draft" hidden></div>
        <p class="speak-help">Say <b>reply</b> and your answer, <b>next</b>, <b>repeat</b>, <b>read it all</b>, <b>remind me tomorrow</b>, <b>forward to</b> a name, <b>priority</b>, <b>later</b>, <b>trash</b>, or <b>stop</b>.</p>
        ${unsupported}
        <button class="btn btn-outline-light btn-small" data-act="sp-brief">🔊 Read my daily brief</button>
      </div>
      <div class="speak-controls"><button class="btn btn-outline-light" data-act="sp-step" data-by="-1">◀ Back</button><button class="btn btn-outline-light" data-act="sp-reply">🎙 Reply</button><button class="btn btn-outline-light" data-act="sp-step" data-by="1">Next ▶</button></div>`;
  },
  mount() { paint(); },
  unmount() { stopRun('Ready'); },
  onChange() { if (!s.running) return true; return false; },
};

app.on({
  'sp-toggle': () => { if (s.running) stopRun('Paused'); else start(); },
  'sp-ptt': () => (s as unknown as { ptt?: () => void }).ptt?.(),
  'sp-step': (el) => {
    const wasRunning = s.running;
    stopRun('Ready');
    if (!s.queue.length) s.queue = buildQueue();
    s.index = Math.max(0, Math.min(s.queue.length - 1, s.index + Number(el.dataset.by)));
    paint();
    if (wasRunning) start();
  },
  'sp-reply': () => {
    const r = current() || buildQueue()[0];
    if (!r) return;
    stopRun('Ready');
    s.running = true;
    const token = ++s.token;
    replyFlow(token, r, '').then(() => stopRun('Ready')).catch((error) => { stopRun('Paused'); app.toast((error as Error).message, 'error'); });
  },
  'sp-brief': async () => {
    stopRun('Reading your brief');
    const token = ++s.token;
    try {
      const v = app.view!;
      const brief = await app.service!.dailyBrief();
      const due = v.calendar.filter((c) => !c.done && c.at < Date.now() + DAY);
      const text = [
        `Here's your brief. ${brief.priority.length ? `${brief.priority.length} priority email${brief.priority.length === 1 ? '' : 's'}.` : 'Nothing urgent.'}`,
        ...brief.priority.map((p, i) => `${i === 0 ? 'First' : 'Next'}, ${p.who}. ${p.text}`),
        due.length ? `Due today: ${due.map((d) => d.title).join('. ')}.` : '',
        brief.quickHits.length ? `Also: ${brief.quickHits.map((q) => `${q.who}, ${q.text}`).join('. ')}.` : '',
      ].join(' ');
      setStatus('Reading your brief');
      await say(text, token);
      if (token === s.token) setStatus('Ready');
    } catch (error) { app.toast((error as Error).message, 'error'); setStatus('Ready'); }
  },
});

export const speakDebug = { state: s, esc };
