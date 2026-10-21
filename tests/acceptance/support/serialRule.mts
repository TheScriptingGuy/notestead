// A spec line that disrupts a shared service: a shared handle and a disruptive verb on the same line.
export const sharedHandle = /\bstack\.(containers\.(server|web)|defaultHeadless|defaultAccount)\b/;
export const disruptiveVerb = /\b(stop|restart|kill|pause|rm|down|removeContainer|downHeadless|syncHeadlessOnce|upHeadless|upCore|composeSync)\b|['"](stop|restart|kill|pause|rm)['"]/;
export const disruptiveLines = (source: string): number[] => source.split('\n').flatMap((line, i) => (sharedHandle.test(line) && disruptiveVerb.test(line)) || /\bdownStack\s*\(/.test(line) ? [i + 1] : []);
