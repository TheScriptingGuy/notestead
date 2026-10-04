// Entry point for the `web-build` workspace scripts `overlay`, `verify`, `package` and `build`
// (`corepack yarn workspace web-build <command> …`). Run by Node's built-in type stripping (no build step).
import { findRepoRoot } from '../src/repoRoot.ts';
import { runWebBuild } from '../src/webBuild.ts';

process.exitCode = await runWebBuild(process.argv.slice(2), {
	repoRoot: findRepoRoot(import.meta.dirname),
	out: {
		info: line => process.stdout.write(`${line}\n`),
		error: line => process.stderr.write(`${line}\n`),
	},
});
