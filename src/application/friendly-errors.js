import {t} from '../i18n.js';

const NETWORK_RE = new RegExp([
    'no such host',
    'server misbehaving',
    'dial tcp',
    'network is unreachable',
    'no route to host',
    'connection refused',
    'connection reset',
    'i/o timeout',
    'tls handshake',
    'temporary failure in name resolution',
    'proxyconnect',
    'context deadline exceeded',
    'failed to get root',
].join('|'), 'i');

const AUTH_RE = new RegExp([
    'invalid_grant',
    'access_denied',
    'unauthorized',
    'forbidden',
    '\\b401\\b',
    '\\b403\\b',
    'oauth',
    're-?auth',
    'token (expired|invalid)',
    'drive_id',
    'drive_type',
    'reconfigure this backend',
].join('|'), 'i');

const SOURCE_RE = new RegExp([
    'error reading source directory',
    'source.*(not found|does not exist|unavailable|not a directory|disappeared)',
    'source volume',
].join('|'), 'i');

const DESTINATION_RE = new RegExp([
    'destination.*(not found|does not exist|unavailable|not a directory)',
    'destination volume',
].join('|'), 'i');

const DISK_RE = new RegExp([
    'not enough (free )?disk space',
    'no space left',
    'filesystem.*full',
    'disk.*full',
    'quota exceeded',
].join('|'), 'i');

const PERMISSION_RE = /permission denied|operation not permitted|access is denied/i;
const DELETE_GUARD_RE = /delete guard|delete limit|max.*delete/i;
const EMPTY_SOURCE_RE = /source is empty/i;

export function friendlyErrorMessage(message) {
    const text = String(message ?? '').trim();
    if (!text)
        return t('Operation failed. Check Logs & Debug for technical details.');
    if (NETWORK_RE.test(text))
        return t('No internet connection. Check your network and try again.');
    if (/onedrive|drive_id|drive_type|microsoft/i.test(text))
        return t('No permission to access OneDrive. Reconnect the account in Accounts.');
    if (AUTH_RE.test(text))
        return t('Cloud access was denied. Reconnect the account in Accounts.');
    if (SOURCE_RE.test(text))
        return t('Source folder not found. Check that the disk or folder is available.');
    if (DESTINATION_RE.test(text))
        return t('Destination folder not found. Check that the disk or folder is available.');
    if (DISK_RE.test(text))
        return t('Not enough free space at the destination.');
    if (PERMISSION_RE.test(text))
        return t('Permission denied. Check the folder permissions.');
    if (DELETE_GUARD_RE.test(text))
        return t('Deletion blocked by the safety limit. Review the job settings.');
    if (EMPTY_SOURCE_RE.test(text))
        return t('The source is empty. The run was stopped to prevent data loss.');
    return text;
}

export function friendlyError(error) {
    if (!error)
        return friendlyErrorMessage(error);
    return friendlyErrorMessage(error.message ?? String(error));
}
