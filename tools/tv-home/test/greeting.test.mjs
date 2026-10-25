import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {greetingFor, periodAt, msUntilNextBoundary, watchPeriod} from '../src/lib/greeting.ts';

test('cutoffs 06/12/21', () => {
	const g = (h) => greetingFor(h);
	assert.equal(g(0), 'Buenas noches'); assert.equal(g(5), 'Buenas noches');
	assert.equal(g(6), 'Buenos días'); assert.equal(g(11), 'Buenos días');
	assert.equal(g(12), 'Buenas tardes'); assert.equal(g(20), 'Buenas tardes');
	assert.equal(g(21), 'Buenas noches'); assert.equal(g(23), 'Buenas noches');
	assert.equal(greetingFor(8, 'Nico'), 'Buenos días, Nico');
	assert.equal(periodAt(12), 'tarde');
});

test('ms until next boundary, incl. midnight rollover', () => {
	assert.equal(msUntilNextBoundary(new Date(2026, 9, 25, 5, 59, 0)), 60_000);
	assert.equal(msUntilNextBoundary(new Date(2026, 9, 25, 6, 0, 0)), 6 * 3600_000);
	assert.equal(msUntilNextBoundary(new Date(2026, 9, 25, 21, 0, 0)), 9 * 3600_000); // -> 06:00 next day
	assert.equal(msUntilNextBoundary(new Date(2026, 9, 25, 23, 59, 59)), 6 * 3600_000 + 1000);
	assert.equal(msUntilNextBoundary(new Date(2026, 11, 31, 22, 0, 0)), 8 * 3600_000); // year change
});

function fake (start) {
	let t = start.getTime(); let q = []; let id = 0;
	return {
		s: {now: () => new Date(t), setTimeout: (fn, ms) => { q.push({id: ++id, at: t + ms, fn}); return id; }, clearTimeout: (i) => { q = q.filter((x) => x.id !== i); }},
		pending: () => q.length,
		advance (ms) { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const n = q[0]; if (!n || n.at > end) break; q.shift(); t = n.at; n.fn(); } t = end; },
		set (d) { t = d.getTime(); }
	};
}

test('changes without reload across the three boundaries and midnight', () => {
	const f = fake(new Date(2026, 9, 25, 11, 58, 0)); const seen = [];
	watchPeriod((p) => seen.push(p), f.s);
	f.advance(3 * 60_000); assert.deepEqual(seen, ['tarde']);
	f.advance(9 * 3600_000); assert.deepEqual(seen, ['tarde', 'noche']);       // 21:01
	f.advance(9 * 3600_000); assert.deepEqual(seen, ['tarde', 'noche', 'manana']); // 06:01 next day
	f.advance(10 * 60_000); assert.equal(seen.length, 3);                       // no repeats
});

test('one timer at a time, bounded delay, cleanup cancels it', () => {
	const f = fake(new Date(2026, 9, 25, 13, 0, 0));
	const stop = watchPeriod(() => {}, f.s);
	assert.equal(f.pending(), 1);
	f.advance(30 * 60_000); assert.equal(f.pending(), 1);
	stop(); assert.equal(f.pending(), 0);
	f.advance(3600_000); assert.equal(f.pending(), 0);
});

test('a clock/timezone jump is noticed within 60 s', () => {
	const f = fake(new Date(2026, 9, 25, 8, 0, 0)); const seen = [];
	watchPeriod((p) => seen.push(p), f.s);
	f.set(new Date(2026, 9, 25, 15, 0, 0)); // TV timezone/clock changed
	f.advance(61_000); assert.deepEqual(seen, ['tarde']);
});

test('timer firing slightly early does not skip or duplicate', () => {
	const f = fake(new Date(2026, 9, 25, 20, 59, 59, 900)); const seen = [];
	watchPeriod((p) => seen.push(p), f.s);
	f.advance(200); assert.deepEqual(seen, ['noche']);
});

// Se ejecuta con TZ distinto (ver script de CI/manual): el mismo instante UTC da saludo segun la hora local.
const EXPECT = {'Europe/Madrid': 'Buenos días', 'America/Mexico_City': 'Buenas noches', 'Asia/Tokyo': 'Buenas tardes'};
// 2026-10-25 07:00 UTC = 09:00 Madrid (CET, tras el cambio horario), 01:00 Mexico_City, 16:00 Tokyo
test('local zone: same UTC instant, greeting follows the TV local hour', {skip: !EXPECT[process.env.TZ]}, () => {
	const d = new Date(Date.UTC(2026, 9, 25, 7, 0, 0));
	assert.equal(greetingFor(d.getHours()), EXPECT[process.env.TZ]);
});

test('DST end day (Madrid): boundary delay uses real elapsed time', {skip: process.env.TZ !== 'Europe/Madrid'}, () => {
	// 25 Oct 2026 01:00 local (CEST) -> 06:00 local (CET) are 6 real hours apart (clocks go back at 03:00)
	assert.equal(msUntilNextBoundary(new Date(2026, 9, 25, 1, 0, 0)), 6 * 3600_000);
});
