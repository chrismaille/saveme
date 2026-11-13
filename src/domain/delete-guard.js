import {DeleteGuardError} from './errors.js';

export function deleteLimit(total, {
    maxDeletePercent = 10,
    maxDeleteMinimum = 10,
} = {}) {
    const count = Number(total);
    if (!Number.isFinite(count))
        return null;
    const percent = Number(maxDeletePercent);
    const minimum = Number(maxDeleteMinimum);
    const safePercent = Number.isFinite(percent) ? percent : 10;
    const safeMinimum = Number.isFinite(minimum) ? minimum : 10;
    return Math.min(count, Math.max(safeMinimum, Math.floor(count * safePercent / 100)));
}

export function evaluateDeleteGuard({
    deletes = 0,
    total = 0,
    maxDeletePercent = 10,
    maxDeleteMinimum = 10,
    force = false,
} = {}) {
    const allowed = deleteLimit(total, {maxDeletePercent, maxDeleteMinimum});
    const count = Number(deletes);
    const percent = Number(maxDeletePercent);
    return {
        allowed,
        blocked: allowed !== null && !force && count > allowed,
        deletes: count,
        total: Number(total),
        percent: Number.isFinite(percent) ? percent : 10,
    };
}

export function assertDeleteAllowed(options) {
    const result = evaluateDeleteGuard(options);
    if (result.blocked)
        throw new DeleteGuardError(result.deletes, result.allowed, result.total, result.percent);
    return result;
}
