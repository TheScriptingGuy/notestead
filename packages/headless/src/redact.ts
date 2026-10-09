// Log redaction (ADR-0008, CLAUDE.md security rules). Every line the supervisor writes or relays from a CLI child
// goes through a Redactor: known secret values (sync password, master password, the current Data API token) are
// replaced, query strings are dropped from URLs, and any `token=` value is masked wherever it appears.
export const redactedMark = '[redacted]';

// "?name=value…" up to the next whitespace or quote: the query string of a URL or of a request line.
const queryString = /\?(?=[^\s"'<>=&?#]+=)[^\s"'<>]*/g;
const tokenParam = /\b(token=)[^&\s"'<>]+/gi;

export class Redactor {
	private secrets_: string[] = [];

	public constructor(secrets: string[] = []) {
		for (const secret of secrets) this.addSecret(secret);
	}

	// Also covers the JSON-escaped form of the value (for example a non-ASCII password inside logged JSON).
	public addSecret(secret: string): void {
		if (secret === '') return;
		const escaped = JSON.stringify(secret).slice(1, -1);
		for (const form of [secret, escaped]) {
			if (!this.secrets_.includes(form)) this.secrets_.push(form);
		}
		// Longest first, so a secret that contains another one is replaced whole.
		this.secrets_.sort((a, b) => b.length - a.length);
	}

	public redact(text: string): string {
		let out = text;
		for (const secret of this.secrets_) out = out.split(secret).join(redactedMark);
		return out.replace(queryString, `?${redactedMark}`).replace(tokenParam, `$1${redactedMark}`);
	}
}
