import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { listChildNodes, listLexicalNames, listNameChildren, listPatternIdentifiers, listTopLevelNames, listVarNames } from '../src/syntax-tree.js';

/** @param {string} text */
function parseBody(text) {
  return parse(text, { ecmaVersion: 'latest', sourceType: 'module' }).body;
}

describe('syntax-tree', () => {
  it('lists the children of a node in source order', () => {
    const [statement] = parseBody('a = b;');
    assert.deepEqual(listChildNodes(statement.expression).map((node) => node.name), ['a', 'b']);
  });

  it('lists the identifiers of a pattern, and none for a member target', () => {
    const [statement] = parseBody('({ a, b: [c, ...d], e = 1, ...f } = g.h);');
    assert.deepEqual(listPatternIdentifiers(statement.expression.left).map((node) => node.name), ['a', 'c', 'd', 'e', 'f']);
    assert.deepEqual(listPatternIdentifiers(parseBody('g.h = 1;')[0].expression.left), []);
  });

  it('lists lexical names of direct statements and var names outside nested functions', () => {
    const body = parseBody('let a; class B {} function c() { var d; }\n{ let e; var f; }\nfor (var g of []) {}');
    assert.deepEqual(listLexicalNames(body), ['a', 'B', 'c']);
    assert.deepEqual(listVarNames(body), ['f', 'g']);
  });

  it('lists the top-level names of a file, with imports and exported declarations', () => {
    const body = parseBody("import a, { b as c } from './a.js';\nexport const d = 1;\nexport default function e() {}\nvar f;\n");
    assert.deepEqual(listTopLevelNames(body).sort(), ['a', 'c', 'd', 'e', 'f']);
    assert.deepEqual(listTopLevelNames(parseBody('export default (class G {});')), []);
  });

  it('lists the property, label, import and export names below a node, and no variable name', () => {
    const [importStatement, exportStatement, labelStatement, objectStatement] = parseBody(
      "import { a as b, c } from './a.js';\nexport { b as d, c };\ne: for (;;) break e;\n({ f: g.h, [i]: 1 });\n",
    );
    const listNames = (node) => listNameChildren(node).map((child) => child.name);
    const [firstProperty, computedProperty] = objectStatement.expression.properties;

    assert.deepEqual(importStatement.specifiers.map(listNames), [['a'], []]);
    assert.deepEqual(exportStatement.specifiers.map(listNames), [['d'], []]);
    assert.deepEqual([listNames(labelStatement), listNames(labelStatement.body.body)], [['e'], ['e']]);
    assert.deepEqual([listNames(firstProperty), listNames(firstProperty.value), listNames(computedProperty)], [['f'], ['h'], []]);
  });
});
