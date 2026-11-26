export default {
  workflows: [
    { entry: 'workflows/review/entry.js', out: 'dist/review.js' },
    { entry: 'workflows/summary/entry.js', out: 'dist/summary.js', banner: false },
  ],
};
