/* Gemini: per-email next step + drafted reply, thread-end summaries, the daily brief, "ask about my email" chat
   and voice-reply cleanup. Calls go through the team proxy (your key, testers only) unless the user has added
   their own Gemini key. Off until the user opts in (Settings). Every feature has a plain fallback so the app still works without AI. */
import { CONFIG } from './config';
import type { Analysis, FullMessage, MailMessage, ThreadSummary } from './types';
import { firstName, stripQuoted } from './util';
import { DEADLINE_RE, URGENT_RE } from './learn/features';
import { cleanSubject } from './providers/provider';

export interface AiAuth { provider: 'google' | 'microsoft'; token: () => Promise<string> }

type Schema = Record<string, unknown>;

export class AiUnavailable extends Error {}

export class Gemini {
  constructor(private ownKey: () => string, private auth: AiAuth | null, private enabled: () => boolean = () => true) {}

  /** True only when the user opted in to AI features and there is a way to reach Gemini. */
  get available(): boolean { return this.enabled() && Boolean(this.ownKey() || (CONFIG.proxyUrl && this.auth)); }

  private async generate(request: Record<string, unknown>, fast: boolean): Promise<string> {
    if (!this.enabled()) throw new AiUnavailable('AI features are off. Turn them on in Settings.');
    const model = fast ? CONFIG.geminiFastModel : CONFIG.geminiModel;
    const key = this.ownKey();
    let response: Response;
    if (key) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(request),
      });
    } else if (CONFIG.proxyUrl && this.auth) {
      response = await fetch(`${CONFIG.proxyUrl.replace(/\/$/, '')}/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.auth.token()}`, 'X-Auth-Provider': this.auth.provider },
        body: JSON.stringify({ model, request }),
      });
    } else {
      throw new AiUnavailable('AI is not set up (no proxy and no personal Gemini key).');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data.error?.message || data.error || response.statusText;
      if (response.status === 403) throw new AiUnavailable(`AI access denied: ${msg}`);
      if (response.status === 429) throw new AiUnavailable('AI is busy (rate limit). Try again in a minute.');
      throw new Error(`AI request failed (${response.status}): ${msg}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
    if (!text) throw new Error(`AI returned nothing (${data.candidates?.[0]?.finishReason || 'no candidates'}).`);
    return text;
  }

  async json<T>(system: string, prompt: string, schema: Schema, fast = true): Promise<T> {
    const text = await this.generate({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3, maxOutputTokens: 1200 },
    }, fast);
    try { return JSON.parse(text) as T; } catch { throw new Error('AI returned malformed JSON.'); }
  }

  async text(system: string, prompt: string, fast = false): Promise<string> {
    return (await this.generate({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
    }, fast)).trim();
  }
}

const S = {
  str: { type: 'STRING' },
  strs: { type: 'ARRAY', items: { type: 'STRING' } },
};

const today = () => new Date().toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

function systemFor(me: { name: string; email: string }) {
  return `You are the Priority Assistant inside ${firstName(me.name)}'s email (${me.email}). Be brief, concrete and practical; this person is a busy executive who reads on a phone between meetings. Never invent facts that are not in the email. Today is ${today()}.`;
}

function emailBlock(m: MailMessage, body: string) {
  return `From: ${m.from.name} <${m.from.email}>\nTo: ${m.to.map((p) => p.name).join(', ')}${m.cc.length ? `\nCc: ${m.cc.map((p) => p.name).join(', ')}` : ''}\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\n\n${stripQuoted(body).slice(0, 6000)}`;
}

export async function analyzeEmail(ai: Gemini, me: { name: string; email: string }, m: MailMessage, body: string, styleSamples: string[]): Promise<Analysis> {
  const style = styleSamples.length ? `\n\nHow ${firstName(me.name)} usually writes (match this tone and sign-off):\n${styleSamples.slice(0, 3).map((s) => `---\n${s.slice(0, 400)}`).join('\n')}` : '';
  const result = await ai.json<Omit<Analysis, 'at'>>(systemFor(me), `Read this email and decide the single best next step for ${firstName(me.name)}.

Return:
- headline: 3-8 words, action-first, what this email needs (e.g. "Answer Corey on materials by noon").
- bullets: up to 3 short bullet points with the key facts (who, what, when, numbers).
- nextStep: one sentence telling ${firstName(me.name)} exactly what to do.
- action: one of reply, forward, remind, call, none.
- draft: if action is reply, a short ready-to-send reply in ${firstName(me.name)}'s voice (under 90 words, no subject line). Otherwise empty.
- dueIso / dueLabel: if the email asks for something by a date/time, the ISO 8601 local datetime and a short label like "Wed 3:00 PM"; otherwise empty strings.
- phone: a phone number to call if one is given and calling is the fastest path; otherwise empty.${style}

EMAIL:
${emailBlock(m, body)}`, {
    type: 'OBJECT',
    properties: { headline: S.str, bullets: S.strs, nextStep: S.str, action: { type: 'STRING', enum: ['reply', 'forward', 'remind', 'call', 'none'] }, draft: S.str, dueIso: S.str, dueLabel: S.str, phone: S.str },
    required: ['headline', 'bullets', 'nextStep', 'action'],
  }) as Omit<Analysis, 'at'> & { dueIso?: string; dueLabel?: string };
  const dueIso = (result as { dueIso?: string }).dueIso;
  return {
    headline: result.headline || cleanSubject(m.subject),
    bullets: (result.bullets || []).slice(0, 3),
    nextStep: result.nextStep || '',
    action: result.action || 'none',
    draft: result.draft || undefined,
    due: dueIso && !Number.isNaN(Date.parse(dueIso)) ? { iso: dueIso, label: (result as { dueLabel?: string }).dueLabel || '' } : null,
    phone: result.phone || null,
    ai: true,
    at: Date.now(),
  };
}

/** No-AI fallback: still gives a useful headline and next step. */
export function heuristicAnalysis(m: MailMessage, myName: string): Analysis {
  const who = firstName(m.from.name);
  const text = `${m.subject} ${m.snippet}`;
  let nextStep = `Open and review ${who}'s email.`;
  let action: Analysis['action'] = 'none';
  if (/\?/.test(m.snippet)) { nextStep = `${who} asked a question. Reply when you can.`; action = 'reply'; }
  if (DEADLINE_RE.test(text)) { nextStep = `${who} mentions a deadline. Reply or set a reminder.`; action = 'reply'; }
  if (URGENT_RE.test(text)) { nextStep = `${who} says this is urgent. Handle it first.`; action = 'reply'; }
  if (m.hasAttachments && action === 'none') nextStep = `Review the attachment from ${who}.`;
  const phone = /(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})/.exec(m.snippet)?.[1] || null;
  void myName;
  return { headline: cleanSubject(m.subject), bullets: [], nextStep, action, due: null, phone, at: Date.now() };
}

export async function summarizeThread(ai: Gemini, me: { name: string; email: string }, messages: FullMessage[]): Promise<ThreadSummary> {
  const ordered = [...messages].sort((a, b) => a.date - b.date);
  const last = ordered[ordered.length - 1];
  const transcript = ordered.map((m, i) => `#${i + 1} ${new Date(m.date).toLocaleString()} — ${m.from.name}:\n${stripQuoted(m.body.text).slice(0, 1500)}`).join('\n\n').slice(-24000);
  const result = await ai.json<{ whereItEnded: string; bullets: string[]; openItems: string[] }>(systemFor(me), `This is a long email thread (${ordered.length} messages) that ${firstName(me.name)} was copied on. ${firstName(me.name)} does not have time to read it. Explain where it ended up.

Return:
- whereItEnded: one or two sentences: the current status as of the LAST message, and who has the ball.
- bullets: 3-5 bullets of how it got there (key decisions, numbers, dates), oldest to newest.
- openItems: anything still unresolved or waiting on ${firstName(me.name)} (empty if none).

THREAD:
${transcript}`, { type: 'OBJECT', properties: { whereItEnded: S.str, bullets: S.strs, openItems: S.strs }, required: ['whereItEnded', 'bullets', 'openItems'] }, false);
  return { ...result, messageCount: ordered.length, lastFrom: last?.from.name || '', at: Date.now() };
}

export interface DailyBrief { priority: Array<{ id: string; who: string; text: string }>; quickHits: Array<{ who: string; text: string }>; at: number }

export async function dailyBrief(ai: Gemini, me: { name: string; email: string }, priority: MailMessage[], others: MailMessage[]): Promise<DailyBrief> {
  const list = (ms: MailMessage[]) => ms.map((m) => `[${m.id}] ${m.from.name}: ${m.subject} — ${m.snippet}`).join('\n');
  const result = await ai.json<{ priority: DailyBrief['priority']; quickHits: DailyBrief['quickHits'] }>(systemFor(me), `Write ${firstName(me.name)}'s daily email brief.

PRIORITY (ranked by what ${firstName(me.name)} usually acts on first):
${list(priority.slice(0, 8))}

EVERYTHING ELSE (newest first):
${list(others.slice(0, 25))}

Return:
- priority: for each priority email, {id (copy the [id]), who (first name), text (one sentence: what they need and by when)}.
- quickHits: up to 6 items from everything else worth knowing about, {who, text (under 12 words)}. Skip newsletters and notifications unless something notable happened. Never call anything safe to ignore; just state what it is.`, {
    type: 'OBJECT',
    properties: {
      priority: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: S.str, who: S.str, text: S.str }, required: ['id', 'who', 'text'] } },
      quickHits: { type: 'ARRAY', items: { type: 'OBJECT', properties: { who: S.str, text: S.str }, required: ['who', 'text'] } },
    },
    required: ['priority', 'quickHits'],
  });
  return { ...result, at: Date.now() };
}

export async function askAboutEmail(ai: Gemini, me: { name: string; email: string }, question: string, context: MailMessage[], history: Array<{ role: 'me' | 'ai'; text: string }>): Promise<string> {
  const mail = context.slice(0, 40).map((m) => `- ${new Date(m.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} | ${m.from.name} | ${m.subject} | ${m.snippet}`).join('\n');
  const convo = history.slice(-6).map((h) => `${h.role === 'me' ? 'Q' : 'A'}: ${h.text}`).join('\n');
  return ai.text(systemFor(me), `Answer the question using only these recent emails. If the answer is not in them, say so. Keep it to 1-3 sentences, and name the sender so they can find it.

RECENT EMAIL:
${mail}

${convo ? `EARLIER IN THIS CHAT:\n${convo}\n\n` : ''}QUESTION: ${question}`, true);
}

export async function polishVoiceReply(ai: Gemini, me: { name: string; email: string }, m: MailMessage, transcript: string, styleSamples: string[]): Promise<string> {
  const style = styleSamples.length ? `\nMatch this sign-off and tone:\n${styleSamples[0].slice(0, 300)}` : `\nSign it "${firstName(me.name)}".`;
  return ai.text(systemFor(me), `${firstName(me.name)} dictated a reply by voice while driving. Turn it into a clean, short email reply. Fix speech-to-text mistakes, remove filler words, keep every fact and commitment exactly, add nothing new. Output only the reply body.${style}

REPLYING TO: ${m.from.name} — ${m.subject}
${m.snippet}

DICTATION: ${transcript}`, true);
}

export function fallbackVoiceReply(transcript: string, myName: string): string {
  const t = transcript.trim().replace(/\s+/g, ' ');
  const sentence = t ? t[0].toUpperCase() + t.slice(1) : '';
  return `${sentence.replace(/[.!?]*$/, '.')}\n\nThanks,\n${firstName(myName)}`;
}
