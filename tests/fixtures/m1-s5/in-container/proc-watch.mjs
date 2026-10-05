// Process watcher for the M1-S5 contract suite (docs/test-plans/M1-S5.md, M1-AC14/AC15). It runs INSIDE the headless
// container under test (`podman exec -i <c> node /opt/notestead-test/proc-watch.mjs`, this directory mounted
// read-only), so it sees the container's PID namespace.
// stdin line 1: {"needles":[{"label","value"}],"readyFile":"/tmp/.nst-watch-ready","intervalMs":10}. The needles come
// on stdin, never argv or env, so the watcher cannot find its own copy. The watcher then samples /proc until stdin is
// closed and prints one line `REPORT <json>`:
//   processes: every process seen (pid, starttime, argv with needle values and token= redacted, firstSeen, lastSeen,
//     fd0 for processes that carry `--import`), hits: [{label, pid, where: 'cmdline'|'environ'}] (labels only, never
//     values), unreadable: [{pid, file, argv}] for processes whose cmdline/environ no sample could read (EACCES/EPERM).
// It writes readyFile after its first complete sample (the test's start gate waits for it) and prints `WATCHING`;
// while running it prints `GONE <json>` (pid, argv, firstSeen, lastSeen) for every process that ends.
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

let stopped = false;
const lines = createInterface({ input: process.stdin });
const firstLine = new Promise(resolve => lines.once('line', resolve));
lines.on('close', () => {
	stopped = true;
});
const config = JSON.parse(await firstLine);
const needles = config.needles.map(n => ({ label: n.label, value: n.value, bytes: Buffer.from(n.value, 'utf8') }));

const redact = text => {
	let out = text;
	for (const n of needles) out = out.split(n.value).join(`[${n.label}]`);
	return out.replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]');
};

const processes = new Map();
const hits = [];
const hitKeys = new Set();
let samples = 0;

// null when the file is gone; 'denied' on EACCES/EPERM (also transient: during an exec the target is briefly not
// dumpable, so a process counts as unreadable only if no sample of its lifetime could read the file).
const readProc = (pid, file) => {
	try {
		return readFileSync(`/proc/${pid}/${file}`);
	} catch (error) {
		return error.code === 'EACCES' || error.code === 'EPERM' ? 'denied' : null;
	}
};

const sample = () => {
	const now = Date.now();
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid) continue;
		const stat = readProc(pid, 'stat');
		if (!stat || stat === 'denied') continue;
		const statText = stat.toString('utf8');
		const fields = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
		const state = fields[0];
		const starttime = fields[19];
		const key = `${pid}:${starttime}`;
		const cmdline = readProc(pid, 'cmdline');
		const environ = readProc(pid, 'environ');
		for (const [where, buffer] of [['cmdline', cmdline], ['environ', environ]]) {
			if (!buffer || buffer === 'denied') continue;
			for (const n of needles) {
				if (buffer.indexOf(n.bytes) < 0) continue;
				const hitKey = `${n.label}/${key}/${where}`;
				if (hitKeys.has(hitKey)) continue;
				hitKeys.add(hitKey);
				hits.push({ label: n.label, pid, where });
			}
		}
		let record = processes.get(key);
		if (!record) {
			record = { pid, starttime, argv: [], firstSeen: now, lastSeen: now, states: [], read: { cmdline: false, environ: false }, denied: { cmdline: false, environ: false } };
			processes.set(key, record);
		}
		if (cmdline && cmdline !== 'denied') {
			const argv = cmdline.toString('utf8').split('\0').filter((a, i, all) => i < all.length - 1 || a !== '').map(redact);
			// keep the latest argv: a process that exec()s (sh → the supervisor) shows its final command
			if (argv.length > 0) record.argv = argv;
			if (argv.includes('--import') && record.fd0 === undefined) {
				try {
					record.fd0 = readlinkSync(`/proc/${pid}/fd/0`);
				} catch (error) {
					record.fd0 = `unreadable: ${error.code}`;
				}
			}
		}
		for (const [file, value] of [['cmdline', cmdline], ['environ', environ]]) {
			if (value === 'denied') record.denied[file] = true;
			else if (value) record.read[file] = true;
		}
		record.lastSeen = now;
		if (!record.states.includes(state)) record.states.push(state);
	}
	// Live events: a process seen before but not in this sample has ended.
	for (const record of processes.values()) {
		if (record.lastSeen === now || record.gone !== undefined) continue;
		record.gone = now;
		process.stdout.write(`GONE ${JSON.stringify({ pid: record.pid, argv: record.argv, firstSeen: record.firstSeen, lastSeen: record.lastSeen })}\n`);
	}
	samples++;
};

sample();
writeFileSync(config.readyFile, 'ready\n');
process.stdout.write('WATCHING\n');
const started = Date.now();
while (!stopped) {
	sample();
	await new Promise(resolve => setTimeout(resolve, config.intervalMs ?? 10));
}
sample();
const all = [...processes.values()];
const unreadable = all.flatMap(p => ['cmdline', 'environ'].filter(f => p.denied[f] && !p.read[f]).map(file => ({ pid: p.pid, file, argv: p.argv })));
const report = { samples, durationMs: Date.now() - started, processes: all, hits, unreadable };
process.stdout.write(`REPORT ${JSON.stringify(report)}\n`);
