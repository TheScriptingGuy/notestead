// The E2EE device's `joplin batch` script (see device.mjs). Kept apart so its rules are tested (tests/acceptance/m2-s4/device-batch.test.mts).
export const deviceBatch = (plan, extras, attachmentPath) => [
	`e2ee enable --password "${plan.masterPassword}"`,
	`mkbook "${plan.folder}"`,
	`use "${plan.folder}"`,
	...plan.notes.flatMap(n => [`mknote "${n.title}"`, `set "${n.title}" body "${n.body}"`]),
	...(extras ? [
		`mktodo "${extras.todo.title}"`,
		`set "${extras.todo.title}" todo_due ${extras.todo.due}`,
		`tag add "${extras.tag.title}" "${extras.tag.note}"`,
		`mknote "${extras.attachment.note}"`,
		`attach "${extras.attachment.note}" "${attachmentPath}"`,
	] : []),
	// a real device syncs again; the first sync after `e2ee enable` can leave an item unsent (M2-S3 WO-11: a seed whose folder
	// never reached the server). The second sync skips the local lock: the CLI releases the first sync's lock without awaiting it
	// (command-sync.ts:163), so a second sync in the same batch can see it held (M2-S4 HF-1)
	'sync',
	'sync --use-lock 0',
	'ls --format json',
].join('\n');
