export function planChanges({source, changes, files, logger}) {
    const upserts = new Set();
    const dirUpserts = new Set();
    const deletes = new Set();
    const dirDeletes = new Set();

    for (const change of changes) {
        const rel = files.relativePath(source, change.path);
        if (!rel)
            continue;
        if (rel.includes('\n') || rel.includes('\r')) {
            logger?.warn(`Ignoring path with newline: ${JSON.stringify(rel)}`);
            continue;
        }
        const exists = files.exists(change.path);
        let kind = change.kind;
        if (!exists && (kind === 'upsert' || kind === 'dir-upsert'))
            continue;
        if (exists && (kind === 'delete' || kind === 'dir-delete'))
            kind = kind === 'delete' ? 'upsert' : 'dir-upsert';
        if (kind === 'upsert' || kind === 'dir-upsert') {
            const type = files.queryType(change.path);
            if (type === 'directory')
                dirUpserts.add(rel);
            else if (type === 'file')
                upserts.add(rel);
            continue;
        }
        if (kind === 'delete') {
            deletes.add(rel);
            continue;
        }
        if (kind === 'dir-delete')
            dirDeletes.add(rel);
    }

    const byDepth = (a, b) => a.split('/').length - b.split('/').length;
    const topDirsUp = [...dirUpserts].sort(byDepth).filter((dir, _index, all) =>
        !all.some(other => other !== dir && dir.startsWith(`${other}/`)));
    for (const dir of topDirsUp) {
        for (const item of [...upserts]) {
            if (item.startsWith(`${dir}/`))
                upserts.delete(item);
        }
        for (const item of [...deletes]) {
            if (item.startsWith(`${dir}/`))
                deletes.delete(item);
        }
        for (const item of [...dirDeletes]) {
            if (item.startsWith(`${dir}/`))
                dirDeletes.delete(item);
        }
    }

    const topDirsDelete = [...dirDeletes].sort(byDepth).filter((dir, _index, all) =>
        !all.some(other => other !== dir && dir.startsWith(`${other}/`)));
    for (const dir of topDirsDelete) {
        for (const item of [...deletes]) {
            if (item.startsWith(`${dir}/`))
                deletes.delete(item);
        }
    }

    return {
        upserts: [...upserts].sort(),
        dirUpserts: topDirsUp.sort(),
        deletes: [...deletes].sort(),
        dirDeletes: topDirsDelete.sort(),
    };
}
