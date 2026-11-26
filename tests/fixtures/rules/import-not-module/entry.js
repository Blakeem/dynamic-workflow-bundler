export const meta = { name: 'import-not-module' };
import notes from './notes.md';
import settings from './settings.js' with { type: 'json' };
return [notes, settings];
