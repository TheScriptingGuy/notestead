// Joplin's sync serialization of a note, for DNS-1 D1: `title`, an empty line, the body, an empty line, then one
// `key: value` line per property. Joplin Server re-serializes uploaded notes and may add keys, so the stored note is
// compared field by field with what was uploaded (title, body, every uploaded property) and never byte for byte.
export interface JoplinItem {
	title: string;
	body: string;
	props: Map<string, string>;
}

export const parseJoplinItem = (text: string): JoplinItem => {
	const split = text.lastIndexOf('\n\n');
	const head = split < 0 ? text : text.slice(0, split);
	const propsText = split < 0 ? '' : text.slice(split + 2);
	const props = new Map<string, string>();
	for (const line of propsText.split('\n')) {
		const m = /^([A-Za-z_]+):[ ]?(.*)$/.exec(line);
		if (m) props.set(m[1], m[2]);
	}
	const firstBreak = head.indexOf('\n\n');
	return {
		title: firstBreak < 0 ? head : head.slice(0, firstBreak),
		body: firstBreak < 0 ? '' : head.slice(firstBreak + 2),
		props,
	};
};

export interface ItemComparison {
	// named differences: `title`, `body`, `property <key>`
	differences: string[];
	// keys the stored item has and the uploaded one did not (the server's own)
	extraKeys: string[];
}

export const compareUploadedItem = (uploaded: JoplinItem, stored: JoplinItem): ItemComparison => {
	const differences: string[] = [];
	if (uploaded.title !== stored.title) differences.push('title');
	if (uploaded.body !== stored.body) differences.push('body');
	for (const [key, value] of uploaded.props) {
		if (stored.props.get(key) !== value) differences.push(`property ${key}`);
	}
	return { differences, extraKeys: [...stored.props.keys()].filter(k => !uploaded.props.has(k)) };
};
