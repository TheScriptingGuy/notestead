// "Type like a user" (ADR-0007; the user's plugin repo pattern): real key events into a field, never `fill` or a
// synthetic change event, then a check that the app accepted every character. docs/test-plans/M1-S7.md §Harness.
//
// Secrets (review M1-S6a-r1 C1-R1). The text redaction of the harness cannot touch pixels: the trace's screencast frames
// are JPEGs. A secret is therefore only ever typed into a masked field. Before the first key, the field must be an
// `<input type="password">`; after the last key it must still be one (a show-password toggle would have unmasked it).
// Otherwise the helper throws SecretInVisibleFieldError and no key is pressed. A text is a secret when the caller says
// so (`secret: true`) or when it contains any secret the harness knows (tests/support/secrets.ts: the registry of this
// process, the run's registry file, and the stack's accounts). A text marked secret that no registry knows is
// registered (label `typed_secret`) before the first key, so the redacting reporter knows it too (M1-S8 C1-R1a).
//
// Focus loss. Upstream's sync settings re-render the "Joplin Server URL" field after its first change (the "Attention:
// If you change this location…" notice appears), and the field loses focus, so the keys after that go nowhere
// (docs/test-plans/M1-S7.md, Finding F1). A user clicks the field again and types on: for a non-secret text the helper
// does the same while the field holds a prefix of the text. A secret is typed in one go and never re-typed in parts:
// the trace records each part as its own action, and a part of a secret is not something the redaction can recognise.
import type { Locator } from '@playwright/test';
import { waitFor } from '../../support/poll.ts';
import type { KnownSecret } from '../../support/redact.ts';
import { mergeSecrets, readSecretsFile, registerSecrets, registeredSecrets, secretsFileEnv } from '../../support/secrets.ts';

export class SecretInVisibleFieldError extends Error {}

export interface TypeOptions {
	// the text is a secret even if no registry knows it
	secret?: boolean;
	// the secrets to recognise (default: every secret this process knows)
	secrets?: KnownSecret[];
	// how long the app may take to show the typed value
	timeoutMs?: number;
	// how often a non-secret text may be resumed after the field lost focus
	maxResumes?: number;
}

// The accounts of the stack this worker runs against (NOTESTEAD_E2E_STACK), as the redacting reporter reads them.
const stackSecrets = (): KnownSecret[] => {
	const raw = process.env.NOTESTEAD_E2E_STACK;
	if (!raw) return [];
	try {
		const state = JSON.parse(raw) as { accounts?: { password: string; masterPassword: string }[] };
		return (state.accounts ?? []).flatMap((a, i) => [
			{ label: `account${i}_password`, value: a.password },
			{ label: `account${i}_master_password`, value: a.masterPassword },
		]);
	} catch {
		return [];
	}
};

export const knownSecretsNow = (): KnownSecret[] => mergeSecrets(registeredSecrets(), readSecretsFile(process.env[secretsFileEnv]), stackSecrets());

// The label of the first known secret `text` contains, if any.
export const secretIn = (text: string, secrets: KnownSecret[]): string | undefined => secrets.find(s => s.value.length >= 6 && text.includes(s.value))?.label;

// What the element is, not what its attribute says (review M1-S7-r1 C-N1): a <textarea type="password"> or a custom
// element with that attribute renders its text in clear.
const describeField = async (field: Locator): Promise<{ masked: boolean; what: string }> => field.evaluate(e => {
	const el = e as unknown as { localName?: unknown; type?: unknown };
	return { masked: el.localName === 'input' && el.type === 'password', what: `<${String(el.localName)}> of type "${String(el.type)}"` };
});

const requireMasked = async (field: Locator, what: string, when: string): Promise<void> => {
	const f = await describeField(field);
	if (!f.masked) throw new SecretInVisibleFieldError(`C1-R1: refusing to type ${what} into ${f.what} (${when}): a secret is only ever typed into an <input type="password">, because the trace's screencast frames cannot be redacted`);
};

export const typeLikeUser = async (field: Locator, text: string, opts: TypeOptions = {}): Promise<void> => {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const label = secretIn(text, opts.secrets ?? knownSecretsNow());
	if (opts.secret || label) {
		// A marked secret that no registry knows is registered first (M1-S8 C1-R1a): Playwright records the typed text
		// in the trace's action and in the report's step title, and the redacting reporter only removes known values.
		if (!label) registerSecrets([{ label: 'typed_secret', value: text }]);
		const what = `a secret (${label ? `[${label}]` : 'marked secret'})`;
		await requireMasked(field, what, 'before typing');
		await field.click();
		await field.pressSequentially(text);
		await requireMasked(field, what, 'after typing');
		// Only the length is compared: the value never travels as an argument into the trace or an error message.
		const expected = text.length;
		await waitFor(`the masked field to hold all ${expected} typed characters`, async () => {
			const length = await field.evaluate(e => (e as unknown as { value: string }).value.length);
			return length === expected ? true : undefined;
		}, { timeoutMs });
		return;
	}

	const maxResumes = opts.maxResumes ?? 5;
	for (let attempt = 0; ; attempt++) {
		const value = await field.inputValue();
		if (value === text) return;
		if (!text.startsWith(value)) throw new Error(`typing ${JSON.stringify(text)}: the field holds ${JSON.stringify(value)}, which is not a prefix of it`);
		if (attempt > maxResumes) throw new Error(`typing ${JSON.stringify(text)}: the field still holds ${JSON.stringify(value)} after ${maxResumes} resumes`);
		await field.click();
		await field.press('End');
		await field.pressSequentially(text.slice(value.length));
		// The app may still be applying the keys (a controlled input): wait until the value is settled.
		await waitFor(`the field to settle after typing ${JSON.stringify(text)}`, async () => {
			const now = await field.inputValue();
			const focused = await field.evaluate(e => {
				const el = e as unknown as { ownerDocument: { activeElement: unknown } };
				return el.ownerDocument.activeElement === el;
			});
			return now === text || !focused || !text.startsWith(now) ? true : undefined;
		}, { timeoutMs });
	}
};
