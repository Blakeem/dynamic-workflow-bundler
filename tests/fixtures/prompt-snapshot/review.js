export const meta = {
  name: 'review',
  description: 'Reviews each unit, verifies the findings in rounds, then writes a summary.',
};

const FINDINGS_SCHEMA = { type: 'object', properties: { findings: { type: 'array' } }, required: ['findings'] };
const VERDICT_SCHEMA = { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'] };
const RETRY_SCHEMA = { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass'] };

const units = args?.units ?? ['core', 'tools'];
const summaryLabel = args?.summaryLabel ?? 'summary';

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

await parallel(units.map((unit) => () =>
  agent(`Review the unit ${unit}, whose id is ${hashText(unit)}. Report at most 3 findings.${args?.strict ? '\nReport each finding, also a low one.' : ''}`, { label: `review:${unit}`, schema: FINDINGS_SCHEMA })));

let round = 1;
let verdict = null;
do {
  const retryNote = round > 1 ? `\nRound ${round - 1} failed. Check each finding again.` : '';
  verdict = await agent(`Verify the findings of ${units.length} units in round ${round}.${retryNote}`, { label: `verify r${round}`, schema: round > 1 ? RETRY_SCHEMA : VERDICT_SCHEMA });
  round += 1;
} while (verdict?.pass !== true && round <= 3);

await agent('Write the summary between the fences.\n~~~~\nsummary\n~~~~', { label: summaryLabel });
return { status: verdict?.pass === true ? 'done' : 'failed' };
