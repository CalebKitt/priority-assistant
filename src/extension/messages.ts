/* Messages between the page (content script / options page) and the background service worker. */
import type { Action } from '../core/service';
import type { Person } from '../core/types';

export type Request =
  | { type: 'view'; site: 'gmail' | 'outlook' | 'harness'; hint: string }
  | { type: 'act'; email: string; action: Action }
  | { type: 'analyze'; email: string; id: string; force?: boolean }
  | { type: 'thread'; email: string; threadId: string; force?: boolean }
  | { type: 'conversation'; email: string; threadId: string }
  | { type: 'draft'; email: string; id: string }
  | { type: 'send-check'; email: string; kind: 'reply' | 'forward'; id: string; text: string; to: Person[] }
  | { type: 'web-path'; email: string; id: string }
  | { type: 'connect'; provider: 'google' | 'microsoft' }
  | { type: 'disconnect'; email: string }
  | { type: 'demo'; on: boolean }
  | { type: 'accounts' }
  | { type: 'open-options' };

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; needsSignIn?: boolean };

export async function send<T>(request: Request): Promise<T> {
  let response: Response<T> | undefined;
  try {
    response = await chrome.runtime.sendMessage(request);
  } catch (error) {
    const msg = String((error as Error).message || error);
    if (/context invalidated|Receiving end does not exist/i.test(msg)) throw new Error('Priority Assistant was updated. Reload this page to reconnect.');
    throw error;
  }
  if (!response) throw new Error('No answer from the extension. Reload this page.');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
