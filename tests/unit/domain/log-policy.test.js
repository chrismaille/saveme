import {
    DEFAULT_LOG_POLICY,
    planLogCleanup,
    sanitizeLogText,
    summarizeLogEntries,
} from '../../../src/domain/log-policy.js';
import {assertEqual, suite, test} from '../../harness.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-01-31T12:00:00Z');

export default suite('domain/log-policy', [
    test('sanitizes key/value secrets without breaking JSON', () => {
        const input = JSON.stringify({
            access_token: 'abc123',
            refresh_token: 'def456',
            password: 'hunter2',
            normal: 'value',
        });
        const output = sanitizeLogText(input);
        assertEqual(output.includes('abc123'), false);
        assertEqual(output.includes('def456'), false);
        assertEqual(output.includes('hunter2'), false);
        assertEqual(JSON.parse(output).access_token, '[REDACTED]');
        assertEqual(JSON.parse(output).normal, 'value');
        assertEqual(sanitizeLogText(input), output);
    }),
    test('sanitizes query strings, bearer tokens and PEM blocks', () => {
        const begin = ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ');
        const end = ['-----END', 'RSA', 'PRIVATE KEY-----'].join(' ');
        const text = [
            'GET https://example.test/cb?code=abcd&state=xyz&ok=1',
            'Authorization: Bearer header.payload.signature',
            begin,
            'c2VjcmV0',
            end,
        ].join('\n');
        const output = sanitizeLogText(text);
        assertEqual(output.includes('abcd'), false);
        assertEqual(output.includes('xyz'), false);
        assertEqual(output.includes('header.payload.signature'), false);
        assertEqual(output.includes('c2VjcmV0'), false);
        assertEqual(output.includes('ok=1'), true);
    }),
    test('sanitizes lowercase config-style secrets and empty input', () => {
        assertEqual(sanitizeLogText('token = abc'), 'token = [REDACTED]');
        assertEqual(sanitizeLogText('client_secret: "s3cr3t"'),
            'client_secret: "[REDACTED]"');
        assertEqual(sanitizeLogText(''), '');
        assertEqual(sanitizeLogText(null), '');
    }),
    test('deletes expired logs and reports freed bytes', () => {
        const entries = [
            {path: '/old.log', size: 100, mtimeMs: NOW - 40 * DAY},
            {path: '/new.log', size: 200, mtimeMs: NOW - DAY},
        ];
        const plan = planLogCleanup(entries, {nowMs: NOW, retentionDays: 30});
        assertEqual(JSON.stringify(plan.paths), JSON.stringify(['/old.log']));
        assertEqual(plan.bytesFreed, 100);
        assertEqual(plan.remainingBytes, 200);
    }),
    test('enforces total size from oldest files while protecting active files', () => {
        const entries = [
            {path: '/a.log', size: 100, mtimeMs: NOW - 10 * DAY},
            {path: '/b.log', size: 100, mtimeMs: NOW - 5 * DAY},
            {path: '/active.log', size: 100, mtimeMs: NOW - 1000},
        ];
        const plan = planLogCleanup(entries, {
            nowMs: NOW,
            retentionDays: 30,
            maxTotalBytes: 150,
        });
        assertEqual(JSON.stringify(plan.paths), JSON.stringify(['/a.log', '/b.log']));
        assertEqual(plan.remainingBytes, 100);
        assertEqual(plan.bytesFreed, 200);
    }),
    test('zero limits disable deletion and summaries group by area', () => {
        const entries = [
            {path: '/a.log', area: 'daemon', size: 100, mtimeMs: NOW - 40 * DAY},
            {path: '/b.log', area: 'jobs', size: 200, mtimeMs: NOW - DAY},
            {path: '/c.log', area: 'jobs', size: 300, mtimeMs: NOW - DAY},
        ];
        const plan = planLogCleanup(entries, {
            nowMs: NOW,
            retentionDays: 0,
            maxTotalBytes: 0,
            protectModifiedWithinMs: 0,
        });
        assertEqual(plan.paths.length, 0);
        const noProtection = planLogCleanup([
            {path: '/old.log', size: 100, mtimeMs: NOW - 10 * DAY},
            {path: '/new.log', size: 100, mtimeMs: NOW - DAY},
        ], {
            nowMs: NOW,
            retentionDays: 30,
            maxTotalBytes: 150,
            protectModifiedWithinMs: Number.NaN,
        });
        assertEqual(noProtection.paths.length, 1);
        const summary = summarizeLogEntries(entries);
        assertEqual(summary.totalBytes, 600);
        assertEqual(summary.files, 3);
        assertEqual(summary.areas.jobs.files, 2);
        assertEqual(summary.areas.jobs.bytes, 500);
        assertEqual(summary.oldest, new Date(NOW - 40 * DAY).toISOString());
        assertEqual(summary.newest, new Date(NOW - DAY).toISOString());
    }),
    test('default policy is explicit', () => {
        assertEqual(DEFAULT_LOG_POLICY.retentionDays, 30);
        assertEqual(DEFAULT_LOG_POLICY.maxTotalBytes, 50 * 1024 * 1024);
    }),
]);
