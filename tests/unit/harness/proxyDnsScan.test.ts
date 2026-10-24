// DNS1-AC5 (dns1-u5): the CI scan's pure functions (tests/support/proxyDnsScan.ts). The samples are modelled on real
// Caddy JSON lines and device logs (the logs are redacted already; no token appears here).
import { describe, expect, test } from '@jest/globals';
import { deviceHasLastError, logKindOf, runnerOf, scanWebLog } from '../../support/proxyDnsScan.ts';

const caddyError = (msg: string, duration: number): string => JSON.stringify({
	level: 'error', ts: 1_792_830_104.36, logger: 'http.log.error.log0', msg,
	request: { remote_ip: '10.89.0.9', method: 'POST', host: 'web:8080', uri: '/joplin-server/api/sessions', headers: { Connection: ['keep-alive'] } },
	duration, status: 502, err_id: 'ncapfyxcs',
});

const oldLine = caddyError('dial tcp: lookup server: i/o timeout', 3.000555831);
const nxdomain = caddyError('dial tcp: lookup server on 10.89.12.1:53: no such host', 0.004);
const access = JSON.stringify({ level: 'info', logger: 'http.log.access.log0', msg: 'handled request', status: 200, duration: 0.004 });

describe('dns1-u5 proxy dns scan', () => {
	test('a lookup timeout with a duration of about 3 s is the old signature', () => {
		expect(scanWebLog(`${oldLine}\n${oldLine}\n`)).toEqual({ oldSignature: 2, otherDurations: [], nxdomain: 0 });
	});

	test('the old signature window is 2.5 s to 4.5 s, edges included', () => {
		const text = [2.4, 2.5, 4.5, 4.6].map(d => caddyError('dial tcp: lookup server: i/o timeout', d)).join('\n');
		expect(scanWebLog(text)).toEqual({ oldSignature: 2, otherDurations: [2.4, 4.6], nxdomain: 0 });
	});

	test('a lookup timeout of about 10 s (both nameservers silent) is listed with its duration, not merged', () => {
		const text = caddyError('dial tcp: lookup server: i/o timeout', 10.002);
		expect(scanWebLog(text)).toEqual({ oldSignature: 0, otherDurations: [10.002], nxdomain: 0 });
	});

	test('a lookup timeout that names the nameserver (the resolver\'s own timeout) is a lookup timeout too', () => {
		const text = caddyError('dial tcp: lookup server on 10.89.12.1:53: read udp 10.89.12.2:41234->10.89.12.1:53: i/o timeout', 5.01);
		expect(scanWebLog(text)).toEqual({ oldSignature: 0, otherDurations: [5.01], nxdomain: 0 });
	});

	test('nxdomain lines are reported in their own count and never as timeouts (negative control)', () => {
		expect(scanWebLog(`${nxdomain}\n${nxdomain}\n${nxdomain}\n`)).toEqual({ oldSignature: 0, otherDurations: [], nxdomain: 3 });
	});

	test('clean logs, access lines, plain text and broken JSON count 0 (negative control)', () => {
		expect(scanWebLog(`${access}\nCaddy serving on :8080\n{"msg": broken lookup server i/o timeout\n\n`)).toEqual({ oldSignature: 0, otherDurations: [], nxdomain: 0 });
	});

	test('lines already counted (a report attachment holding a slice of the stack log) are counted once', () => {
		const other = caddyError('dial tcp: lookup server: i/o timeout', 3.0011);
		const seen = new Set<string>();
		const stackLog = `${oldLine}\n${other}\n${nxdomain}\n`;
		const attachment = `${other}\n${nxdomain}\n`;
		const total = [stackLog, attachment].map(t => scanWebLog(t, seen)).reduce((a, b) => ({ oldSignature: a.oldSignature + b.oldSignature, otherDurations: [...a.otherDurations, ...b.otherDurations], nxdomain: a.nxdomain + b.nxdomain }));
		expect(total).toEqual({ oldSignature: 2, otherDurations: [], nxdomain: 1 });
		// Without the shared set, the slice counts again (the double count this guards against).
		expect(scanWebLog(attachment).oldSignature).toBe(1);
	});

	test('a timeout line without a duration is listed as null', () => {
		const text = JSON.stringify({ level: 'error', msg: 'dial tcp: lookup server: i/o timeout' });
		expect(scanWebLog(text)).toEqual({ oldSignature: 0, otherDurations: [null], nxdomain: 0 });
	});

	test('only the msg field counts: a request URI that happens to contain the words does not', () => {
		const text = JSON.stringify({ level: 'info', msg: 'handled request', request: { uri: '/x?lookup server i/o timeout' }, duration: 3 });
		expect(scanWebLog(text).oldSignature).toBe(0);
	});

	const failed = '# exit 0\nSynchronisation target:  (9)\nStarting synchronisation...\nCompleted: 24/10/2026 08:18 (39s) Last error: Error: Error 502 Bad Gateway: \nDownloading resources...\n';
	const clean = '# exit 0\nSynchronisation target:  (9)\nStarting synchronisation...\nCreated remote items: 2. Fetched items: 2/2. Completed: 16/10/2026 10:03 (433ms)\nEncryption is: Enabled\n';

	test('finds Last error in a failed seed sync', () => {
		expect(deviceHasLastError(failed)).toBe(true);
	});

	test('a clean device log has none (negative control)', () => {
		expect(deviceHasLastError(clean)).toBe(false);
	});

	test('the runner is taken from the test-results-e2e-<runner> folder', () => {
		expect(runnerOf('/x/extracted/test-results-e2e-ubuntu-24.04-arm/test-results/e2e/stack/a_web_1.log')).toBe('ubuntu-24.04-arm');
		expect(runnerOf('/x/extracted/test-results-e2e-ubuntu-24.04/test-results/e2e/stack/a_web_1.log')).toBe('ubuntu-24.04');
		expect(runnerOf('/x/elsewhere/a_web_1.log')).toBe('unknown');
	});

	test('the scan reads *_web_1.log, web*.log and device-*.log only', () => {
		expect(logKindOf('/s/nst-e2e-abc_web_1.log')).toBe('web');
		expect(logKindOf('/s/web.log')).toBe('web');
		expect(logKindOf('/s/web-log-06f1f9e1.log')).toBe('web');
		expect(logKindOf('/s/device-7825a393.log')).toBe('device');
		expect(logKindOf('/s/build-web.log')).toBeUndefined();
		expect(logKindOf('/s/nst-e2e-abc_headless_1.log')).toBeUndefined();
		expect(logKindOf('/s/manifest.webmanifest')).toBeUndefined();
	});
});
