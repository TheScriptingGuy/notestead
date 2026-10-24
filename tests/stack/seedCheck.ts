// The post-condition of the E2EE seed (docs/test-plans/DNS-1.md DNS1-AC4): `info.json` on the server names at least one
// master key and has E2EE switched on. Implemented in WO-4; this stub keeps the type check green while dev1-u1 is RED.
export const checkSeededInfo = (_status: number, _text: string): string | undefined => {
	throw new Error('checkSeededInfo is not implemented yet (DNS-1 WO-4)');
};
