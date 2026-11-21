const RAD = Math.PI / 180;

function dayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / 86_400_000);
}

/**
 * Local sunset time (HH:MM) for a coordinate and date.
 *
 * Uses the NOAA approximation. `timezoneOffsetMinutes` follows the JavaScript
 * convention (minutes west of UTC) so tests can use a fixed timezone.
 */
export function sunsetTime(latitude, longitude, date = new Date(),
    timezoneOffsetMinutes = date.getTimezoneOffset()) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    const tz = Number(timezoneOffsetMinutes);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(tz))
        return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
        return null;

    const day = dayOfYear(date);
    const b = (360 / 365) * (day - 81) * RAD;
    const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) -
        1.5 * Math.sin(b);
    const declination = -23.44 * RAD * Math.cos((360 / 365) * (day + 10) * RAD);
    const latRad = lat * RAD;
    const cosHour = (Math.sin(-0.833 * RAD) -
        Math.sin(latRad) * Math.sin(declination)) /
        (Math.cos(latRad) * Math.cos(declination));
    if (!Number.isFinite(cosHour) || cosHour < -1 || cosHour > 1)
        return null;

    const hourAngle = Math.acos(cosHour) / RAD;
    const localNoon = 720 - 4 * lon - tz - equationOfTime;
    const minutes = ((Math.round(localNoon + 4 * hourAngle) % 1440) + 1440) % 1440;
    const hours = Math.floor(minutes / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
