export const meta = { name: 'import-not-default' };
import { first } from './notes.md';
import * as settings from './settings.json';
import './notes.md';
return [first, settings];
