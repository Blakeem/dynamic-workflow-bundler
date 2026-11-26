export function reviewPrompt(change, checklist) {
  return `Review this change.
${checklist}
${change}`;
}
