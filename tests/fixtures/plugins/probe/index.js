// SPDX-License-Identifier: AGPL-3.0-or-later
// Notestead test probe plugin (docs/test-plans/M2-S4.md D7): on start, creates one note titled with its marker.
/* global joplin */
joplin.plugins.register({
	onStart: async () => {
		await joplin.data.post(['notes'], null, { title: '__NST_MARKER__' });
	},
});
