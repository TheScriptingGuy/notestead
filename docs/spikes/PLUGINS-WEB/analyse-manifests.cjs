// PLUGINS-WEB study: platform split of the official plugin repository (read-only data, nothing executed).
// Usage: node analyse-manifests.cjs <manifests.json> <stats.json> <upstream-clone>
// manifests.json and stats.json: GET https://raw.githubusercontent.com/joplin/plugins/master/{manifests,stats}.json
// <upstream-clone>: laurent22/joplin at the pin; its getDefaultPlatforms.ts supplies upstream's mobile allow-list.
'use strict';
const fs = require('fs');
const path = require('path');
const [manifestsPath, statsPath, upstream] = process.argv.slice(2);
if (!upstream) throw new Error('usage: node analyse-manifests.cjs <manifests.json> <stats.json> <upstream-clone>');
const manifests = JSON.parse(fs.readFileSync(manifestsPath, 'utf8'));
const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
const allowSrc = fs.readFileSync(path.join(upstream, 'packages/lib/services/plugins/utils/isCompatible/getDefaultPlatforms.ts'), 'utf8');
const allowList = new Set([...allowSrc.split('defaultSupportMobile = [')[1].split('];')[0].matchAll(/'([^']+)'/g)].map(m => m[1]));
// Mirrors upstream's rule: an explicit `platforms` wins; otherwise ['desktop'] unless the id is on the allow-list.
const platformsOf = (id, m) => m.platforms || (allowList.has(id) ? ['desktop', 'mobile'] : ['desktop']);
const downloads = id => Object.values(stats[id] || {}).reduce((sum, v) => sum + (v.downloadCount || 0), 0);
const rows = Object.entries(manifests).filter(([, m]) => !m._obsolete)
	.map(([id, m]) => ({ id, name: m.name, version: m.version, mobile: platformsOf(id, m).includes('mobile'), explicit: !!m.platforms, downloads: downloads(id), recommended: !!m._recommended }))
	.sort((a, b) => b.downloads - a.downloads);
const sum = list => list.reduce((s, r) => s + r.downloads, 0);
const desktopOnly = rows.filter(r => !r.mobile);
console.log(JSON.stringify({ plugins: rows.length, mobileCompatible: rows.length - desktopOnly.length, desktopOnly: desktopOnly.length, explicitPlatforms: rows.filter(r => r.explicit).length, allowList: allowList.size, downloadShareMobile: +(1 - sum(desktopOnly) / sum(rows)).toFixed(3) }));
const top = Number(process.env.TOP || 40);
console.log(`Top ${top} desktop-only by GitHub release download count (stats.json):`);
for (const r of desktopOnly.slice(0, top)) console.log([r.downloads, r.id, r.name, r.version, r.recommended ? 'recommended' : ''].join(' | '));
if (process.env.IDS_OUT) fs.writeFileSync(process.env.IDS_OUT, desktopOnly.slice(0, top).map(r => r.id).join('\n') + '\n');
