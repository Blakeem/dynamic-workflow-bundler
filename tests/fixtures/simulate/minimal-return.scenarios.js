import { createReturn } from 'dynamic-workflow-bundler';

export default [{ name: 'passes', respond: (call) => createReturn(call.opts.schema, { verdict: 'pass' }) }];
