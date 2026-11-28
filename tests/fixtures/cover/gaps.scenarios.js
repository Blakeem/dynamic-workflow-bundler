export default [
  { name: 'ships', respond: { '': 'ok' } },
  { name: 'bad mode', args: { mode: 'bad' }, expect: 'threw' },
];
