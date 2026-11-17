/* Priority Assistant proxy (Cloudflare Worker). Two jobs:
   1. Sign-in broker: holds the Google/Microsoft client secrets and swaps OAuth codes for tokens, so the extension
      and phone app get refresh tokens without shipping secrets.
   2. Gemini proxy: forwards AI requests using the team's Gemini key, only for signed-in users matching ALLOWED_EMAILS ("*" = anyone signed in).
   Secrets are set with `wrangler secret put` (see docs/SETUP.md). Nothing about the user's email is stored. */

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  GEMINI_API_KEY: string;
  ALLOWED_EMAILS: string;     // comma-separated emails or @domains; "*" allows any signed-in user
  ALLOWED_ORIGINS: string;    // comma-separated: chrome-extension://<id>, https://<your pages site>, http://localhost:5173
  ALLOWED_MODELS?: string;    // optional comma-separated model allowlist
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Provider',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function tokenRequest(url: string, params: Record<string, string>): Promise<Response> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await response.json().then((d) => d as Record<string, unknown>).catch(() => ({ error: 'bad_response' }));
  // Only pass back what the app needs.
  const { access_token, refresh_token, expires_in, id_token, error, error_description } = data as Record<string, string>;
  return json(error ? { error, error_description } : { access_token, refresh_token, expires_in, id_token }, response.ok ? 200 : 400);
}

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_SCOPES = 'openid email profile offline_access User.Read Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite Files.ReadWrite.AppFolder';

async function handleAuth(path: string, body: Record<string, string>, env: Env): Promise<Response> {
  switch (path) {
    case '/auth/google/token':
      return tokenRequest(GOOGLE_TOKEN, { grant_type: 'authorization_code', code: body.code, code_verifier: body.code_verifier, redirect_uri: body.redirect_uri, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
    case '/auth/google/refresh':
      return tokenRequest(GOOGLE_TOKEN, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
    case '/auth/microsoft/token':
      return tokenRequest(MS_TOKEN, { grant_type: 'authorization_code', code: body.code, code_verifier: body.code_verifier, redirect_uri: body.redirect_uri, client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET, scope: MS_SCOPES });
    case '/auth/microsoft/refresh':
      return tokenRequest(MS_TOKEN, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET, scope: MS_SCOPES });
    default:
      return json({ error: 'not_found' }, 404);
  }
}

/** Who is calling? Verify the caller's own Google/Microsoft access token with the provider. Cached briefly. */
const identityCache = new Map<string, { email: string; until: number }>();
async function callerEmail(request: Request): Promise<string | null> {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const provider = request.headers.get('X-Auth-Provider');
  if (!token || !provider) return null;
  const key = `${provider}:${token.slice(-24)}`;
  const hit = identityCache.get(key);
  if (hit && hit.until > Date.now()) return hit.email;
  let email: string | null = null;
  if (provider === 'google') {
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) { const d = (await r.json() as { email?: string; email_verified?: boolean }); if (d.email && d.email_verified !== false) email = d.email; }
  } else if (provider === 'microsoft') {
    const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) { const d = (await r.json() as { mail?: string; userPrincipalName?: string }); email = d.mail || d.userPrincipalName || null; }
  }
  if (email) {
    email = email.toLowerCase();
    identityCache.set(key, { email, until: Date.now() + 10 * 60 * 1000 });
    if (identityCache.size > 500) identityCache.delete(identityCache.keys().next().value!);
  }
  return email;
}

function allowed(email: string, env: Env): boolean {
  const rules = env.ALLOWED_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return rules.includes('*') || rules.includes(email) || rules.some((r) => r.startsWith('@') && email.endsWith(r));
}

async function handleAi(request: Request, env: Env): Promise<Response> {
  const email = await callerEmail(request);
  if (!email) return json({ error: { message: 'Sign in again: could not verify your account.' } }, 401);
  if (!allowed(email, env)) return json({ error: { message: `${email} is not on the tester list. Add your own Gemini key in Settings, or ask the team to add you.` } }, 403);
  const body = await request.json().then((d) => d as { model?: string; request?: unknown }).catch(() => ({} as { model?: string; request?: unknown }));
  const model = String(body.model || 'gemini-flash-lite-latest');
  const models = (env.ALLOWED_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!/^[a-z0-9.\-]+$/i.test(model) || (models.length && !models.includes(model))) return json({ error: { message: `Model ${model} is not allowed.` } }, 400);
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body.request || {}),
  });
  return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
    if (request.headers.get('Origin') && !cors['Access-Control-Allow-Origin']) return json({ error: 'origin_not_allowed' }, 403);
    let response: Response;
    try {
      if (url.pathname.startsWith('/auth/')) response = await handleAuth(url.pathname, (await request.json() as Record<string, string>), env);
      else if (url.pathname === '/ai/generate') response = await handleAi(request, env);
      else response = json({ error: 'not_found' }, 404);
    } catch (error) {
      response = json({ error: 'server_error', error_description: (error as Error).message }, 500);
    }
    const headers = new Headers(response.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, { status: response.status, headers });
  },
};
