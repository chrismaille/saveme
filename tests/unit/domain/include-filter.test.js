import {
    isPathIncluded,
    normalizeIncludePath,
    normalizeIncludes,
} from '../../../src/domain/include-filter.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('domain/include-filter', [
    test('normalizes relative include paths', () => {
        assertEqual(normalizeIncludePath('/docs/'), 'docs');
        assertEqual(normalizeIncludePath('./photos'), 'photos');
        assertEqual(normalizeIncludePath('a\\b'), 'a/b');
        assertEqual(normalizeIncludePath('../secret'), '');
        assertEqual(normalizeIncludePath('bad\nname'), '');
        assertEqual(JSON.stringify(normalizeIncludes([
            '/docs/', 'docs', '', '../x', 'file.txt',
        ])), JSON.stringify(['docs', 'file.txt']));
        assertEqual(JSON.stringify(normalizeIncludes(null)), '[]');
    }),
    test('matches selected files and descendants', () => {
        const job = {
            type: 'sync',
            filters: {include: ['docs', 'photo.jpg']},
        };
        assertEqual(isPathIncluded(job, 'docs'), true);
        assertEqual(isPathIncluded(job, 'docs/a/b.txt'), true);
        assertEqual(isPathIncluded(job, 'photo.jpg'), true);
        assertEqual(isPathIncluded(job, 'photo.jpg/raw'), true);
        assertEqual(isPathIncluded(job, 'documents/a.txt'), false);
        assertEqual(isPathIncluded(job, ''), false);
        assertEqual(isPathIncluded({...job, filters: {include: []}}, 'anything'), true);
        assertEqual(isPathIncluded({...job, type: 'backup'}, 'anything'), true);
    }),
]);
