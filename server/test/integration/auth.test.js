import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, cookieFromResponse, skipIfNoDb } from './helper.js';

test('register → me returns the user', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const reg = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username: 'alice', password: 'password123' }
  });
  assert.equal(reg.statusCode, 200);
  const cookie = cookieFromResponse(reg);
  assert.ok(cookie, 'expected session cookie');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, 'alice');
});

test('register rejects invalid username/password', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const r1 = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'a', password: 'password123' } });
  assert.equal(r1.statusCode, 400);
  const r2 = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'short' } });
  assert.equal(r2.statusCode, 400);
});

test('register rejects duplicate username with 409', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  const dup = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  assert.equal(dup.statusCode, 409);
});

test('login + bad password → 401 with vague error', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'alice', password: 'wrong-password' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, 'invalid_credentials');

  const missing = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'no-such-user', password: 'whatever12' } });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error, 'invalid_credentials');
});

test('logout clears the session', async (t) => {
  if (skipIfNoDb(t)) return;
  const { app } = await freshApp();
  t.after(() => app.close());

  const reg = await app.inject({ method: 'POST', url: '/api/register', payload: { username: 'alice', password: 'password123' } });
  const cookie = cookieFromResponse(reg);
  await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().user, null);
});
