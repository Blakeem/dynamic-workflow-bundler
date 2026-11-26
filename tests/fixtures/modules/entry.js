export const meta = {
  name: 'modules-fixture',
  description: 'Uses every import and export form',
};

log('entry');
const countBeforeImport = bump();

import { counter, increment as bump } from './lib/counter.js';
import greet from './lib/greet.js';
import shapesDefault, * as shapes from './lib/shapes.js';
import './lib/side-effect.js';
import { readCount } from './lib/reader.js';
import { prompt } from './lib/prompt.mjs';

bump();

return {
  countBeforeImport,
  count: readCount(),
  sharedCount: counter.count,
  greeting: greet('agent'),
  greetName: greet.name,
  shapesDefault,
  isNamespaceFrozen: Object.isFrozen(shapes),
  namespaceKeys: Object.keys(shapes),
  namespaceDefault: shapes.default,
  area: new shapes.Square(3).area(),
  kind: shapes.Square.kind,
  corners: [...shapes.corners()],
  delayed: await shapes.delayed('later'),
  width: shapes.width,
  tall: shapes.tall,
  prompt,
  task: args.task,
};
