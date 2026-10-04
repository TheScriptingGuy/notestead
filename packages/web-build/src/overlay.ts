// Applies the declarative branding overlay (packages/web-build/overlay.json, ADR-0010) to a built upstream `dist/`
// in place. It edits static files only; webpack outputs are never touched.
//
// Two phases: every rule is first checked and its result computed in memory (all problems are reported together,
// each naming its path), and only then is the bundle changed. Every action except "generate" requires its target
// to exist, so an upstream rename fails the build instead of silently shipping upstream branding (M1-AC6).
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { insertBefore, localRefs, setMeta, setTitle } from './html.ts';
import type { MetaEdit } from './html.ts';
import { listFiles, requireDirectory } from './tree.ts';

export const overlayActions = ['replace', 'replaceDir', 'remove', 'editJson', 'editHtml', 'generate'] as const;
export type OverlayAction = typeof overlayActions[number];

export interface OverlayRule {
	// Bundle path (POSIX, relative to the dist root).
	path: string;
	action: OverlayAction;
	// replace, replaceDir, generate: a file or directory relative to the overlay base directory (packages/web-build).
	source?: string;
	// generate: the name of a built-in template (instead of `source`).
	template?: string;
	// editJson: top-level keys to set and to delete.
	set?: Record<string, unknown>;
	delete?: string[];
	// editHtml: the new <title>, <meta> elements to set, and lines to add before </head> and before </body>.
	title?: string;
	meta?: MetaEdit[];
	head?: string[];
	body?: string[];
}

export interface OverlayConfig {
	rules: OverlayRule[];
}

export interface OverlayContext {
	// Directory that rule `source` paths are relative to.
	baseDir: string;
	// Built-in generators for `generate` rules with a `template`; each gets the dist directory before any change.
	templates: Record<string, (dist: string) => string>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');

const normalizePath = (path: string): string => path.replace(/^\.\//, '').replace(/\/+$/, '');

// A relative POSIX path that stays inside its root.
export const isContainedPath = (path: string): boolean =>
	path !== '' && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(s => s !== '' && s !== '.' && s !== '..');

// Validates overlay.json data. Throws one error listing every problem.
export const parseOverlayConfig = (data: unknown, label = 'overlay.json'): OverlayConfig => {
	if (!isObject(data) || !Array.isArray(data.rules) || data.rules.length === 0) {
		throw new Error(`${label}: must be an object with a non-empty "rules" array`);
	}
	const problems: string[] = [];
	const seen = new Set<string>();
	const rules = data.rules.map((raw: unknown, index: number): OverlayRule => {
		const at = `${label} rules[${index}]`;
		if (!isObject(raw)) {
			problems.push(`${at}: must be an object`);
			return raw as OverlayRule;
		}
		const rule = { ...raw } as unknown as OverlayRule;
		if (typeof raw.path !== 'string' || !isContainedPath(normalizePath(raw.path))) {
			problems.push(`${at}.path: must be a relative path inside the bundle, got ${JSON.stringify(raw.path)}`);
		} else {
			rule.path = normalizePath(raw.path);
			if (seen.has(rule.path)) problems.push(`${at}.path: ${rule.path} has more than one rule`);
			seen.add(rule.path);
		}
		if (!overlayActions.includes(raw.action as OverlayAction)) {
			problems.push(`${at}.action: must be one of ${overlayActions.join(', ')}, got ${JSON.stringify(raw.action)}`);
		}
		const needsSource = raw.action === 'replace' || raw.action === 'replaceDir' || (raw.action === 'generate' && raw.template === undefined);
		if (needsSource && (typeof raw.source !== 'string' || !isContainedPath(raw.source))) {
			problems.push(`${at}.source: must be a relative path inside the overlay directory, got ${JSON.stringify(raw.source)}`);
		}
		if (raw.action === 'generate' && raw.template !== undefined && (typeof raw.template !== 'string' || raw.source !== undefined)) {
			problems.push(`${at}: a generate rule has either a "source" or a "template" string, not both`);
		}
		if (raw.action === 'editJson') {
			if (raw.set !== undefined && !isObject(raw.set)) problems.push(`${at}.set: must be an object`);
			if (raw.delete !== undefined && !isStringArray(raw.delete)) problems.push(`${at}.delete: must be an array of strings`);
			if (raw.set === undefined && raw.delete === undefined) problems.push(`${at}: editJson needs "set" or "delete"`);
		}
		if (raw.action === 'editHtml') {
			if (raw.title !== undefined && typeof raw.title !== 'string') problems.push(`${at}.title: must be a string`);
			for (const key of ['head', 'body']) {
				if (raw[key] !== undefined && !isStringArray(raw[key])) problems.push(`${at}.${key}: must be an array of strings`);
			}
			const metaOk = (m: unknown): boolean => isObject(m) && typeof m.content === 'string'
				&& (typeof m.name === 'string') !== (typeof m.property === 'string');
			if (raw.meta !== undefined && !(Array.isArray(raw.meta) && raw.meta.every(metaOk))) {
				problems.push(`${at}.meta: must be an array of { "name" or "property", "content" } strings`);
			}
			if (raw.title === undefined && raw.meta === undefined && raw.head === undefined && raw.body === undefined) {
				problems.push(`${at}: editHtml needs at least one of title, meta, head, body`);
			}
		}
		return rule;
	});
	if (problems.length > 0) throw new Error(problems.join('\n'));
	return { rules };
};

export const loadOverlayConfig = (path: string): OverlayConfig => {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`${path}: cannot read the overlay configuration (${(error as Error).message})`);
	}
	return parseOverlayConfig(data, path);
};

interface Step {
	description: string;
	apply: () => void;
}

const isFile = (path: string): boolean => statSync(path).isFile();
const isDirectory = (path: string): boolean => statSync(path).isDirectory();

const indentOf = (html: string, tag: string): string => {
	// The indentation of the line holding `tag`, plus one tab: new children line up with upstream's.
	const match = new RegExp(`^([ \\t]*)${tag.replace('/', '\\/')}`, 'mi').exec(html);
	return `${match ? match[1] : ''}\t`;
};

const editHtml = (html: string, rule: OverlayRule): string => {
	let result = html;
	if (rule.title !== undefined) result = setTitle(result, rule.title);
	for (const meta of rule.meta ?? []) result = setMeta(result, meta, indentOf(result, '</head>'));
	if (rule.head?.length) result = insertBefore(result, '</head>', rule.head, indentOf(result, '</head>'));
	if (rule.body?.length) result = insertBefore(result, '</body>', rule.body, indentOf(result, '</body>'));
	return result;
};

const editJson = (text: string, rule: OverlayRule): string => {
	const data: unknown = JSON.parse(text);
	if (!isObject(data)) throw new Error('is not a JSON object');
	for (const key of rule.delete ?? []) delete data[key];
	Object.assign(data, rule.set ?? {});
	return `${JSON.stringify(data, null, 4)}\n`;
};

// Problems with references in the edited and generated pages, against the files the overlaid bundle will contain.
const referenceProblems = (texts: Map<string, string>, files: Set<string>): string[] => {
	const problems: string[] = [];
	const missing = (from: string, ref: string): boolean => !files.has(posix.normalize(posix.join(posix.dirname(from), ref)));
	for (const [path, text] of texts) {
		if (path.endsWith('.html')) {
			for (const ref of localRefs(text)) {
				if (missing(path, ref)) problems.push(`${path} references ./${ref}, which the overlaid bundle would not contain`);
			}
		} else if (path === 'manifest.json') {
			const icons = (JSON.parse(text) as { icons?: { src?: unknown }[] }).icons ?? [];
			for (const icon of icons) {
				if (typeof icon.src === 'string' && icon.src.startsWith('./') && missing(path, icon.src.slice(2))) {
					problems.push(`manifest.json lists the icon ${icon.src}, which the overlaid bundle would not contain`);
				}
			}
		}
	}
	return problems;
};

// Applies `config` to `dist` in place and returns a description of each change. Throws without changing anything
// when any rule cannot be applied; the message names every offending path.
export const applyOverlay = (dist: string, config: OverlayConfig, context: OverlayContext): string[] => {
	requireDirectory(dist, 'dist');
	const files = new Set(listFiles(dist));
	const texts = new Map<string, string>();
	const steps: Step[] = [];
	const problems: string[] = [];

	config.rules.forEach((rule, index) => {
		const target = join(dist, ...rule.path.split('/'));
		const source = rule.source === undefined ? '' : join(context.baseDir, ...rule.source.split('/'));
		const prefix = `${rule.path}/`;
		try {
			if (rule.action === 'generate') {
				if (existsSync(target)) throw new Error(`${rule.path} already exists in ${dist}; generate never overwrites a file`);
			} else if (!existsSync(target)) {
				throw new Error(`${rule.path} is missing from ${dist} (an upstream rename or removal?)`);
			}
			if (source !== '' && !existsSync(source)) throw new Error(`the overlay source ${source} does not exist`);

			switch (rule.action) {
			case 'replace': {
				if (!isFile(target)) throw new Error(`${rule.path} is not a file`);
				const content = readFileSync(source);
				steps.push({ description: `replaced ${rule.path} with ${rule.source}`, apply: () => writeFileSync(target, content) });
				break;
			}
			case 'replaceDir': {
				if (!isDirectory(target) || !isDirectory(source)) throw new Error(`${rule.path} and ${rule.source} must both be directories`);
				for (const file of [...files]) if (file.startsWith(prefix)) files.delete(file);
				for (const file of listFiles(source)) files.add(`${prefix}${file}`);
				steps.push({
					description: `replaced the directory ${rule.path}/ with ${rule.source}/`,
					apply: () => {
						rmSync(target, { recursive: true });
						cpSync(source, target, { recursive: true });
					},
				});
				break;
			}
			case 'remove':
				files.delete(rule.path);
				for (const file of [...files]) if (file.startsWith(prefix)) files.delete(file);
				steps.push({ description: `removed ${rule.path}`, apply: () => rmSync(target, { recursive: true }) });
				break;
			case 'editJson':
			case 'editHtml': {
				if (!isFile(target)) throw new Error(`${rule.path} is not a file`);
				const original = readFileSync(target, 'utf8');
				const edited = rule.action === 'editJson' ? editJson(original, rule) : editHtml(original, rule);
				texts.set(rule.path, edited);
				steps.push({ description: `edited ${rule.path}`, apply: () => writeFileSync(target, edited) });
				break;
			}
			case 'generate': {
				let content: Buffer;
				if (rule.template !== undefined) {
					const template = context.templates[rule.template];
					if (!template) throw new Error(`unknown template ${JSON.stringify(rule.template)}`);
					content = Buffer.from(template(dist), 'utf8');
				} else {
					content = readFileSync(source);
				}
				files.add(rule.path);
				if (rule.path.endsWith('.html')) texts.set(rule.path, content.toString('utf8'));
				steps.push({ description: `generated ${rule.path}`, apply: () => writeFileSync(target, content) });
				break;
			}
			}
		} catch (error) {
			problems.push(`overlay.json rules[${index}] (${rule.action} ${rule.path}): ${(error as Error).message}`);
		}
	});

	if (problems.length === 0) problems.push(...referenceProblems(texts, files));
	if (problems.length > 0) throw new Error(problems.join('\n'));
	for (const step of steps) step.apply();
	return steps.map(step => step.description);
};
