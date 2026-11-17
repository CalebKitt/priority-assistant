/* Runs inside Gmail and Outlook on the web: mounts the Priority Assistant UI and relays to the background worker. */
import { detectSite, type Site } from './sites';
import { PaApp } from './ui/app';
import type { Backend, ViewResult } from './ui/backend';
import { send } from './messages';

class ExtensionBackend implements Backend {
  private email = '';
  private listeners = new Set<() => void>();
  constructor(private site: Site) {
    chrome.runtime.onMessage.addListener((msg: { type: string }) => {
      if (msg.type === 'changed') this.listeners.forEach((fn) => fn());
      if (msg.type === 'toggle-panel') document.getElementById('priority-assistant-root')?.dispatchEvent(new CustomEvent('pa-toggle'));
    });
  }
  async view(): Promise<ViewResult> {
    const result = await send<ViewResult>({ type: 'view', site: this.site.name, hint: this.site.accountHint() });
    this.email = result.view?.account.email || '';
    return result;
  }
  act(action: Parameters<Backend['act']>[0]) { return send<string>({ type: 'act', email: this.email, action }); }
  analyze(id: string, force?: boolean) { return send<Awaited<ReturnType<Backend['analyze']>>>({ type: 'analyze', email: this.email, id, force }); }
  thread(threadId: string, force?: boolean) { return send<Awaited<ReturnType<Backend['thread']>>>({ type: 'thread', email: this.email, threadId, force }); }
  conversation(threadId: string) { return send<Awaited<ReturnType<Backend['conversation']>>>({ type: 'conversation', email: this.email, threadId }); }
  draft(id: string) { return send<string>({ type: 'draft', email: this.email, id }); }
  sendCheck(kind: 'reply' | 'forward', id: string, text: string, to: Parameters<Backend['sendCheck']>[3]) { return send<Awaited<ReturnType<Backend['sendCheck']>>>({ type: 'send-check', email: this.email, kind, id, text, to }); }
  webPath(id: string) { return send<string | null>({ type: 'web-path', email: this.email, id }); }
  openSettings() { void send({ type: 'open-options' }); }
  connect() {
    void send({ type: 'connect', provider: this.site.name === 'outlook' ? 'microsoft' : 'google' })
      .then(() => this.listeners.forEach((fn) => fn()))
      .catch((error) => alert(`Priority Assistant: ${(error as Error).message}`));
  }
  startDemo() { void send({ type: 'demo', on: true }).then(() => this.listeners.forEach((fn) => fn())); }
  onChange(cb: () => void) { this.listeners.add(cb); }
}

function mount() {
  const site = detectSite();
  if (!site || document.getElementById('priority-assistant-root')) return;
  const host = document.createElement('div');
  host.id = 'priority-assistant-root';
  document.documentElement.append(host);
  const app = new PaApp(site, new ExtensionBackend(site), host);
  host.addEventListener('pa-toggle', () => app.togglePanel());
  void app.start();
}

// Gmail/Outlook build their page after load; wait until the app shell exists.
const ready = () => document.querySelector('div[role="main"], #MainModule, [role="navigation"]');
if (ready()) mount();
else {
  const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); mount(); } });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => { observer.disconnect(); mount(); }, 15000);
}
