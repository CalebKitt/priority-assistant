/* What the in-page UI needs from the assistant. The extension implements it with messages to the background
   service worker; the dev harness implements it in-page against the demo mailbox. */
import type { Action, View } from '../../core/service';
import type { Analysis, FullMessage, Person, ThreadSummary } from '../../core/types';
import type { SendCheck } from '../../core/sensitive';

export interface ViewResult { view: View | null; reason?: 'no-account' | 'starting' | 'error'; message?: string; accounts?: number }

export interface Backend {
  view(): Promise<ViewResult>;
  act(action: Action): Promise<string>;
  analyze(id: string, force?: boolean): Promise<Analysis>;
  thread(threadId: string, force?: boolean): Promise<ThreadSummary>;
  conversation(threadId: string): Promise<FullMessage[]>;
  draft(id: string): Promise<string>;
  sendCheck(kind: 'reply' | 'forward', id: string, text: string, to: Person[]): Promise<SendCheck>;
  webPath(id: string): Promise<string | null>;
  openSettings(): void;
  connect(): void;
  startDemo(): void;
  onChange(cb: () => void): void;
}
