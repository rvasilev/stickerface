// Bootstrap: wires UI + canvas + store. Single module entry from index.html.
// ui.js owns the singleton (window.__stickerface) — this import is the only
// instantiation path in the app.

import { app } from './ui.js';

export { app };
