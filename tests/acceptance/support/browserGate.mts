// Static checks for the browser gate and the browser install's apt resilience (docs/test-plans/CI-e2e-browser-gate.md).
// Pure functions over a parsed workflow job, so the acceptance test can prove each rule on small inline workflows
// (positive and negative controls) before applying it to .github/workflows/e2e.yml.
import { parse } from 'yaml';

export interface GateStep {
	index: number;
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	continueOnError: boolean;
}

export interface GateJob {
	id: string;
	steps: GateStep[];
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

export const jobsOf = (yamlText: string): GateJob[] => {
	const doc = parse(yamlText) as Dict;
	return Object.entries(isDict(doc.jobs) ? doc.jobs : {}).filter(([, j]) => isDict(j)).map(([id, j]) => ({
		id,
		steps: (Array.isArray((j as Dict).steps) ? (j as Dict).steps as unknown[] : []).filter(isDict).map((s, index) => ({
			index,
			id: str(s.id),
			name: str(s.name),
			uses: str(s.uses),
			run: str(s.run),
			if: str(s.if),
			continueOnError: s['continue-on-error'] === true || s['continue-on-error'] === 'true',
		})),
	}));
};

export const label = (job: GateJob, step: GateStep): string => `${job.id} step ${step.index + 1} (${step.id ?? step.name ?? '?'})`;

// Steps that need Playwright's browser: the E2E layer, and the contract layer (its harness self-tests run inner
// Playwright runs against Chromium; run 39568721933 x64: 18 failures "Executable doesn't exist" without it).
export const needsBrowser = (s: GateStep): boolean => /\bplaywright\s+test\b|\btest:contract\b|jest\.contract\.config/.test(s.run ?? '');
export const isBrowserInstall = (s: GateStep): boolean => /\bplaywright\s+install\b/.test(s.run ?? '');

// The top-level `&&` terms of a step condition, or undefined when the condition has a top-level `||` (then no single
// term is required). `${{ }}` is stripped; parentheses and quoted strings are respected.
export const topLevelConjuncts = (condition: string): string[] | undefined => {
	const expr = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
	const terms: string[] = [];
	let depth = 0;
	let quote = false;
	let start = 0;
	for (let i = 0; i < expr.length; i++) {
		const c = expr[i];
		if (c === "'") quote = !quote;
		if (quote) continue;
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (depth === 0 && (expr.startsWith('&&', i) || expr.startsWith('||', i))) {
			if (expr.startsWith('||', i)) return undefined;
			terms.push(expr.slice(start, i).trim());
			start = i + 2;
			i++;
		}
	}
	terms.push(expr.slice(start).trim());
	return terms.map(t => t.replace(/^\((.*)\)$/s, '$1').trim());
};

// A step is gated on the browser step when it cannot run unless that step succeeded: no condition (implicit
// success()), a top-level success(), or a top-level `steps.<id>.outcome == 'success'`.
export const gatedOn = (s: GateStep, browserId: string): boolean => {
	if (s.if === undefined) return true;
	const terms = topLevelConjuncts(s.if);
	if (!terms) return false;
	const outcome = new RegExp(`^steps\\.${browserId.replace(/[-]/g, '\\-')}\\.outcome\\s*==\\s*'success'$`);
	return terms.some(t => t === 'success()' || outcome.test(t));
};

// CI-BG gate rule: every browser-needing step runs only after the browser install succeeded.
export const gateFindings = (jobs: GateJob[]): string[] => jobs.flatMap(job => {
	const users = job.steps.filter(needsBrowser);
	if (users.length === 0) return [];
	const installs = job.steps.filter(isBrowserInstall);
	if (installs.length !== 1) return [`${job.id}: expected exactly one \`playwright install\` step before the browser-needing steps, found ${installs.length}`];
	const install = installs[0];
	const out: string[] = [];
	if (!install.id) out.push(`${label(job, install)}: the browser install needs an id, so later steps can require its outcome`);
	if (install.continueOnError) out.push(`${label(job, install)}: continue-on-error on the browser install makes success() true after a failed install`);
	for (const s of users) {
		if (s.index < install.index) out.push(`${label(job, s)} runs before the browser install`);
		else if (!install.id || !gatedOn(s, install.id)) out.push(`${label(job, s)} needs Playwright's browser but its if: does not require steps.${install.id ?? '<id>'}.outcome == 'success' (if: ${s.if ?? '(none)'})`);
	}
	return out;
});

// apt use: Playwright's `--with-deps` / `install-deps` run apt-get update over every configured source.
export const usesApt = (s: GateStep): boolean => /--with-deps\b|\binstall-deps\b|\bapt(-get)?\s+(update|install)\b/.test(s.run ?? '');

// A step that takes third-party apt sources out of apt's way: it edits, moves or removes entries under
// /etc/apt/sources.list.d (or sources.list), or points apt at a restricted source list (Dir::Etc::sourcelist/
// sourceparts). Retrying is not enough: a 403 / "no longer signed" source fails every attempt.
export const neutralisesSources = (s: GateStep): boolean => {
	const run = s.run ?? '';
	const editsLists = /\/etc\/apt\/sources\.list(\.d)?\b/.test(run) && /\b(rm|mv|sed|tee|cp|truncate|find)\b|Enabled:\s*no|>\s*\/etc\/apt/.test(run);
	return editsLists || /Dir::Etc::source(list|parts)/.test(run);
};

// A step runs whenever the browser install runs: it is the install itself, or an earlier step whose condition is
// absent, always() or !cancelled() (it cannot be skipped while the install runs), and it does not hide its failure.
const runsWheneverInstallRuns = (s: GateStep, install: GateStep): boolean => {
	if (s.index === install.index) return true;
	if (s.index > install.index || s.continueOnError) return false;
	if (s.if === undefined) return install.if === undefined;
	const terms = topLevelConjuncts(s.if);
	return !!terms && terms.every(t => t === 'always()' || t === '!cancelled()');
};

// CI-AR apt rule: when the browser install (or a step before it) uses apt, a step that always runs before it or the
// install itself neutralises third-party sources, and the install never masks its own failure.
export const aptFindings = (jobs: GateJob[]): string[] => jobs.flatMap(job => {
	const install = job.steps.find(isBrowserInstall);
	if (!install || !job.steps.some(needsBrowser)) return [];
	const out: string[] = [];
	if (install.continueOnError || /\|\|\s*(true|:)\b/.test(install.run ?? '')) out.push(`${label(job, install)}: the browser install must fail visibly (no continue-on-error, no \`|| true\`)`);
	const aptBefore = job.steps.filter(s => s.index <= install.index && usesApt(s));
	if (aptBefore.length === 0) return out;
	const guard = job.steps.find(s => neutralisesSources(s) && runsWheneverInstallRuns(s, install));
	if (!guard) out.push(`${label(job, install)}: uses apt (${aptBefore.map(s => label(job, s)).join(', ')}) but no step at or before it, run whenever it runs, takes third-party apt sources out of the way; a broken preinstalled source (run 39568721933: packages.microsoft.com 403 "no longer signed") then fails the install`);
	return out;
});
