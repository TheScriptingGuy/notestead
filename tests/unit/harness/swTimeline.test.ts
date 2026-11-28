// The classifier of upstream's service-worker self-reload (docs/test-plans/M2-S5.md RU-12, RU-13; swu-01…05): from the CDP timeline of
// the page and the container's access log it says `committed`, `race` (limitation L22: all four parts of the signature) or `unknown`.
// Synthetic timelines, so the strictness of the race matcher does not depend on the browser's luck.
import { describe, expect, test } from '@jest/globals';
import { classifySelfReload, judgeUserReload } from '../../e2e/support/swTimeline.ts';
import type { SwEvent } from '../../e2e/support/swTimeline.ts';

const line = 10_000;
const wv = (t: number, versionId: string, status: string, runningStatus = 'running'): SwEvent => ({ t, kind: 'workerVersionUpdated', versionId, status, runningStatus });
const requested = (t: number): SwEvent => ({ t, kind: 'frameRequestedNavigation', reason: 'reload', path: '/' });
const started = (t: number): SwEvent => ({ t, kind: 'frameStartedLoading' });
const navigated = (t: number, path = '/', main = true): SwEvent => ({ t, kind: 'frameNavigated', path, main });
const get = (ts: number, path = '/', status = 200): { method: string; path: string; status: number; ts: number } => ({ method: 'GET', path, status, ts });

const prelude = [wv(line - 3000, '0', 'activated'), wv(line - 20, '1', 'installing'), wv(line - 5, '1', 'installed')];
const raceEvents = [...prelude, requested(line + 5), started(line + 10), wv(line + 40, '0', 'activated', 'stopping'), wv(line + 60, '0', 'redundant', 'stopped'), wv(line + 65, '1', 'activating'), wv(line + 1000, '1', 'activated')];

describe('self-reload classifier', () => {
	test('swu-01 a main-frame navigation and a GET / after the line is committed', () => {
		const events = [...prelude, requested(line + 5), started(line + 10), wv(line + 40, '0', 'activated', 'stopping'), navigated(line + 120)];
		const r = classifySelfReload(events, [get(line + 40)], line);
		expect(r.outcome).toBe('committed');
	});

	test('swu-02 the full race signature (i to iv) is the race', () => {
		const r = classifySelfReload(raceEvents, [get(line - 5000), get(line + 7000, '/serviceWorker.bundle.js', 304)], line);
		expect(r.outcome).toBe('race');
		expect(r.parts.join(' ')).toMatch(/\(i\).*\(ii\).*\(iii\).*\(iv\)/);
	});

	test('swu-03 a hang without part (ii), the old version redundant and the new one activating, is unknown and names (ii)', () => {
		const r = classifySelfReload(raceEvents.filter(e => e.kind !== 'workerVersionUpdated'), [], line);
		expect(r.outcome).toBe('unknown');
		expect(r.parts.join(' ')).toMatch(/\(ii\)[^;]*missing/);
		// only the redundant event missing is also unknown
		expect(classifySelfReload(raceEvents.filter(e => !(e.kind === 'workerVersionUpdated' && e.status === 'redundant')), [], line).outcome).toBe('unknown');
	});

	test('swu-04 a hang that nevertheless has a GET / after the line is unknown and names (iv)', () => {
		const r = classifySelfReload(raceEvents, [get(line + 300)], line);
		expect(r.outcome).toBe('unknown');
		expect(r.parts.join(' ')).toMatch(/\(iv\)[^;]*missing/);
	});

	test('swu-05 a hang with no reload request is unknown and names (i); a navigation of about:blank is no commit', () => {
		const r = classifySelfReload(raceEvents.filter(e => e.kind !== 'frameRequestedNavigation'), [], line);
		expect(r.outcome).toBe('unknown');
		expect(r.parts.join(' ')).toMatch(/\(i\)[^;]*missing/);
		const blank = classifySelfReload([...raceEvents, navigated(line + 500, 'blank')], [], line);
		expect(blank.outcome).toBe('race');
	});
	// RU-15: the user's reload in the race branch is judged by the browser's commit and the server's log, not by Playwright's promise
	const t0 = 50_000;
	const ok = { state: 'resolved' } as const;
	const aborted = { state: 'rejected', message: 'page.reload: net::ERR_ABORTED; maybe frame was detached?' } as const;

	test('swu-06 a resolved reload with a main-frame commit and a GET / is committed', () => {
		const r = judgeUserReload(ok, [navigated(t0 + 100)], [get(t0 + 20)], t0);
		expect(r.committed).toBe(true);
	});

	test('swu-07 ERR_ABORTED with a commit and a GET / is committed (the reload replaced the stuck self-reload)', () => {
		const r = judgeUserReload(aborted, [navigated(t0 + 100)], [get(t0 + 20)], t0);
		expect(r.committed).toBe(true);
		expect(r.parts.join(' ')).toMatch(/ERR_ABORTED/);
	});

	test('swu-08 a GET / without a commit, or a commit without a GET /, is not committed', () => {
		expect(judgeUserReload(aborted, [], [get(t0 + 20)], t0).committed).toBe(false);
		expect(judgeUserReload(ok, [navigated(t0 + 100)], [], t0).committed).toBe(false);
		// events before t0 do not count, and neither does about:blank
		expect(judgeUserReload(ok, [navigated(t0 - 100), navigated(t0 + 10, 'blank')], [get(t0 + 20)], t0).committed).toBe(false);
	});

	test('swu-09 any other rejection fails, named, even with a commit and a GET /', () => {
		const r = judgeUserReload({ state: 'rejected', message: 'page.reload: net::ERR_FAILED' }, [navigated(t0 + 100)], [get(t0 + 20)], t0);
		expect(r.committed).toBe(false);
		expect(r.parts.join(' ')).toMatch(/ERR_FAILED/);
	});
	// RU-17: (N) the browser found the new worker at the start of the navigation, so upstream's page script never saw `updatefound`
	const load = { t: line - 5_000, previousVersionId: '0' };
	const nEvents = [wv(load.t + 10, '0', 'activated'), wv(load.t + 300, '1', 'installing'), wv(load.t + 400, '1', 'installed'), wv(load.t + 450, '1', 'activating'), wv(load.t + 600, '1', 'activated')];
	const swGet = (ts: number, status: number): { method: string; path: string; status: number; ts: number } => get(ts, '/serviceWorker.bundle.js', status);

	test('swu-10 no reload line, a new version activated, no reload navigation and a 200 for the worker script is (N)', () => {
		const r = classifySelfReload(nEvents, [get(load.t + 5), swGet(load.t + 8, 200)], undefined, 60_000, load);
		expect(r.outcome).toBe('updated-at-navigation');
		expect(r.parts.join(' ')).toMatch(/0 .* 1/);
	});

	test('swu-11 (N) without the new version activating (ii) is unknown, and names (ii)', () => {
		const r = classifySelfReload(nEvents.filter(e => !(e.versionId === '1' && (e.status === 'activating' || e.status === 'activated'))), [swGet(load.t + 8, 200)], undefined, 60_000, load);
		expect(r.outcome).toBe('unknown');
		expect(r.parts.join(' ')).toMatch(/\(N\)[^;]*activated: missing/);
	});

	test('swu-12 (N) with only a 304 for the worker script (iv) is unknown, and names (iv)', () => {
		const r = classifySelfReload(nEvents, [swGet(load.t + 8, 304)], undefined, 60_000, load);
		expect(r.outcome).toBe('unknown');
		expect(r.parts.join(' ')).toMatch(/\(iv\)[^;]*missing/);
		// a reload navigation after the load (iii) also rules (N) out
		expect(classifySelfReload([...nEvents, requested(load.t + 700)], [swGet(load.t + 8, 200)], undefined, 60_000, load).outcome).toBe('unknown');
	});

	test('swu-13 with a reload line the outcome is never (N)', () => {
		const r = classifySelfReload([...nEvents, requested(line + 5)], [swGet(load.t + 8, 200)], line, 60_000, load);
		expect(r.outcome).not.toBe('updated-at-navigation');
	});
	// RU-24: (C) is proven by the timeline, the console line is not required; (M) the update missed at this load
	const lt = { t: 100_000, previousVersionId: '0' };
	const cEvents = [wv(lt.t + 5, '0', 'activated'), wv(lt.t + 3063, '1', 'installing'), requested(lt.t + 3063), navigated(lt.t + 3064)];

	test('swu-14 a page-requested reload with a new version installing, a main-frame commit and a GET / is (C) without a console line', () => {
		const r = classifySelfReload(cEvents, [get(lt.t + 3070, '/', 304)], undefined, 60_000, lt);
		expect(r.outcome).toBe('committed');
	});

	test('swu-15 the same with the console line seen is still (C), and without the GET / it is not', () => {
		expect(classifySelfReload(cEvents, [get(lt.t + 3070, '/', 304)], lt.t + 3062, 60_000, lt).outcome).toBe('committed');
		expect(classifySelfReload(cEvents, [], undefined, 60_000, lt).outcome).toBe('unknown');
	});

	test('swu-16 no new version, no reload request, the active version unchanged and a 200 for the worker script is (M)', () => {
		const r = classifySelfReload([wv(lt.t + 5, '0', 'activated')], [get(lt.t + 4, '/', 200), swGet(lt.t + 8, 200), swGet(lt.t + 3000, 304)], undefined, 60_000, lt);
		expect(r.outcome).toBe('missed-at-load');
	});

	test('swu-17 (M) without the 200 for the worker script, or with a reload request, is unknown', () => {
		expect(classifySelfReload([wv(lt.t + 5, '0', 'activated')], [swGet(lt.t + 8, 304)], undefined, 60_000, lt).outcome).toBe('unknown');
		expect(classifySelfReload([wv(lt.t + 5, '0', 'activated'), requested(lt.t + 100)], [swGet(lt.t + 8, 200)], undefined, 60_000, lt).outcome).toBe('unknown');
	});
});
