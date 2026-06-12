import { resolve } from 'node:path';

export const APP_NAME = 'Miru';
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.MIRU_WEB_PORT ?? process.env.PORT ?? 4242);
export const DEFAULT_CWD = resolve(process.env.MIRU_WEB_CWD ?? process.cwd());
export const PI_COMMAND = process.env.PI_COMMAND ?? 'pi';
export const USER_SHELL = process.env.SHELL ?? '/bin/sh';
export const TERMINAL_BUFFER_LIMIT = 512 * 1024;
export const INITIAL_COLS = 120;
export const INITIAL_ROWS = 32;
