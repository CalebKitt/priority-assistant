/* Speech in the browser: read aloud (speechSynthesis) and listen (SpeechRecognition). Free, on-device where the
   phone supports it: Chrome on Android, Safari on iPhone. */

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};

const RecognitionClass = (): (new () => Recognition) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
};

export const canListen = () => Boolean(RecognitionClass());
export const canSpeak = () => 'speechSynthesis' in window;

let voice: SpeechSynthesisVoice | null = null;
function pickVoice() {
  if (!canSpeak()) return;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  voice = voices.find((v) => /natural|neural|premium|enhanced|google us/i.test(v.name)) || voices.find((v) => v.default) || voices[0] || null;
}
if (canSpeak()) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

let speakToken = 0;

/** Read text aloud; resolves when finished or cancelled. Long text is split so mobile Chrome does not stall. */
export function speak(text: string, rate = 1.02): Promise<void> {
  if (!canSpeak() || !text.trim()) return Promise.resolve();
  const token = ++speakToken;
  speechSynthesis.cancel();
  const chunks = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*\s*/g) || [text];
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (token !== speakToken || i >= chunks.length) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      if (voice) u.voice = voice;
      u.rate = rate;
      u.onend = next;
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    };
    next();
  });
}

export function stopSpeaking() { speakToken++; if (canSpeak()) speechSynthesis.cancel(); }

export interface Listening { result: Promise<string>; stop(): void; abort(): void }

/** Listen for one phrase. Resolves with the final transcript ('' if nothing was heard). */
export function listen(onInterim?: (text: string) => void, { long = false, timeoutMs = 9000 } = {}): Listening {
  const Ctor = RecognitionClass();
  if (!Ctor) return { result: Promise.reject(new Error('This browser cannot listen. Use Chrome on Android or Safari on iPhone.')), stop() {}, abort() {} };
  const rec = new Ctor();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = long;
  rec.maxAlternatives = 1;
  let heard = '';
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveFn: (t: string) => void = () => undefined;
  let rejectFn: (e: Error) => void = () => undefined;
  const result = new Promise<string>((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  const finish = () => { if (done) return; done = true; if (timer) clearTimeout(timer); resolveFn(heard.trim()); };
  const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { try { rec.stop(); } catch { finish(); } }, long ? Math.max(timeoutMs, 4000) : timeoutMs); };
  rec.onresult = (event) => {
    heard = Array.from(event.results as ArrayLike<ArrayLike<{ transcript: string }>>).map((r) => r[0].transcript).join(' ');
    onInterim?.(heard);
    arm();
  };
  rec.onerror = (event) => {
    if (done) return;
    if (event.error === 'no-speech' || event.error === 'aborted') { finish(); return; }
    done = true;
    if (timer) clearTimeout(timer);
    rejectFn(new Error(event.error === 'not-allowed' ? 'Microphone permission was denied. Allow the mic for this site in your browser settings.' : `Speech recognition failed (${event.error}).`));
  };
  rec.onend = finish;
  try { rec.start(); arm(); } catch (error) { done = true; rejectFn(error as Error); }
  return { result, stop: () => { try { rec.stop(); } catch { finish(); } }, abort: () => { done = true; if (timer) clearTimeout(timer); try { rec.abort(); } catch { /* already stopped */ } resolveFn(''); } };
}

/** Animated waveform bars (transform only). Returns a stop function. */
export function animateWave(root: HTMLElement): () => void {
  const bars = Array.from(root.querySelectorAll<HTMLElement>('i'));
  root.classList.add('live');
  const timer = setInterval(() => bars.forEach((bar, i) => {
    const h = 8 + Math.abs(Math.sin(Date.now() / 160 + i)) * 40 * (0.4 + Math.random() * 0.6);
    bar.style.transform = `scaleY(${Math.min(1, h / 48).toFixed(3)})`;
  }), 90);
  return () => { clearInterval(timer); root.classList.remove('live'); bars.forEach((b) => { b.style.transform = ''; }); };
}

export const waveHtml = (bars = 28) => `<div class="waveform" aria-hidden="true">${'<i></i>'.repeat(bars)}</div>`;
