// Image probe for the M1-S5 contract suite (docs/test-plans/M1-S5.md, M1-AC23). It runs INSIDE an image under test
// with the entrypoint replaced (`podman run --rm --entrypoint node … <image> /opt/notestead-test/image-probe.mjs`), so
// nothing of the supervisor starts. It reports, as one line `RESULT <json>`:
//   arch: process.arch;
//   packages: every installed package (a node_modules/<name> or node_modules/@scope/<name> directory with a
//     package.json; symlinks are not followed): {dir, name, version, bundles (declares bundled dependencies)};
//   nodeFiles: every *.node file; markers: every file named `notestead-postinstall-ran`;
//   joplin: for each installed `joplin` package: sqlite3 required from that package (resolved dir, version, binding
//     path, ELF machine, `select sqlite_version()`), and `<bin> --profile <tmp> version` output.
import { spawnSync } from 'node:child_process';
import { lstatSync, openSync, readdirSync, readFileSync, readSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

const skipRoots = new Set(['/proc', '/sys', '/dev', '/run', '/tmp', '/opt/notestead-test']);
const packages = [];
const nodeFiles = [];
const markers = [];

const readManifest = dir => {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
};

const walk = dir => {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
		if (skipRoots.has(path)) continue;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			const parent = basename(dir);
			const grand = basename(dirname(dir));
			const isPackageDir = (parent === 'node_modules' && !entry.name.startsWith('@') && !entry.name.startsWith('.'))
				|| (grand === 'node_modules' && parent.startsWith('@'));
			if (isPackageDir) {
				const manifest = readManifest(path);
				if (manifest && typeof manifest.name === 'string') {
					const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
					packages.push({
						dir: path,
						name: manifest.name,
						version: manifest.version,
						bundles: Array.isArray(bundled) ? bundled.length > 0 : bundled === true,
					});
				}
			}
			walk(path);
		} else if (entry.isFile()) {
			if (entry.name.endsWith('.node')) nodeFiles.push(path);
			if (entry.name === 'notestead-postinstall-ran') markers.push(path);
		}
	}
};

const elfMachine = file => {
	const fd = openSync(file, 'r');
	try {
		const header = Buffer.alloc(20);
		readSync(fd, header, 0, 20, 0);
		if (header.readUInt32BE(0) !== 0x7f454c46) return 'not-elf';
		return { 183: 'aarch64', 62: 'x86_64' }[header.readUInt16LE(18)] ?? `e_machine ${header.readUInt16LE(18)}`;
	} finally {
		closeSync(fd);
	}
};

const probeJoplin = async dir => {
	const result = { dir };
	const manifest = readManifest(dir);
	const req = createRequire(join(dir, 'package.json'));
	try {
		const sqliteDir = dirname(req.resolve('sqlite3/package.json'));
		result.sqlite3 = { dir: sqliteDir, version: readManifest(sqliteDir)?.version };
		const sqlite3 = req('sqlite3');
		const sqliteReq = createRequire(join(sqliteDir, 'package.json'));
		try {
			result.sqlite3.binding = sqliteReq('@mapbox/node-pre-gyp').find(join(sqliteDir, 'package.json'));
			result.sqlite3.bindingMachine = elfMachine(result.sqlite3.binding);
		} catch (error) {
			result.sqlite3.bindingError = String(error);
		}
		result.sqlite3.query = await new Promise(resolve => {
			const db = new sqlite3.Database(':memory:');
			db.get('select sqlite_version() as v', (error, row) => {
				db.close();
				resolve(error ? { error: String(error) } : { version: row.v });
			});
		});
	} catch (error) {
		result.sqlite3 = { ...(result.sqlite3 ?? {}), error: String(error) };
	}
	const bin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.joplin;
	if (bin) {
		const run = spawnSync(process.execPath, [join(dir, bin), '--profile', `/tmp/nst-probe-profile-${process.pid}`, 'version'], { encoding: 'utf8', timeout: 120_000 });
		result.version = { code: run.status, stdout: run.stdout, stderr: (run.stderr ?? '').slice(-2000) };
	} else {
		result.version = { error: 'no bin in package.json' };
	}
	return result;
};

walk('/');
const joplin = [];
for (const p of packages.filter(p => p.name === 'joplin')) joplin.push(await probeJoplin(p.dir));
let ownStat = null;
try {
	ownStat = lstatSync('/data').mode.toString(8);
} catch {
	ownStat = null;
}
process.stdout.write(`RESULT ${JSON.stringify({ arch: process.arch, uid: process.getuid(), dataMode: ownStat, packages, nodeFiles, markers, joplin })}\n`);
