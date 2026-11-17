/* Builds a working AssistantService from a saved account (tokens + kind). Shared by the extension's background
   worker and the phone app. */
import type { ProviderKind } from './types';
import type { KV } from './state';
import { TokenManager, type TokenSet } from './auth';
import { Gemini, type AiAuth } from './ai';
import { GmailProvider } from './providers/gmail';
import { OutlookProvider } from './providers/outlook';
import { DemoProvider, DEMO_ACCOUNT } from './providers/demo';
import type { MailProvider } from './providers/provider';
import { AssistantService } from './service';

export interface StoredAccount { kind: ProviderKind; email: string; name: string; tokens?: TokenSet }

export interface OpenOptions {
  kv: KV;
  saveTokens: (email: string, tokens: TokenSet) => Promise<void>;
  /** AI sign-in to use when this account has none of its own (the demo mailbox borrows a real account's). */
  fallbackAiAuth?: () => AiAuth | null;
}

export function demoAccount(): StoredAccount { return { kind: 'demo', email: DEMO_ACCOUNT.email, name: DEMO_ACCOUNT.name }; }

export function aiAuthFor(tm: TokenManager): AiAuth {
  return { provider: tm.current.provider, token: () => tm.accessToken() };
}

export async function openService(account: StoredAccount, opts: OpenOptions): Promise<{ service: AssistantService; tm: TokenManager | null }> {
  let provider: MailProvider;
  let tm: TokenManager | null = null;
  if (account.kind === 'demo') provider = new DemoProvider(opts.kv);
  else {
    if (!account.tokens) throw new Error(`${account.email} needs to sign in again.`);
    tm = new TokenManager(account.tokens, (tokens) => opts.saveTokens(account.email, tokens));
    provider = account.kind === 'gmail' ? new GmailProvider(tm) : new OutlookProvider(tm);
  }
  const holder: { service?: AssistantService } = {};
  const auth = tm ? aiAuthFor(tm) : opts.fallbackAiAuth?.() || null;
  const settings = () => holder.service?.state.synced.settings;
  const ai = new Gemini(() => settings()?.ownGeminiKey || '', auth, () => Boolean(settings()?.aiEnabled));
  holder.service = await AssistantService.open(provider, opts.kv, ai);
  return { service: holder.service, tm };
}

export const providerForAuth = (kind: ProviderKind): 'google' | 'microsoft' => (kind === 'gmail' ? 'google' : 'microsoft');
