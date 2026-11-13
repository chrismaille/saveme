import {deepClone, isPlainObject, mergeDeep, toNumber} from '../../../src/domain/object.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('domain/object', [
    test('isPlainObject distinguishes null, primitives, arrays and objects', () => {
        assertEqual(isPlainObject(null), false);
        assertEqual(isPlainObject(undefined), false);
        assertEqual(isPlainObject(1), false);
        assertEqual(isPlainObject('x'), false);
        assertEqual(isPlainObject([]), false);
        assertEqual(isPlainObject({}), true);
        assertEqual(isPlainObject({a: 1}), true);
    }),
    test('deepClone copies nested structures', () => {
        const source = {a: 1, nested: {b: [2, 3]}};
        const copy = deepClone(source);
        copy.nested.b.push(4);
        assertEqual(JSON.stringify(source), JSON.stringify({a: 1, nested: {b: [2, 3]}}));
        assertEqual(JSON.stringify(copy), JSON.stringify({a: 1, nested: {b: [2, 3, 4]}}));
    }),
    test('mergeDeep merges nested objects without mutating the base', () => {
        const base = {a: {b: 1, c: 2}, keep: true, list: [1]};
        const merged = mergeDeep(base, {a: {b: 10, d: 3}, list: [2]});
        assertEqual(JSON.stringify(merged), JSON.stringify({
            a: {b: 10, c: 2, d: 3},
            keep: true,
            list: [2],
        }));
        assertEqual(JSON.stringify(base), JSON.stringify({
            a: {b: 1, c: 2},
            keep: true,
            list: [1],
        }));
    }),
    test('mergeDeep handles non-object overrides and null values', () => {
        assertEqual(JSON.stringify(mergeDeep({a: 1}, null)), JSON.stringify({a: 1}));
        assertEqual(JSON.stringify(mergeDeep({a: 1}, 'x')), JSON.stringify({a: 1}));
        assertEqual(JSON.stringify(mergeDeep({a: 1}, {})), JSON.stringify({a: 1}));
        assertEqual(JSON.stringify(mergeDeep({a: 1}, {b: 2})), JSON.stringify({a: 1, b: 2}));
        assertEqual(JSON.stringify(mergeDeep({a: {b: 1}}, {a: null})), JSON.stringify({a: null}));
    }),
    test('toNumber accepts finite numbers and falls back otherwise', () => {
        assertEqual(toNumber('3'), 3);
        assertEqual(toNumber('3.5'), 3.5);
        assertEqual(toNumber('x', 7), 7);
        assertEqual(toNumber(undefined, 9), 9);
        assertEqual(toNumber(Infinity, 4), 4);
    }),
]);
