// A stand-in for the Joplin CLI in the supervisor's unit tests: `node fake-joplin.mjs --profile <dir> <command…>`.
// It records every call in <dir>/calls.jsonl and is steered by <dir>/control.json (the CLI runner passes only an
// allow-listed environment, so the control can't travel in env):
//   { "sync": { "code": 0, "lines": ["Completed: …"] }, "decrypt": { "code": 0 }, "server": "serve" | "exit",
//     "importLines": ["…"] }
import { appendFileSync, existsSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
const command = args.filter((a, i) => i !== args.indexOf('--profile') && i !== args.indexOf('--profile') + 1);
const control = existsSync(join(profile, 'control.json')) ? JSON.parse(readFileSync(join(profile, 'control.json'), 'utf8')) : {};
const record = extra => appendFileSync(join(profile, 'calls.jsonl'), `${JSON.stringify({ command, env: Object.keys(process.env).sort(), ...extra })}\n`);
const print = lines => {
	for (const line of lines ?? []) process.stdout.write(`${line}\n`);
};

const readStdin = () => new Promise(resolve => {
	const chunks = [];
	process.stdin.on('data', chunk => chunks.push(chunk));
	process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const main = async () => {
	const name = command.filter(a => !a.startsWith('-')).join(' ');
	if (name === 'config' && command.includes('--import')) {
		const st = fstatSync(0);
		const stdin = st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : st.isFile() ? 'file' : 'other';
		const text = await readStdin();
		writeFileSync(join(profile, 'imported.json'), text);
		record({ stdin });
		print(control.importLines);
		return 0;
	}
	if (name === 'sync') {
		record({});
		print(control.sync?.lines ?? ['Synchronisation target: Joplin Server (9)', 'Starting synchronisation...', 'Completed: 05/10/2026 18:15 (6s)']);
		return control.sync?.code ?? 0;
	}
	if (name === 'e2ee decrypt') {
		record({});
		return control.decrypt?.code ?? 0;
	}
	if (name === 'server start') {
		record({});
		if (control.server === 'exit') return 3;
		const settings = JSON.parse(readFileSync(join(profile, 'imported.json'), 'utf8'));
		appendFileSync(join(profile, 'log-clipper.txt'), `Request: GET /ping?token=${settings['api.token']}\n`);
		const server = createServer((req, res) => {
			res.end(req.url === '/ping' ? 'JoplinClipperServer' : '{}');
		});
		server.listen(settings['api.port'], '127.0.0.1');
		process.on('SIGTERM', () => server.close(() => process.exit(0)));
		return new Promise(() => {});
	}
	record({});
	return 0;
};

main().then(code => {
	process.exitCode = code;
});
