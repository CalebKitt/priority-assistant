/* In-page Backend over an AssistantService (no extension messaging). Used by the dev harness and the phone app. */
import type { AssistantService, Action } from './service';
import type { Person } from './types';

export class LocalBackend {
  private listeners = new Set<() => void>();
  constructor(public service: AssistantService | null, private hooks: { settings?: () => void; connect?: () => void; demo?: () => void } = {}) {
    service?.onChange(() => this.listeners.forEach((fn) => fn()));
  }
  attach(service: AssistantService) { this.service = service; service.onChange(() => this.listeners.forEach((fn) => fn())); this.listeners.forEach((fn) => fn()); }
  private get svc() { if (!this.service) throw new Error('No account connected.'); return this.service; }
  async view() {
    if (!this.service) return { view: null, reason: 'no-account' as const };
    if (!this.service.state.lastSync && !this.service.isSyncing) void this.service.sync().catch((error) => console.warn(error));
    return { view: this.service.view() };
  }
  act(action: Action) { return this.svc.act(action); }
  analyze(id: string, force?: boolean) { return this.svc.analyze(id, force); }
  thread(threadId: string, force?: boolean) { return this.svc.threadSummary(threadId, force); }
  conversation(threadId: string) { return this.svc.conversation(threadId); }
  draft(id: string) { return this.svc.draftFor(id); }
  async sendCheck(kind: 'reply' | 'forward', id: string, text: string, to: Person[]) { return this.svc.sendCheck(kind, id, text, to); }
  webPath(id: string) { return this.svc.webPath(id); }
  openSettings() { this.hooks.settings?.(); }
  connect() { this.hooks.connect?.(); }
  startDemo() { this.hooks.demo?.(); }
  onChange(cb: () => void) { this.listeners.add(cb); }
}
