// Notestead overlay (ADR-0010): installed as environment.js in the built web bundle, in place of upstream's file.
// React Native dev mode stays off on every origin (upstream's file enables it on origins containing "localhost").
window.__DEV__ = false;

// Globals the web bundle expects before it loads: a CommonJS-style `exports` object and `process.env.EXPO_OS`.
window.exports = {};
window.process = { env: { EXPO_OS: 'web' } };
