// heartbeat.mjs: the state file, and the optional outside ping with fetch mocked.
// No test here touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHeartbeat } from '../heartbeat.mjs';
import { tempDirs } from './helpers.mjs';

test('writes the state file with job, deadline and connection', async () => {
  const file = join(tempDirs().stateDir, 'heartbeat.json');
  const hb = startHeartbeat({
    file, intervalMs: 60_000, log: () => {},
    getStatus: () => ({ job: { id: 'job-1', deadline: '2030-01-01T00:00:00.000Z' }, connection: 'listening' }),
  });
  await hb.beat();
  hb.stop();
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rec.job.id, 'job-1');
  assert.equal(rec.connection, 'listening');
  assert.ok(Date.parse(rec.ts) > 0);
});

test('no ping URL: fetch is never called', async () => {
  let calls = 0;
  const hb = startHeartbeat({
    file: join(tempDirs().stateDir, 'hb.json'), log: () => {},
    fetchImpl: async () => { calls++; return { ok: true }; },
    getStatus: () => ({ job: null, connection: 'listening' }),
  });
  await hb.beat();
  hb.stop();
  assert.equal(calls, 0);
});

test('ping only while the listener is up, so a deaf bridge goes quiet outside', async () => {
  const urls = [];
  let connection = 'listening';
  const hb = startHeartbeat({
    file: join(tempDirs().stateDir, 'hb.json'), log: () => {},
    pingUrl: 'https://ping.example.invalid/abc',
    fetchImpl: async (url) => { urls.push(url); return { ok: true }; },
    getStatus: () => ({ job: null, connection }),
  });
  await hb.beat();
  const afterUp = urls.length;
  connection = 'down';
  await hb.beat();
  hb.stop();
  assert.ok(afterUp >= 1);
  assert.equal(urls.length, afterUp, 'no ping while a listener is down');
});

test('a failing ping is logged and never throws', async () => {
  const lines = [];
  const file = join(tempDirs().stateDir, 'hb.json');
  const hb = startHeartbeat({
    file, log: (...a) => lines.push(a.join(' ')),
    pingUrl: 'https://ping.example.invalid/abc',
    fetchImpl: async () => { throw new Error('network down'); },
    getStatus: () => ({ job: null, connection: 'listening' }),
  });
  await hb.beat();
  hb.stop();
  assert.ok(lines.some((l) => l.includes('network down')));
  await hb.beat().catch(() => assert.fail('beat threw'));
});
