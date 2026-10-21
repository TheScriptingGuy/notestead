// Unit tests of the "type like a user" helper's secret guard and focus-loss handling (tests/e2e/support/typeLikeUser.ts;
// docs/test-plans/M1-S7.md, C1-R1 layer "unit"). A hand-written fake Locator records every call, so each test can
// prove that no key was pressed when the helper refuses. The real-DOM counterpart is tests/e2e/harness/type-like-user.spec.ts.
import { describe, expect, test } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { SecretInVisibleFieldError, clearLikeUser, secretIn, typeLikeUser } from '../../e2e/support/typeLikeUser.ts';
import type { KnownSecret } from '../../support/redact.ts';
import { registeredSecrets } from '../../support/secrets.ts';

interface FakeOptions {
	// the element's local name (default: input)
	tag?: string;
	type: string | null;
	// the type after the first pressSequentially (a show-password toggle)
	typeAfterTyping?: string | null;
	// what the app keeps of each pressSequentially call (default: everything); also whether focus is lost afterwards
	accept?: (typed: string, call: number) => { keep: string; loseFocus?: boolean };
	initialValue?: string;
	// Backspace does nothing (a field that refuses to clear)
	refuseClear?: boolean;
}

interface Fake {
	field: Locator;
	calls: string[];
	value: () => string;
}

const fakeField = (opts: FakeOptions): Fake => {
	let value = opts.initialValue ?? '';
	let type = opts.type;
	let focused = false;
	let typed = 0;
	// ControlOrMeta+a selects the whole value; Backspace then removes it
	let selected = false;
	const calls: string[] = [];
	const element = {
		localName: opts.tag ?? 'input',
		get type() {
			return type;
		},
		get value() {
			return value;
		},
		ownerDocument: { activeElement: null as unknown },
	};
	const sync = (): void => {
		element.ownerDocument.activeElement = focused ? element : null;
	};
	const fake = {
		getAttribute: async (name: string) => {
			calls.push(`getAttribute ${name}`);
			return name === 'type' ? type : null;
		},
		click: async () => {
			calls.push('click');
			focused = true;
			sync();
		},
		press: async (key: string) => {
			calls.push(`press ${key}`);
			if (key === 'ControlOrMeta+a') selected = true;
			if (key === 'Backspace' && selected && !opts.refuseClear) {
				value = '';
				selected = false;
			}
		},
		pressSequentially: async (text: string) => {
			calls.push(`pressSequentially ${text}`);
			const { keep, loseFocus } = opts.accept ? opts.accept(text, typed) : { keep: text };
			typed++;
			value += keep;
			if (loseFocus) focused = false;
			if (opts.typeAfterTyping !== undefined) type = opts.typeAfterTyping;
			sync();
		},
		inputValue: async () => value,
		evaluate: async <R>(fn: (e: unknown) => R) => fn(element),
	};
	return { field: fake as unknown as Locator, calls, value: () => value };
};

const secret: KnownSecret = { label: 'pertest_master_password', value: 'nstmp0123456789abcdef01234567 Δ$x!' };
const quick = { timeoutMs: 300, secrets: [secret] };
const keys = (fake: Fake): string[] => fake.calls.filter(c => c.startsWith('pressSequentially') || c === 'click' || c.startsWith('press '));

describe('typeLikeUser', () => {
	describe('c1r1: secrets only into password fields', () => {
		test('c1r1-unit-1 refuses a registered secret for a text field, before any key', async () => {
			const fake = fakeField({ type: 'text' });
			await expect(typeLikeUser(fake.field, secret.value, quick)).rejects.toThrow(SecretInVisibleFieldError);
			await expect(typeLikeUser(fake.field, secret.value, quick)).rejects.toThrow(/\[pertest_master_password\].*type "text".*before typing/);
			expect(keys(fake)).toEqual([]);
			expect(fake.value()).toBe('');
		});

		test('c1r1-unit-2 refuses a text that only contains a registered secret (e.g. "Bearer <secret>")', async () => {
			const fake = fakeField({ type: 'text' });
			await expect(typeLikeUser(fake.field, `Bearer ${secret.value}`, quick)).rejects.toThrow(SecretInVisibleFieldError);
			expect(keys(fake)).toEqual([]);
		});

		test('c1r1-unit-3 refuses a text marked secret that no registry knows, and a field with no type (textarea)', async () => {
			const text = fakeField({ type: 'text' });
			await expect(typeLikeUser(text.field, 'unregistered-value-123', { ...quick, secrets: [], secret: true })).rejects.toThrow(/marked secret/);
			const textarea = fakeField({ type: null });
			await expect(typeLikeUser(textarea.field, secret.value, quick)).rejects.toThrow(/<input> of type "null"/);
			expect([...keys(text), ...keys(textarea)]).toEqual([]);
		});

		test('c1r1-unit-4 types a secret into a password field in one go (positive control)', async () => {
			const fake = fakeField({ type: 'password' });
			await typeLikeUser(fake.field, secret.value, quick);
			expect(keys(fake)).toEqual(['click', `pressSequentially ${secret.value}`]);
			expect(fake.value()).toBe(secret.value);
		});

		test('c1r1-unit-5 fails when the field was unmasked while typing (show-password toggle)', async () => {
			const fake = fakeField({ type: 'password', typeAfterTyping: 'text' });
			await expect(typeLikeUser(fake.field, secret.value, quick)).rejects.toThrow(/type "text".*after typing/);
		});

		test('c1r1-unit-6 never re-types part of a secret: a lost character fails the step', async () => {
			const fake = fakeField({ type: 'password', accept: t => ({ keep: t.slice(0, 1), loseFocus: true }) });
			await expect(typeLikeUser(fake.field, secret.value, quick)).rejects.toThrow(/all 34 typed characters/);
			expect(keys(fake).filter(c => c.startsWith('pressSequentially'))).toHaveLength(1);
		});

		// M1-S8 C1-R1a (review M1-S7-r1): a text marked secret that no registry knows would reach the trace's typing action
		// and the report's step title in clear, because the redacting reporter only knows registered values.
		test('c1r1a-unit-8 a text marked secret that no registry knows is registered (label typed_secret) before the first key', async () => {
			const text = `unregistered-${randomBytes(8).toString('hex')}`;
			let registeredAtFirstKey: boolean | undefined;
			const fake = fakeField({
				type: 'password',
				accept: t => {
					registeredAtFirstKey ??= registeredSecrets().some(s => s.value === text);
					return { keep: t };
				},
			});
			await typeLikeUser(fake.field, text, { ...quick, secrets: [], secret: true });
			const entry = registeredSecrets().find(s => s.value === text);
			expect({ atFirstKey: registeredAtFirstKey, label: entry?.label }).toEqual({ atFirstKey: true, label: 'typed_secret' });
		});

		// Review M1-S7-r1 C-N1: the guard reads the element, not its `type` attribute (a textarea or a custom element that
		// carries type="password" renders its text in clear).
		test('c-n1-unit-1 refuses a textarea that carries type="password", before any key', async () => {
			const fake = fakeField({ tag: 'textarea', type: 'password' });
			await expect(typeLikeUser(fake.field, secret.value, quick)).rejects.toThrow(SecretInVisibleFieldError);
			expect(keys(fake)).toEqual([]);
		});

		test('c-n1-unit-2 refuses a custom element that carries type="password"', async () => {
			const fake = fakeField({ tag: 'x-secret-field', type: 'password' });
			await expect(typeLikeUser(fake.field, secret.value, quick)).rejects.toThrow(SecretInVisibleFieldError);
			expect(keys(fake)).toEqual([]);
		});

		test('c-n1-unit-3 types a secret into an input of type password in one go', async () => {
			const fake = fakeField({ tag: 'input', type: 'password' });
			await typeLikeUser(fake.field, secret.value, quick);
			expect(fake.calls.filter(c => c.startsWith('pressSequentially'))).toHaveLength(1);
		});

		test('c1r1-unit-7 values shorter than 6 characters are never treated as secrets', () => {
			expect(secretIn('abc', [{ label: 'short', value: 'abc' }])).toBeUndefined();
			expect(secretIn(`x${secret.value}y`, [secret])).toBe('pertest_master_password');
		});
	});

	describe('focus loss, upstream Finding F1', () => {
		test('f1-unit-1 resumes a non-secret text when the field lost focus after the first key', async () => {
			const text = 'http://127.0.0.1:44821/joplin-server';
			const fake = fakeField({ type: 'text', accept: (t, call) => (call === 0 ? { keep: t.slice(0, 1), loseFocus: true } : { keep: t }) });
			await typeLikeUser(fake.field, text, quick);
			expect(fake.value()).toBe(text);
			expect(keys(fake)).toEqual(['click', 'press End', `pressSequentially ${text}`, 'click', 'press End', `pressSequentially ${text.slice(1)}`]);
		});

		test('f1-unit-2 a value that is not a prefix of the text fails at once (no retyping over garbage)', async () => {
			const fake = fakeField({ type: 'text', initialValue: 'garbage' });
			await expect(typeLikeUser(fake.field, 'http://x', quick)).rejects.toThrow(/not a prefix/);
			expect(keys(fake)).toEqual([]);
		});

		test('f1-unit-3 gives up after the allowed number of resumes', async () => {
			const fake = fakeField({ type: 'text', accept: t => ({ keep: t.slice(0, 1), loseFocus: true }) });
			await expect(typeLikeUser(fake.field, 'abcdefghij', { ...quick, maxResumes: 2 })).rejects.toThrow(/after 2 resumes/);
		});
	});

	describe('clearLikeUser', () => {
		test('clear-01 empties the field with select-all and Backspace, as real keys', async () => {
			const fake = fakeField({ type: 'text', initialValue: 'old title' });
			await clearLikeUser(fake.field, { timeoutMs: 300 });
			expect(fake.value()).toBe('');
			expect(keys(fake)).toEqual(['click', 'press ControlOrMeta+a', 'press Backspace']);
		});

		test('clear-02 fails, without the value, when the field stays filled', async () => {
			const fake = fakeField({ type: 'text', initialValue: 'old title', refuseClear: true });
			const failure = clearLikeUser(fake.field, { timeoutMs: 300 });
			await expect(failure).rejects.toThrow(/the field to be empty/);
			const message = await failure.then(() => '', (error: unknown) => String(error));
			expect(message).not.toContain('old title');
		});
	});
});
