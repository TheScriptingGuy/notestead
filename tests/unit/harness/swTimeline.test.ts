// The classifier of upstream's service-worker self-reload (docs/test-plans/M2-S5.md RU-12, RU-13; swu-01…05): from the CDP timeline of
// the page and the container's access log it says `committed`, `race` (limitation L22: all four parts of the signature) or `unknown`.
// Synthetic timelines, so the strictness of the race matcher does not depend on the browser's luck.
import { describe, expect, test } from '@jest/globals';
import { classifySelfReload } from '../../e2e/support/swTimeline.ts';
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
});
