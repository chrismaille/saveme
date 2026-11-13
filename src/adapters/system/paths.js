import {joinPath} from '../../util.js';
import * as paths from '../../paths.js';

export class SystemPaths {
    filtersDir() {
        return paths.filtersDir();
    }

    logsDir(jobId = null) {
        return paths.logsDir(jobId);
    }

    tmpDir() {
        return paths.tmpDir();
    }

    join(...parts) {
        return joinPath.apply(null, parts);
    }
}
