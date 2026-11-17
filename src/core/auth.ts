/* OAuth for Google and Microsoft. The browser side builds the consent URL (PKCE); the proxy Worker holds the
   client secrets and swaps the code for tokens, so we get refresh tokens and nobody re-signs in every hour. */
import { CONFIG, GOOGLE_SCOPES, MICROSOFT_SCOPES } from './config';

export type AuthProvider = 'google' | 'microsoft';

export interface TokenSet {
  provider: AuthProvider;
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  email: string;
  name: string;
}

export class AuthError extends Error {
  constructor(message: string, readonly needsSignIn = false) { super(message); }
}

function randomString(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PendingAuth { provider: AuthProvider; verifier: string; state: string; redirectUri: string; url: string }

/** Build the consent-page URL plus the PKCE verifier/state needed to finish. */
export async function beginAuth(provider: AuthProvider, redirectUri: string, loginHint = ''): Promise<PendingAuth> {
  if (!CONFIG.proxyUrl) throw new AuthError('Sign-in is not set up yet: config.json needs proxyUrl (see docs/SETUP.md).');
  const verifier = randomString(48);
  const state = randomString(16);
  const challenge = await challengeFor(verifier);
  let url: URL;
  if (provider === 'google') {
    if (!CONFIG.googleClientId) throw new AuthError('config.json needs googleClientId (see docs/SETUP.md).');
    url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: CONFIG.googleClientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      code_challenge: challenge, code_challenge_method: 'S256', ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
  } else {
    if (!CONFIG.microsoftClientId) throw new AuthError('config.json needs microsoftClientId (see docs/SETUP.md).');
    url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    url.search = new URLSearchParams({
      client_id: CONFIG.microsoftClientId, redirect_uri: redirectUri, response_type: 'code', response_mode: 'query',
      scope: MICROSOFT_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
      prompt: 'select_account', ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
  }
  return { provider, verifier, state, redirectUri, url: url.toString() };
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch { return {}; }
}

async function proxyPost(path: string, body: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${CONFIG.proxyUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch (error) {
    throw new AuthError(`Could not reach the sign-in service (${(error as Error).message}). Check your connection.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error_description || data.error || response.statusText;
    throw new AuthError(`Sign-in failed: ${detail}`, response.status === 400 || response.status === 401);
  }
  return data;
}

/** Finish sign-in from the redirect URL the provider sent back. */
export async function completeAuth(pending: PendingAuth, redirectedTo: string): Promise<TokenSet> {
  const url = new URL(redirectedTo);
  const params = url.searchParams;
  if (params.get('error')) throw new AuthError(`Sign-in was cancelled or refused: ${params.get('error_description') || params.get('error')}`);
  if (params.get('state') !== pending.state) throw new AuthError('Sign-in response did not match this request. Please try again.');
  const code = params.get('code');
  if (!code) throw new AuthError('Sign-in did not return a code. Please try again.');
  const data = await proxyPost(`/auth/${pending.provider}/token`, { code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
  // Google lets people untick individual permissions on the consent screen. Without these two the app can't work.
  if (pending.provider === 'google' && typeof data.scope === 'string') {
    const granted = data.scope.split(' ');
    const missing = [['gmail.modify', 'read, organize and send email in Gmail'], ['drive.appdata', 'see, create and delete its own configuration data in Google Drive']]
      .filter(([s]) => !granted.some((g: string) => g.endsWith(`/auth/${s}`)));
    if (missing.length) throw new AuthError(`Please sign in again and tick every box on Google's permission screen. Missing: ${missing.map(([, label]) => `"${label}"`).join(' and ')}.`);
  }
  return tokenSetFrom(pending.provider, data, '');
}

function tokenSetFrom(provider: AuthProvider, data: any, previousRefresh: string, previous?: TokenSet): TokenSet {
  const claims = data.id_token ? decodeJwt(data.id_token) : {};
  const email = String(claims.email || claims.preferred_username || previous?.email || '').toLowerCase();
  return {
    provider,
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    refreshToken: data.refresh_token || previousRefresh,
    email,
    name: String(claims.name || previous?.name || email.split('@')[0]),
  };
}

export async function refreshTokens(tokens: TokenSet): Promise<TokenSet> {
  if (!tokens.refreshToken) throw new AuthError('Your session ended. Please sign in again.', true);
  const data = await proxyPost(`/auth/${tokens.provider}/refresh`, { refresh_token: tokens.refreshToken });
  return tokenSetFrom(tokens.provider, data, tokens.refreshToken, tokens);
}

/** Hands out fresh access tokens, refreshing a few minutes before expiry. One refresh at a time. */
export class TokenManager {
  private inflight: Promise<TokenSet> | null = null;
  constructor(private tokens: TokenSet, private onChange: (tokens: TokenSet) => void | Promise<void>) {}

  get current(): TokenSet { return this.tokens; }

  async accessToken(force = false): Promise<string> {
    if (!force && this.tokens.expiresAt - Date.now() > 3 * 60 * 1000) return this.tokens.accessToken;
    if (!this.inflight) {
      this.inflight = refreshTokens(this.tokens).then(async (next) => {
        this.tokens = next;
        await this.onChange(next);
        return next;
      }).finally(() => { this.inflight = null; });
    }
    return (await this.inflight).accessToken;
  }
}

/** fetch() with bearer auth, JSON handling, one retry after a 401 (token refresh) and backoff on 429/503. */
export async function authedFetch(tm: TokenManager, url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const token = await tm.accessToken(attempt === 1);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401 && attempt === 0) return authedFetch(tm, url, init, 1);
  if ((response.status === 429 || response.status === 503) && attempt < 3) {
    const wait = Number(response.headers.get('Retry-After')) * 1000 || 800 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
    return authedFetch(tm, url, init, attempt + 2);
  }
  return response;
}

export async function jsonOrThrow(response: Response, what: string): Promise<any> {
  if (response.ok) return response.status === 204 ? {} : response.json();
  const body = await response.text().catch(() => '');
  let detail = body;
  try { const parsed = JSON.parse(body); detail = parsed.error?.message || parsed.error_description || parsed.error || body; } catch { /* plain text */ }
  if (response.status === 401) throw new AuthError(`${what} failed: your sign-in expired. Please reconnect the account.`, true);
  throw new Error(`${what} failed (${response.status}): ${String(detail).slice(0, 300)}`);
}
