import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantService } from '../src/core/service';
import { DemoProvider, DEMO_PEOPLE } from '../src/core/providers/demo';
import { MemoryKV, mergeSynced, emptySynced, matchRate } from '../src/core/state';
import { Gemini } from '../src/core/ai';
import { featuresOf } from '../src/core/learn/features';
import { PriorityModel, FolderModel, examplesFrom } from '../src/core/learn/models';
import { checkSend } from '../src/core/sensitive';
import { parsePeople } from '../src/core/util';

async function demoService() {
  const kv = new MemoryKV();
  const service = await AssistantService.open(new DemoProvider(kv), kv, new Gemini(() => '', null));
  await service.sync();
  return service;
}

test('first run learns from 60 days of history and reaches assisting mode', async () => {
  const service = await demoService();
  const view = service.view();
  assert.ok(view.status.backfilled, 'backfill ran');
  assert.ok(view.learning.n >= 15, `has holdout comparisons (${view.learning.n})`);
  assert.ok(view.learning.rate >= 0.85, `holdout match rate ${view.learning.rate}`);
  assert.equal(view.mode, 'assisting');
});

test('ranks Corey and the inspector above Procore and newsletters', async () => {
  const service = await demoService();
  const view = service.view();
  const ids = view.priority.map((r) => r.id);
  assert.ok(ids.includes('e1'), `Corey (e1) is priority: ${ids.join(',')}`);
  assert.ok(ids.includes('e3'), `Inspector (e3) is priority: ${ids.join(',')}`);
  for (const noise of ['e12', 'e13', 'e16', 'e34']) assert.ok(!ids.includes(noise), `${noise} should not be priority`);
  assert.ok(view.featured, 'has a next move');
});

test('suggests forwarding invoices to Aisha and change orders to Thomas', async () => {
  const service = await demoService();
  const rows = service.rows();
  const invoice = rows.find((r) => r.id === 'e19');
  assert.equal(invoice?.suggestion?.type, 'forward');
  assert.equal(invoice?.suggestion?.to?.email, DEMO_PEOPLE.aisha.email);
  const co = rows.find((r) => r.id === 'e4');
  assert.equal(co?.suggestion?.to?.email, DEMO_PEOPLE.thomas.email);
  // A change-order question from a brand-new sender still goes to Thomas (topic), like the MVP showed.
  assert.equal(rows.find((r) => r.id === 'e7')?.suggestion?.to?.email, DEMO_PEOPLE.thomas.email);
});

test('never suggests forwarding mail you answer yourself, even from a domain you forward invoices from', async () => {
  const service = await demoService();
  const rows = service.rows();
  assert.notEqual(rows.find((r) => r.id === 'e1')?.suggestion?.type, 'forward', 'Corey shares a domain with invoices but you reply to him');
  assert.notEqual(rows.find((r) => r.id === 'e6')?.suggestion?.type, 'forward', 'Marcus’s blueprint question is not a change order');
});

test('auto-files CC-only mail into the CC folder and never files priority mail', async () => {
  const service = await demoService();
  const view = service.view();
  const movedIds = view.moved.map((m) => m.msgId);
  assert.ok(movedIds.includes('e24') || movedIds.includes('e22'), `CC mail moved: ${movedIds.join(',')}`);
  for (const p of ['e1', 'e2', 'e3']) assert.ok(!movedIds.includes(p), `${p} must stay in the inbox`);
  assert.ok(view.cc.some((r) => r.id === 'r6' || r.folderName === 'CC'), 'CC view lists copied mail');
});

test('undo puts an auto-filed email back and counts as a correction', async () => {
  const service = await demoService();
  const moved = service.view().moved[0];
  assert.ok(moved, 'something was moved');
  const before = matchRate(service.state.synced.matches, 'folder').n;
  await service.act({ type: 'undo-move', id: moved.msgId });
  assert.ok(!service.view().moved.some((m) => m.msgId === moved.msgId));
  assert.equal(matchRate(service.state.synced.matches, 'folder').n, before + 1);
});

test('explicit corrections move emails and the model learns from them', async () => {
  const service = await demoService();
  await service.act({ type: 'not-priority', id: 'e1' });
  assert.ok(!service.view().priority.some((r) => r.id === 'e1'));
  await service.act({ type: 'make-priority', id: 'e8' });
  assert.ok(service.view().priority.some((r) => r.id === 'e8'));
  await service.act({ type: 'sender-pref', email: 'notifications@procore.example', name: 'Procore', pref: 'always' });
  assert.ok(service.view().priority.some((r) => r.fromEmail === 'notifications@procore.example'));
});

test('replying through the app marks it handled and drops it from Priority', async () => {
  const service = await demoService();
  await service.act({ type: 'reply', id: 'e3', text: 'Confirmed for Wednesday.' });
  assert.ok(!service.view().priority.some((r) => r.id === 'e3'));
  await service.sync();
  assert.equal(service.state.synced.decisions.filter((d) => d.msgId === 'e3' && d.kind === 'replied').length, 1, 'no duplicate decision after the sent mail syncs back');
});

test('sync merge is a union and keeps newest per key', () => {
  const a = emptySynced();
  const b = emptySynced();
  a.decisions.push({ id: 'x:replied', msgId: 'x', kind: 'replied', at: 1, arrived: 0, sender: 's', features: ['bias'], source: 'observed' });
  b.decisions.push({ id: 'y:trashed', msgId: 'y', kind: 'trashed', at: 2, arrived: 0, sender: 's', features: ['bias'], source: 'observed' });
  a.senderPrefs.s = { pref: 'always', at: 5, name: 'S' };
  b.senderPrefs.s = { pref: 'later', at: 9, name: 'S' };
  const merged = mergeSynced(a, b);
  assert.equal(merged.decisions.length, 2);
  assert.equal(merged.senderPrefs.s.pref, 'later');
});

test('models: priority separates, folder model files by sender', () => {
  const me = { me: 'jeff@x.com' };
  const mk = (from: string, subject: string, cc = false) => featuresOf({ id: subject, threadId: subject, from: { name: from, email: from }, to: cc ? [] : [{ name: 'J', email: 'jeff@x.com' }], cc: cc ? [{ name: 'J', email: 'jeff@x.com' }] : [], subject, snippet: '', date: 0, isRead: false, flagged: false, hasAttachments: false, inInbox: true, inTrash: false, folderId: null, isBulk: false }, me);
  const decisions = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}:replied`, msgId: `a${i}`, kind: 'replied' as const, at: i, arrived: 0, sender: 'boss@x.com', features: mk('boss@x.com', 'budget review'), source: 'observed' as const, latencyMin: 20 })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `b${i}:ignored`, msgId: `b${i}`, kind: 'ignored' as const, at: i, arrived: 0, sender: 'news@y.com', features: mk('news@y.com', 'weekly digest'), source: 'observed' as const })),
  ];
  const pm = new PriorityModel();
  pm.train(examplesFrom(decisions));
  assert.ok(pm.score(mk('boss@x.com', 'new topic')) > 0.6);
  assert.ok(pm.score(mk('news@y.com', 'weekly digest')) < 0.4);
  const fm = new FolderModel();
  fm.train([{ features: mk('news@y.com', 'digest'), folder: 'News' }, { features: mk('news@y.com', 'weekly'), folder: 'News' }, { features: mk('boss@x.com', 'budget'), folder: '' }]);
  assert.equal(fm.predict(mk('news@y.com', 'digest again')).folder, 'News');
});

test('send checks flag money, attachments and outside recipients', () => {
  const msg = { id: '1', threadId: '1', from: { name: 'A', email: 'a@vendor.com' }, to: [], cc: [], subject: 'Invoice 22', snippet: 'Wire $4,000 to account', date: 0, isRead: true, flagged: false, hasAttachments: true, inInbox: true, inTrash: false, folderId: null, isBulk: false };
  const check = checkSend({ kind: 'forward', message: msg, text: 'fyi', to: [{ name: 'X', email: 'x@other.com' }], me: 'me@builder.com' });
  assert.ok(check.needsConfirm);
  assert.equal(check.reasons.length, 3);
});

test('address parsing handles quoted commas', () => {
  const people = parsePeople('"Doe, Jane" <jane@x.com>, bob@y.com');
  assert.deepEqual(people.map((p) => p.email), ['jane@x.com', 'bob@y.com']);
  assert.equal(people[0].name, 'Doe, Jane');
});
