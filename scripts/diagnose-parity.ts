#!/usr/bin/env ts-node
/**
 * Parity diagnostics CLI tool
 * Compares PAPER vs WATCH trades in CSV files
 */
import * as path from 'path';
import { matchPaperToWatch, printParityDiagnostics } from '../src/services/parityDiagnostics';

const args = process.argv.slice(2);
const logDirIndex = args.indexOf('--log-dir');
const logDir = logDirIndex >= 0 && args[logDirIndex + 1] 
    ? args[logDirIndex + 1]
    : 'logs/Live prices';

console.log(`Analyzing CSV files in: ${path.resolve(logDir)}`);
console.log('');

try {
    const stats = matchPaperToWatch(logDir, 2000);
    printParityDiagnostics(stats);
} catch (error) {
    console.error('Error running parity diagnostics:', error);
    process.exit(1);
}

