// Sign in with ChatGPT — hand-rolled open-source flow (no DevKit code).
// Implements OpenAI's documented protocol: OIDC + PKCE with a 127.0.0.1
// loopback callback, dynamic client registration via the
// `dynamic_agent_client` pseudo-client, token exchange/refresh against
// https://auth.openai.com, and Responses API inference billed to the
// user's own ChatGPT plan (scope chatgpt.tokens.use.direct).
// Ref: developers.openai.com/siwc/token-sharing-open-source/sign-in
//      developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//
// Credentials live in <userData>/chatgpt-profile.json (owner-only). NEVER
// log tokens. The host ID in <userData>/chatgpt-host.json is a random
// urn:uuid created once per installation.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const AUTH_BASE = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_BASE}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${AUTH_BASE}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const APP_NAME = 'Snapreceipt';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const random = (n = 32) => b64url(crypto.randomBytes(n));

function storagePaths(app) {
  const dir = app.getPath('userData');
  return {
    host: path.join(dir, 'chatgpt-host.json'),
    profile: path.join(dir, 'chatgpt-profile.json')
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function hostId(app) {
  const { host } = storagePaths(app);
  const existing = readJson(host);
  if (existing && existing.ext_agent_host_id) return existing.ext_agent_host_id;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  writeJsonAtomic(host, { ext_agent_host_id: id });
  return id;
}

function loadProfile(app) {
  return readJson(storagePaths(app).profile);
}

function saveProfile(app, profile) {
  writeJsonAtomic(storagePaths(app).profile, profile);
}

function signOut(app) {
  try { fs.rmSync(storagePaths(app).profile, { force: true }); } catch {}
}

// Loopback listener for the OAuth callback. Only the port may vary between
// attempts; scheme/host/path are fixed (OpenAI requirement).
function startCallbackListener() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const onListening = () => {
      const { port } = server.address();
      resolve({
        server,
        redirectUri: `http://127.0.0.1:${port}/auth/callback`
      });
    };
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1'); // any free port
      } else {
        reject(e);
      }
    });
    server.listen(1455, '127.0.0.1');
    server.once('listening', onListening);
  });
}

function waitForCallback(server, expectedState, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Sign-in timed out — no callback received'));
    }, timeoutMs);
    const onReq = (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:3rem"><h2>Snapreceipt</h2><p>Sign-in complete — you can close this tab and return to the app.</p></body></html>');
      cleanup();
      if (params.get('error')) {
        reject(new Error(`OpenAI sign-in failed: ${params.get('error')}`));
        return;
      }
      if (params.get('state') !== expectedState) {
        reject(new Error('Sign-in state mismatch — aborted for safety'));
        return;
      }
      resolve({ code: params.get('code'), clientId: params.get('client_id'), scope: params.get('scope') });
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.off('request', onReq);
      try { server.close(); } catch {}
    };
    server.on('request', onReq);
  });
}

async function exchangeCode({ code, clientId, redirectUri, verifier }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE
    })
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function refreshTokens(profile) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: profile.client_id,
      refresh_token: profile.refresh_token,
      resource: RESOURCE
    })
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}) — sign in again`);
  return res.json();
}

// Verify the ID token against OpenAI's JWKS (signature, issuer, audience,
// expiry) — jose handles the crypto; nonce checked by the caller.
async function verifyIdToken(idToken, clientId) {
  const { createRemoteJWKSet, jwtVerify } = require('jose');
  const discovery = await (await fetch(DISCOVERY_URL)).json();
  const JWKS = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `${AUTH_BASE}`,
    audience: clientId
  });
  return payload;
}

// Full browser sign-in. Returns the saved profile (tokens included).
async function signIn(app, shell) {
  const existing = loadProfile(app);
  const state = random();
  const nonce = random();
  const verifier = random(64);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  const { server, redirectUri } = await startCallbackListener();
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ext_agent_host_id: hostId(app)
  });
  if (existing && existing.client_id) {
    params.set('client_id', existing.client_id);
    if (existing.id_token) params.set('id_token_hint', existing.id_token);
    if (existing.email) params.set('login_hint', existing.email);
  } else {
    params.set('client_id', 'dynamic_agent_client');
    params.set('agent_name_hint', APP_NAME);
  }

  const callbackPromise = waitForCallback(server, state);
  await shell.openExternal(`${AUTHORIZE_URL}?${params}`);
  const callback = await callbackPromise;
  if (!callback.code) throw new Error('No authorization code in callback');
  // New registrations MUST supply the issued client id; reauthorization may
  // omit it (keep the saved one). Never let a callback swap accounts.
  const clientId = callback.clientId || (existing && existing.client_id);
  if (!clientId || clientId === 'dynamic_agent_client') {
    throw new Error('Registration incomplete — OpenAI did not issue a client ID');
  }
  if (existing && existing.client_id && callback.clientId && callback.clientId !== existing.client_id) {
    throw new Error('Callback returned a different client registration — aborted');
  }

  const tokens = await exchangeCode({ code: callback.code, clientId, redirectUri, verifier });
  if (!tokens.id_token) throw new Error('Token response missing ID token');
  const identity = await verifyIdToken(tokens.id_token, clientId);
  if (identity.nonce !== nonce) throw new Error('ID token nonce mismatch — aborted');

  const scopes = String(tokens.scope || callback.scope || '').split(/\s+/).filter(Boolean);
  const profile = {
    email: identity.email || (existing && existing.email) || null,
    issuer: identity.iss,
    subject: identity.sub,
    client_id: clientId,
    ext_agent_host_id: hostId(app),
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || (existing && existing.refresh_token),
    token_type: tokens.token_type || 'Bearer',
    expires_in: tokens.expires_in || 3600,
    scopes,
    saved_at: new Date().toISOString()
  };
  saveProfile(app, profile);
  return profile;
}

// Access token usable right now — refreshes (and persists the rotated
// refresh token) when within a minute of expiry.
async function freshAccessToken(app) {
  const profile = loadProfile(app);
  if (!profile || !profile.access_token) return null;
  const expiresAt = new Date(profile.saved_at).getTime() + (profile.expires_in - 60) * 1000;
  if (Date.now() < expiresAt) return profile.access_token;
  if (!profile.refresh_token) return null;
  const tokens = await refreshTokens(profile);
  const next = {
    ...profile,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || profile.refresh_token,
    expires_in: tokens.expires_in || profile.expires_in,
    scopes: String(tokens.scope || profile.scopes.join(' ')).split(/\s+/).filter(Boolean),
    saved_at: new Date().toISOString()
  };
  saveProfile(app, next);
  return next.access_token;
}

function status(app) {
  const p = loadProfile(app);
  if (!p) return { connected: false, sharing: false, email: null };
  return {
    connected: true,
    email: p.email,
    sharing: Array.isArray(p.scopes) && p.scopes.includes('chatgpt.tokens.use.direct')
  };
}

// Pick a model the signed-in account may use (server ordering preserved).
async function pickModel(accessToken) {
  const res = await fetch(`${RESOURCE}/models`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Model list failed (${res.status})`);
  const json = await res.json();
  const listed = (json.models || json.data || []).filter((m) => m.visibility === 'list' || m.visibility == null);
  if (!listed.length) throw new Error('No models available for this ChatGPT account');
  return listed[0].slug || listed[0].id;
}

// Responses API call billed to the user's ChatGPT plan. stream + store:false
// are REQUIRED by the plan-usage contract. Returns the accumulated text.
async function respondWithPlan(accessToken, { model, prompt, imageBase64 }) {
  const content = [{ type: 'input_text', text: prompt }];
  if (imageBase64) content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` });
  const res = await fetch(`${RESOURCE}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content }],
      store: false,
      stream: true
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);

  let text = '';
  let completed = false;
  let failed = null;
  const body = await res.text();
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event.type === 'response.output_text.delta' && event.delta) text += event.delta;
    else if (event.type === 'response.completed') completed = true;
    else if (event.type === 'response.failed') {
      failed = (event.response && event.response.error && event.response.error.code) || 'unknown_error';
    }
  }
  if (failed) {
    if (/usage_limit|usage_unavailable/.test(failed)) {
      throw new Error('ChatGPT plan usage limit reached — manage limits in ChatGPT Settings → Usage');
    }
    throw new Error(`Response failed: ${failed}`);
  }
  if (!completed) throw new Error('Stream ended without response.completed');
  return text;
}

module.exports = { signIn, signOut, status, freshAccessToken, pickModel, respondWithPlan };
