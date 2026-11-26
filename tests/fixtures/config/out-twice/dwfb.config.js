export default {
  workflows: [
    { entry: 'first.js', out: 'dist/out.js' },
    { entry: 'second.js', out: 'dist/other.js' },
    { entry: 'third.js', out: './dist/../dist/out.js' },
  ],
};
