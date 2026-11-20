const INVALID_FOLDER_CHARS = /[/\\]/;

function hasControlCharacters(value) {
    for (const char of value) {
        const code = char.codePointAt(0);
        if (code < 0x20 || code === 0x7f)
            return true;
    }
    return false;
}

export function normalizeRemoteFolderName(value) {
    return String(value ?? '').trim();
}

export function isValidRemoteFolderName(value) {
    const name = normalizeRemoteFolderName(value);
    return Boolean(name) &&
        name !== '.' &&
        name !== '..' &&
        !INVALID_FOLDER_CHARS.test(name) &&
        !hasControlCharacters(name);
}
