export function versionTimestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function parseVersionTimestamp(name) {
    const match = String(name).replace(/\/$/, '').match(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-.*)?$/);
    if (!match)
        return null;
    const y = match[1];
    const month = match[2];
    const day = match[3];
    const hour = match[4];
    const minute = match[5];
    const second = match[6];
    const date = new Date(Number(y), Number(month) - 1, Number(day),
        Number(hour), Number(minute), Number(second));
    return date;
}
