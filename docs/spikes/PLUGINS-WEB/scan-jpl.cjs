// PLUGINS-WEB study: static scan of extracted plugin packages for desktop-only API use. Reads text only; it never
// loads or runs plugin code. A hit means "the bundle contains this pattern", not "the plugin needs it at runtime".
// Usage: node scan-jpl.cjs <dir containing one extracted .jpl per sub-directory>
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
if (!root) throw new Error('usage: node scan-jpl.cjs <extracted-root>');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const patterns = {
	nodeFs: /require\(["'](fs|fs-extra|node:fs)["']\)/,
	childProcess: /require\(["'](child_process|node:child_process)["']\)/,
	electron: /require\(["']electron["']\)|@electron\/remote/,
	os: /require\(["'](os|node:os)["']\)/,
	nodeNet: /require\(["'](http|https|net|tls|dgram)["']\)/,
	joplinRequire: /\.require\(["'](sqlite3|fs-extra|7zip-bin)["']\)/,
	menus: /menus\.create\(/,
	menuItems: /menuItems\.create\(/,
	panels: /panels\.create\(/,
	dialogs: /dialogs\.create\(/,
	showOpenDialog: /showOpenDialog/,
	noteList: /registerRenderer/,
	imaging: /imaging\.(createFrom|toPng|toJpg|resize|crop)/,
	cmContentScript: /ContentScriptType\.CodeMirrorPlugin/,
	mdContentScript: /ContentScriptType\.MarkdownItPlugin/,
	cm5: /defineExtension|defineOption\(|\.getDoc\(\)|addon\/(fold|edit|search)/,
	cm6: /@codemirror\/|EditorView\.updateListener|StateField\.define/,
	chromeCss: /loadChromeCssFile/,
	noteCss: /loadNoteCssFile/,
	interop: /register(Export|Import)Module/,
	editorContextMenu: /filterEditorContextMenu/,
	toolbarButtons: /toolbarButtons\.create\(/,
	ai: /\.ai\.(chat|search|embeddings)\(/,
};
for (const id of fs.readdirSync(root).sort()) {
	const files = walk(path.join(root, id)).filter(f => /\.js$/.test(f));
	const text = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
	let manifest = {};
	try { manifest = JSON.parse(fs.readFileSync(path.join(root, id, 'manifest.json'), 'utf8')); } catch { /* none */ }
	const hits = Object.entries(patterns).filter(([, re]) => re.test(text)).map(([k]) => k);
	console.log([id, manifest.version || '', JSON.stringify(manifest.platforms || null), hits.join(' ')].join(' | '));
}
