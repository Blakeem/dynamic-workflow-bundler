import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { findDeepestNode, isStackOverflowError, listChildNodes, listLexicalNames, listNameChildren, listPatternIdentifiers, listPatternTargets, listTopLevelNames, listTreeNodes, listVarNames } from '../src/syntax-tree.js';

/** @param {string} text */
function parseBody(text) {
  return parse(text, { ecmaVersion: 'latest', sourceType: 'module' }).body;
}

describe('syntax-tree', () => {
  it('lists the children of a node in the order of its keys', () => {
    const [statement, switched] = parseBody('a = b;\nswitch (x) { case y: z; }');
    assert.deepEqual(listChildNodes(statement.expression).map((node) => node.name), ['a', 'b']);
    assert.deepEqual(listChildNodes(switched.cases[0]).map((node) => node.type), ['ExpressionStatement', 'Identifier']);
  });

  it('lists a node and every node below it in source order, in a tree a recursive walk overflows on', () => {
    const [statement, switched, labeled, template] = parseBody('a = b(c);\nswitch (x) { case y: z; }\nl: m;\n`${n}o`;');
    const program = parse(`y${'.z'.repeat(20000)};\n`, { ecmaVersion: 'latest', sourceType: 'module' });
    const listNames = (node) => listTreeNodes(node).map((child) => child.name ?? child.value?.cooked ?? child.type);

    assert.deepEqual(listNames(statement), ['ExpressionStatement', 'AssignmentExpression', 'a', 'CallExpression', 'b', 'c']);
    assert.deepEqual(listNames(switched), ['SwitchStatement', 'x', 'SwitchCase', 'y', 'ExpressionStatement', 'z']);
    assert.deepEqual(listNames(labeled), ['LabeledStatement', 'l', 'ExpressionStatement', 'm']);
    assert.deepEqual(listNames(template.expression), ['TemplateLiteral', '', 'n', 'o']);
    assert.equal(listTreeNodes(program).length, 2 + 20000 * 2 + 1);
  });

  it('finds the first node in source order at the greatest depth, and the node itself when it has no child', () => {
    const [shallow, deep, tied, switched] = parseBody('a;\nb.c.d;\ne(f);\nswitch (x) { case g(h.i): j.k; }\n');
    const program = parse(`x;\ny${'.z'.repeat(20000)};\n`, { ecmaVersion: 'latest', sourceType: 'module' });
    assert.equal(findDeepestNode(deep).name, 'b');
    assert.equal(findDeepestNode(tied).name, 'e');
    assert.equal(findDeepestNode(switched).name, 'h');
    assert.equal(findDeepestNode(shallow.expression), shallow.expression);
    assert.equal(findDeepestNode(program).name, 'y');
  });

  it('lists the identifiers of a pattern, and none for a member target', () => {
    const [statement] = parseBody('({ a, b: [c, ...d], e = 1, ...f } = g.h);');
    assert.deepEqual(listPatternIdentifiers(statement.expression.left).map((node) => node.name), ['a', 'c', 'd', 'e', 'f']);
    assert.deepEqual(listPatternIdentifiers(parseBody('g.h = 1;')[0].expression.left), []);
  });

  it('lists the identifier and member targets of a pattern, in source order', () => {
    const [statement] = parseBody('({ a, b: [g.h, ...d], e: i[j] = 1, ...f } = k);');
    const listText = (node) => (node.type === 'Identifier' ? node.name : `${node.object.name}.${node.property.name}`);

    assert.deepEqual(listPatternTargets(statement.expression.left).map(listText), ['a', 'g.h', 'd', 'i.j', 'f']);
    assert.deepEqual(listPatternTargets(null), []);
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

  it('lists the local name of each specifier of an export from another file, and none of an export of local names', () => {
    const [reexportStatement, , exportStatement] = parseBody("export { a as b, c } from './a.js';\nconst d = 1;\nexport { d };\n");
    const listNames = (node) => listNameChildren(node).map((child) => child.name);

    assert.deepEqual(listNames(reexportStatement), ['a', 'c']);
    assert.deepEqual(reexportStatement.specifiers.map(listNames), [['b'], []]);
    assert.deepEqual(listNames(exportStatement), []);
  });
});

describe('isStackOverflowError', () => {
  it('is true for the error of a recursion that overflows the stack, and false for another RangeError', () => {
    const recurse = () => recurse();
    let overflowError = null;
    try {
      recurse();
    } catch (error) {
      overflowError = error;
    }

    assert.equal(isStackOverflowError(overflowError), true);
    assert.equal(isStackOverflowError(new RangeError('Invalid array length')), false);
    assert.equal(isStackOverflowError(new Error('Maximum call stack size exceeded')), false);
  });
});
