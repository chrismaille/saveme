const VALID_REMOTE_NAME = /^[0-9A-Za-z_. -]+$/;

export function sanitizeRemoteName(value) {
    const text = String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^0-9A-Za-z_. -]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text || 'Cloud connection';
}

export function isValidRemoteName(value) {
    const text = String(value ?? '').trim();
    return Boolean(text) && VALID_REMOTE_NAME.test(text);
}
