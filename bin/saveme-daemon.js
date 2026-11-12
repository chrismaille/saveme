#!/usr/bin/env -S gjs -m

import system from 'system';
import {main} from '../src/daemon.js';

try {
    system.exit(main());
} catch (e) {
    printerr(`saveme-daemon: ${e.message}`);
    if (e.stack)
        printerr(e.stack);
    system.exit(1);
}
