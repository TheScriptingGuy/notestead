import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, CliRunner } from './cliRunner.ts';
import { Redactor } from './redact.ts';

const fakeCli = join(__dirname, 'testing', 'fake-joplin.mjs');

describe('CliRunner', () => {
	let profile: string;
	let logged: string[];
	let runner: CliRunner;

	beforeEach(() => {
		profile = mkdtempSync(join(tmpdir(), 'headless-cli-'));
		logged = [];
		runner = new CliRunner({
			nodePath: process.execPath,
			binPath: fakeCli,
			profileDir: profile,
			redactor: new Redactor(['s3cret Δ']),
			log: line => logged.push(line),
			env: { PATH: process.env.PATH, HOME: '/tmp', JOPLIN_SERVER_URL: 'http://web:8089', UNRELATED_SECRET: 'x' },
		});
	});

	afterEach(() => {
		rmSync(profile, { recursive: true, force: true });
	});

	const calls = (): { command: string[]; env: string[]; stdin?: string }[] => readFileSync(join(profile, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

	test('runs `<bin> --profile <dir> <command>` and passes input on a stdin pipe, not in argv', async () => {
		expect(runner.argv(['sync'])).toEqual([fakeCli, '--profile', profile, 'sync']);
		const input = JSON.stringify({ 'sync.9.password': 's3cret Δ' });
		const exit = await runner.run(['config', '--import'], input);
		expect(exit).toEqual({ code: 0, signal: null, output: [] });
		expect(readFileSync(join(profile, 'imported.json'), 'utf8')).toBe(input);
		expect(calls()).toEqual([{ command: ['config', '--import'], env: ['HOME', 'PATH'], stdin: expect.stringMatching(/^(fifo|socket)$/) }]);
	});

	test('relays redacted output lines with the command as label and returns them', async () => {
		writeFileSync(join(profile, 'control.json'), JSON.stringify({ sync: { code: 0, lines: ['GET /notes?token=abc', 'password s3cret Δ', 'Completed: now (1s)'] } }));
		const exit = await runner.run(['sync']);
		expect(exit.output).toEqual(['GET /notes?[redacted]', 'password [redacted]', 'Completed: now (1s)']);
		expect(logged).toEqual(['[joplin sync] GET /notes?[redacted]', '[joplin sync] password [redacted]', '[joplin sync] Completed: now (1s)']);
	});

	test('reports the exit code', async () => {
		writeFileSync(join(profile, 'control.json'), JSON.stringify({ decrypt: { code: 1 } }));
		expect((await runner.run(['e2ee', 'decrypt', '--force'])).code).toBe(1);
	});

	test('stop() ends a long-running child with SIGTERM', async () => {
		writeFileSync(join(profile, 'imported.json'), JSON.stringify({ 'api.port': 0, 'api.token': 't' }));
		const server = runner.start(['server', 'start', '--quiet']);
		expect(server.isRunning()).toBe(true);
		const exit = await server.stop(10_000);
		expect(server.isRunning()).toBe(false);
		expect(exit.signal === 'SIGTERM' || exit.code === 0).toBe(true);
	});

	test('stop() escalates to SIGKILL when SIGTERM is ignored', async () => {
		writeFileSync(join(profile, 'ignore-term.cjs'), "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000);\n");
		let up: () => void = () => {};
		const isUp = new Promise<void>(resolve => {
			up = resolve;
		});
		const ignoring = new CliRunner({ nodePath: process.execPath, binPath: join(profile, 'ignore-term.cjs'), profileDir: profile, redactor: new Redactor(), log: line => line.endsWith(' up') && up() });
		const proc = ignoring.start([]);
		await isUp; // its SIGTERM handler is installed
		const exit = await proc.stop(200);
		expect(exit.signal).toBe('SIGKILL');
	});

	test('a spawn failure is reported, not thrown', async () => {
		const broken = new CliRunner({ nodePath: join(profile, 'no-such-node'), binPath: fakeCli, profileDir: profile, redactor: new Redactor(), log: () => {} });
		const exit = await broken.run(['version']);
		expect(exit.code).toBeNull();
		expect(exit.error).toMatch(/ENOENT/);
	});

	test('childEnv keeps only the allow-listed variables', () => {
		expect(childEnv({ PATH: '/bin', HOME: '/h', TZ: 'UTC', JOPLIN_USERNAME: 'u', SOMETHING: 'x' })).toEqual({ PATH: '/bin', HOME: '/h', TZ: 'UTC' });
	});
});
