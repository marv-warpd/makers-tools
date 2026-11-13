// Unit tests for the reads shared by calls that arrive together (data.js, sharedRead): calls at the same time share
// one load of the ClickUp data instead of each loading its own copy.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedRead } from '../data.js';

const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test('calls that arrive together share one load and get the same value', async () => {
  let loads = 0;
  const load = async () => { loads += 1; return later(300, { pages: loads }); };
  const got = await Promise.all(Array.from({ length: 20 }, () => sharedRead('t1', load)));
  assert.equal(loads, 1);
  assert.ok(got.every((v) => v === got[0])); // one shared value, not twenty copies
});

test('a value is reused while it is fresh', async () => {
  let loads = 0;
  const load = async () => { loads += 1; return loads; };
  assert.equal(await sharedRead('t2', load), 1);
  assert.equal(await sharedRead('t2', load), 1);
  assert.equal(loads, 1);
});

test('a load that fails is not kept: the next call loads again', async () => {
  let loads = 0;
  const load = async () => { loads += 1; if (loads === 1) throw new Error('HTTP 502'); return 'ok'; };
  await assert.rejects(sharedRead('t3', load), /HTTP 502/);
  assert.equal(await sharedRead('t3', load), 'ok');
  assert.equal(loads, 2);
});

// --- a card named by ClickUp's own reference, as an agent may pass it ("task:869fmxwph") ---
import { cardRef, matchOne } from '../data.js';

test('a card is found by its name, its id, or ClickUp\'s reference to it', () => {
  for (const t of ['task:869fmxwph', '#869fmxwph', '869fmxwph', 'https://app.clickup.com/t/869fmxwph', 'https://app.clickup.com/t/90122179287/869fmxwph']) {
    assert.equal(cardRef(t), '869fmxwph');
  }
  assert.equal(cardRef('Client P: new delivery area launch'), 'Client P: new delivery area launch');
  const cards = [{ id: '869fmxwph', name: 'Client P: new delivery area launch' }, { id: '869fmxpwp', name: 'Client X: customer stories email sequence' }];
  assert.equal(matchOne(cards, 'task:869fmxwph', 'project').name, 'Client P: new delivery area launch');
  assert.equal(matchOne(cards, 'customer stories', 'project').id, '869fmxpwp');
});
