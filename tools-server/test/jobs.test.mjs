// Unit tests for the Monday client-figures job (jobs.js): when it runs, the rounds average, and each
// Client card's figures and changes from the tools' answers. No ClickUp: hand-built answers and cards.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRefreshTime, roundsAverage, clientFigures, scheduledRun, accountHealth, healthWhy, CRONS } from '../jobs.js';
import { makeTree } from '../data.js';

const at = (iso) => Date.parse(iso);

test('the client figures run at 07:30 on a Monday in London, on whichever UTC cron that is, summer or winter', () => {
  assert.deepEqual(CRONS, ['30 6 * * MON', '30 7 * * MON']);
  assert.equal(isRefreshTime(at('2026-11-09T07:30:00Z')), true); // November: London is UTC
  assert.equal(isRefreshTime(at('2026-11-09T06:30:00Z')), false);
  assert.equal(isRefreshTime(at('2026-07-06T06:30:00Z')), true); // July: London is UTC+1
  assert.equal(isRefreshTime(at('2026-07-06T07:30:00Z')), false);
  assert.equal(isRefreshTime(at('2026-11-10T07:30:00Z')), false); // a Tuesday
});

test('the scheduled handler does nothing on the cron that is not 07:30 in London', async () => {
  assert.equal(await scheduledRun({ cron: '30 6 * * MON', scheduledTime: at('2026-11-09T06:30:00Z') }, {}), null);
});

const card = (id, client, extra = {}) => ({ id, name: `${client}: job ${id}`, parent: null, type: 0, status: 'complete', closed: true, start: null, due: null,
  estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [], f: { Client: [{ id: `c-${client}`, name: client }], 'Agreement type': 'Fixed fee', ...extra } });

test('Average rounds: every finished and live fixed-fee job, a half rounded up; retainer pieces and [Test] cards left out', () => {
  const k = [2, 0, 1, 1, 1, 1, 2, 2, 0, 1, 2, 2].map((r, i) => card(`k${i}`, 'Client K', { 'Rounds used': r }));
  k[8] = { ...k[8], status: 'in progress', closed: false }; // a live job counts too
  const tasks = [...k,
    { ...card('t', 'Client K', { 'Rounds used': 9 }), name: '[Test] Client K: job' },
    card('m', 'Client B', {}), { ...card('m', 'Client B'), id: 'm1', name: 'Retainer month: Client B, October 2026', f: { Client: [{ id: 'c-b', name: 'Client B' }] } },
    { ...card('p', 'Client B', { 'Agreement type': 'Retainer', 'Rounds used': 3 }), parent: 'm1' },
    card('d1', 'Client D', { 'Rounds used': 1 }), card('d2', 'Client D', { 'Rounds used': 0 }), card('d3', 'Client D', { 'Rounds used': 2 })];
  const avg = roundsAverage(makeTree(tasks));
  assert.equal(avg.get('Client K'), 1.3); // 15 rounds on 12 jobs, 1.25
  assert.equal(avg.get('Client D'), 1);
  assert.equal(avg.has('Client B'), false); // a retainer client: no fixed-fee job, so blank
});

const answers = () => ({
  margins: [{ client: 'Client K', projects: 11, retainer_months: 0, price: 29925, margin: 13168, margin_pct: 44 },
    { client: 'Client B', projects: 0, retainer_months: 6, price: 36000, margin: 22935, margin_pct: 64 }],
  onTime: { rows: [{ group: 'Client K', share: 73 }, { group: 'Client B', share: 100 }],
    late: [{ client: 'Client K', late_by: 6 }, { client: 'Client K', late_by: 4 }, { client: 'Client K', late_by: 2 }] },
  rework: { rows: [{ group: 'Client K', client_h: 50.8, internal_h: 9.2 }, { group: 'Client B', client_h: 0.5, internal_h: 0 }] },
  rounds: new Map([['Client K', 1.3]]),
  usage: new Map([['Client B', { used_pct: 20, trend: { points: 18.7 } }]]),
});
const FIELDS = ['Margin', 'Margin %', 'Fees to date', 'On time %', 'Late days', 'Client revision hrs', 'Internal rework hrs',
  'Average rounds', 'Retainer usage %', 'Retainer trend %', 'Allowance', 'Account health', 'Why', 'Figures as of'];
const cardOf = (id, name, stored = {}) => ({ id, name, values: Object.fromEntries(FIELDS.map((f) => [f, stored[f] ?? null])) });

test('each Client card\'s figures from the tools\' answers; only what differs is written; blanks stay blank', () => {
  const rows = clientFigures({ ...answers(), cards: [cardOf('k', 'Client K', { 'Margin': 13168, 'On time %': 73 }), cardOf('b', 'Client B', { Allowance: 40 })] });
  const k = rows.find((r) => r.card === 'Client K');
  assert.deepEqual(k.values, { 'Margin': 13168, 'Margin %': 44, 'Fees to date': 29925, 'Late days': 12, 'Client revision hrs': 50.8,
    'Internal rework hrs': 9.2, 'On time %': 73, 'Average rounds': 1.3, 'Account health': 'At risk',
    'Why': 'At risk: 44% margin with 12 late days; 50.8 client revision hours.' });
  assert.deepEqual(Object.keys(k.changes), ['Margin %', 'Fees to date', 'Late days', 'Client revision hrs', 'Internal rework hrs', 'Average rounds',
    'Account health', 'Why']);
  const b = rows.find((r) => r.card === 'Client B');
  assert.equal(b.values['Retainer usage %'], 20);
  assert.equal(b.values['Retainer trend %'], 18.7);
  assert.equal(b.values['Fees to date'], 36000);
  assert.equal(b.values['Account health'], 'Healthy');
  assert.equal(b.values.Why, 'Healthy: 64% margin, 100% on time.');
  // the same option already on the card is no change
  const again = clientFigures({ ...answers(), cards: [cardOf('k', 'Client K', { 'Account health': 'At risk' }), cardOf('b', 'Client B')] });
  assert.equal('Account health' in again.find((r) => r.card === 'Client K').changes, false);
  assert.equal('Retainer trend %' in k.values, false); // no retainer: blank
  // a retainer client with fewer than six finished months: usage written, the trend left blank
  const young = clientFigures({ ...answers(), usage: new Map([['Client B', { used_pct: 20, trend: null }]]), cards: [cardOf('k', 'Client K'), cardOf('b', 'Client B')] });
  assert.equal('Retainer trend %' in young.find((r) => r.card === 'Client B').values, false);
  assert.equal('Average rounds' in b.values, false); // no fixed-fee job: blank
  assert.equal('Retainer usage %' in k.values, false); // no retainer: blank
});

test('a client with no finished work yet is skipped and the rest are worked out; finished work with no Client card writes nothing', () => {
  const rows = clientFigures({ ...answers(), cards: [cardOf('k', 'Client K'), cardOf('z', 'Client Z', { 'Account health': 'Watch' }), cardOf('b', 'Client B')] });
  assert.deepEqual(rows.map((r) => r.card), ['Client K', 'Client B']); // Client Z: a card, no finished work
  assert.throws(() => clientFigures({ ...answers(), cards: [cardOf('k', 'Client K')] }), /Client B has finished work but no Client card/);
  // 26 late jobs on one client are all added up (the job reads every page of them; pages.test.mjs)
  const many = clientFigures({ ...answers(), onTime: { ...answers().onTime, late: Array.from({ length: 26 }, () => ({ client: 'Client K', late_by: 2 })) },
    cards: [cardOf('k', 'Client K'), cardOf('b', 'Client B')] });
  assert.equal(many.find((r) => r.card === 'Client K').values['Late days'], 52);
  assert.throws(() => clientFigures({ ...answers(), onTime: { rows: [{ group: 'Client K', share: 73 }], late: [] },
    cards: [cardOf('k', 'Client K'), cardOf('b', 'Client B', { 'On time %': 100 })] }), /stored on-time rate/);
});

test('Account health: At risk on any of its conditions, else Watch on any of its, else Healthy; each condition at its edge; nothing else trips either; a blank meets no condition', () => {
  const healthy = { 'Margin %': 55, 'On time %': 100, 'Late days': 0, 'Client revision hrs': 0, 'Internal rework hrs': 0, 'Average rounds': 0.5 };
  const h = (change) => accountHealth({ ...healthy, ...change });
  assert.equal(h({}), 'Healthy');
  // At risk
  assert.equal(h({ 'Margin %': 47.9, 'Late days': 10 }), 'At risk');
  assert.equal(h({ 'Retainer usage %': 110.1 }), 'At risk');
  // Watch, each at its edge
  assert.equal(h({ 'Margin %': 47.9 }), 'Watch');
  assert.equal(h({ 'Margin %': 47.9, 'Late days': 9 }), 'Watch');
  assert.equal(h({ 'Margin %': 48, 'Late days': 30 }), 'Watch'); // lateness alone is a Watch
  assert.equal(h({ 'Late days': 20 }), 'Watch');
  assert.equal(h({ 'Client revision hrs': 25.1 }), 'Watch');
  assert.equal(h({ 'Retainer usage %': 100.1 }), 'Watch');
  // nothing else trips
  assert.equal(h({ 'Margin %': 48, 'On time %': 20, 'Late days': 19, 'Client revision hrs': 25, 'Internal rework hrs': 40, 'Average rounds': 3,
    'Retainer trend %': -30, 'Retainer usage %': 100 }), 'Healthy');
  assert.equal(h({ 'Retainer usage %': 0, 'Retainer trend %': -12 }), 'Healthy');
  // blanks meet no condition
  assert.equal(accountHealth({}), 'Healthy');
  assert.equal(accountHealth({ 'Margin %': null, 'Late days': 25 }), 'Watch');
  assert.equal(accountHealth({ 'Margin %': null, 'Late days': 15 }), 'Healthy');
});

test('the Why sentence: the health, then only the conditions met, in the settings\' order, at most two, no figure twice', () => {
  assert.equal(healthWhy({ 'Margin %': 44, 'On time %': 73, 'Late days': 12, 'Client revision hrs': 50.8, 'Average rounds': 1.3 }),
    'At risk: 44% margin with 12 late days; 50.8 client revision hours.');
  assert.equal(healthWhy({ 'Margin %': 47, 'On time %': 50, 'Late days': 16, 'Client revision hrs': 13.5, 'Internal rework hrs': 12.2 }),
    'At risk: 47% margin with 16 late days.');
  assert.equal(healthWhy({ 'Margin %': 50, 'Late days': 24, 'Client revision hrs': 29.5 }), 'Watch: 24 late days; 29.5 client revision hours.');
  assert.equal(healthWhy({ 'Margin %': 41, 'Late days': 4 }), 'Watch: 41% margin.');
  assert.equal(healthWhy({ 'Margin %': 40, 'Late days': 25, 'Client revision hrs': 30, 'Retainer usage %': 120 }),
    'At risk: 40% margin with 25 late days; retainer use at 120% of the allowance.');
  assert.equal(healthWhy({ 'Margin %': 70, 'Retainer usage %': 118 }), 'At risk: retainer use at 118% of the allowance.');
  assert.equal(healthWhy({ 'Margin %': 59, 'On time %': 100, 'Late days': 0 }), 'Healthy: 59% margin, 100% on time.');
});
