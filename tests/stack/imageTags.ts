// Image tags of the test layers (docs/test-plans/M2-S3.md F10; CI-M2-S2 F-H1). The E2E stack builds and may keep
// stackDeviceTag (NOTESTEAD_KEEP_IMAGE=1); the contract layer used to build that same tag and remove it at teardown, which
// left the kept E2E image untagged. The contract layer now uses a prebuilt NOTESTEAD_DEVICE_IMAGE as it is (never removed),
// or builds its own tag, as its web (m1-s4-test) and headless (m1-s5-test) images already do.
export const stackDeviceTag = (cliVersion: string): string => `localhost/notestead-test-device:${cliVersion}`;
export const contractDeviceTag = 'localhost/notestead-test-device:m1-s5-test';
export const contractDeviceChoice = (env: string | undefined): { image: string; prebuilt: boolean } =>
	(env ? { image: env, prebuilt: true } : { image: contractDeviceTag, prebuilt: false });
