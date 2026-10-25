// DNS-1 fault injection and timing helpers (docs/test-plans/DNS-1.md §Fault injection, WO-1).
// - F-SINK: a UDP "nameserver" container that never answers, at a fixed address `<prefix>.53`.
// - `resolv.conf` variants derived from podman's own file for a container on the suite network (never hand-written).
// - Timed requests and `timings.json` (evidence per case).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from './http.ts';
import type { HttpRequest, HttpResponse } from './http.ts';
import {
	containerLogs, ipOf, nodeImage, podman, repoRoot, runId, runLabel, startContainer, testLabel, waitFor, webImageInfo,
} from './podman.ts';
import type { Stack } from './podman.ts';

export const sinkHost = 53;
export const sinkFixture = join(repoRoot, 'tests', 'fixtures', 'dns-1', 'udp-sink.mjs');

export interface Sink {
	name: string;
	ip: string;
}

export const startSink = async (stack: Stack): Promise<Sink> => {
	const name = startContainer(stack, {
		role: 'sink',
		host: sinkHost,
		image: nodeImage,
		volumes: [`${sinkFixture}:/fixture/udp-sink.mjs:ro,Z`],
		command: ['node', '/fixture/udp-sink.mjs'],
	});
	await waitFor(`${name} ready`, async () => (containerLogs(name).split('\n').some(l => l.trim() === 'ready') ? true : undefined), { timeoutMs: 60_000 });
	return { name, ip: ipOf(stack, sinkHost) };
};

// The number of datagrams the sink has received so far.
export const sinkQueries = (name: string): number => containerLogs(name).split('\n').filter(l => /^query \d+ /.test(l)).length;

// podman's own resolv.conf for a container on the suite network, read from a throwaway probe container.
export const baseResolvConf = (stack: Stack): string => {
	const r = podman(['run', '--rm', '--name', `nst-${stack.suite}-resolvprobe-${runId()}`, '--network', stack.net,
		'--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, nodeImage, 'cat', '/etc/resolv.conf']);
	mkdirSync(stack.logsDir, { recursive: true });
	writeFileSync(join(stack.logsDir, 'resolv.base'), r.stdout);
	return r.stdout;
};

export interface ResolvVariants {
	sinkFirst: string;
	sinkOnly: string;
}

const nameserver = /^[ \t]*nameserver[ \t]+\S+[ \t]*$/;

// `sink-first`: the sink's line before the first `nameserver` line. `sink-only`: the sink as the only nameserver, every
// other line kept.
export const writeResolvVariants = (stack: Stack, base: string, sinkIp: string): ResolvVariants => {
	const lines = base.split('\n');
	const first = lines.findIndex(l => nameserver.test(l));
	if (first < 0) throw new Error(`the base resolv.conf has no nameserver line:\n${base}`);
	const sinkLine = `nameserver ${sinkIp}`;
	const sinkFirst = [...lines.slice(0, first), sinkLine, ...lines.slice(first)].join('\n');
	const sinkOnly = [...lines.slice(0, first), sinkLine, ...lines.slice(first).filter(l => !nameserver.test(l))].join('\n');
	const files = { sinkFirst: join(stack.logsDir, 'resolv.sink-first'), sinkOnly: join(stack.logsDir, 'resolv.sink-only') };
	writeFileSync(files.sinkFirst, sinkFirst);
	writeFileSync(files.sinkOnly, sinkOnly);
	return files;
};

export interface Timed {
	res: HttpResponse;
	elapsedMs: number;
}

export const timedRequest = async (req: HttpRequest): Promise<Timed> => {
	const started = performance.now();
	const res = await request(req);
	return { res, elapsedMs: performance.now() - started };
};

// The image's own Caddyfile minus every `transport http { … }` block that sets `dial_timeout` (one rule removed,
// nothing else changed). `removedBlocks` is 0 while the shipped file has no such block.
export const noDialTimeoutCaddyfile = (stack: Stack): { file: string; removedBlocks: number } => {
	const probe = `nst-${stack.suite}-caddyfile-${runId()}-${process.pid}`;
	const original = join(stack.logsDir, 'Caddyfile.image');
	podman(['create', '--name', probe, '--label', `${testLabel}=contract`, '--label', `${runLabel}=${runId()}`, webImageInfo().image]);
	try {
		podman(['cp', `${probe}:/etc/caddy/Caddyfile`, original]);
	} finally {
		podman(['rm', '-f', probe], { allowFail: true });
	}
	let text = readFileSync(original, 'utf8');
	let removedBlocks = 0;
	const start = /^[ \t]*transport[ \t]+http[ \t]*\{/gm;
	for (;;) {
		start.lastIndex = 0;
		let removed = false;
		for (let m = start.exec(text); m; m = start.exec(text)) {
			let depth = 1;
			let end = m.index + m[0].length;
			for (; end < text.length && depth > 0; end++) {
				if (text[end] === '{') depth++;
				else if (text[end] === '}') depth--;
			}
			const block = text.slice(m.index, end);
			if (!/\bdial_timeout\b/.test(block)) continue;
			const rest = /^[ \t]*\r?\n/.exec(text.slice(end));
			text = text.slice(0, m.index) + text.slice(end + (rest ? rest[0].length : 0));
			removedBlocks++;
			removed = true;
			break;
		}
		if (!removed) break;
	}
	const file = join(stack.logsDir, 'Caddyfile.no-dial-timeout');
	writeFileSync(file, text);
	return { file, removedBlocks };
};

export interface TimingRecord {
	case: string;
	status?: number;
	elapsedMs?: number;
	sinkQueriesDelta?: number;
	removedBlocks?: number;
	extraKeys?: string[];
	listing?: string;
	note?: string;
}

// Appends a record to test-results/contract/dns-1/<suite>/timings.json (a JSON array, rewritten on each call).
export const recordTiming = (stack: Stack, record: TimingRecord): void => {
	const file = join(stack.logsDir, 'timings.json');
	let all: TimingRecord[] = [];
	try {
		all = JSON.parse(readFileSync(file, 'utf8')) as TimingRecord[];
	} catch {
		all = [];
	}
	all.push({ ...record, elapsedMs: record.elapsedMs === undefined ? undefined : Math.round(record.elapsedMs) });
	writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
};

