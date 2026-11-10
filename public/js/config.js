// Base URL of the Snowline server API (empty = same origin as the page). Set in /config.js.
const raw = (typeof window !== 'undefined' && window.SNOWLINE_CONFIG && window.SNOWLINE_CONFIG.apiBase) || '';
export const API_BASE = raw && !raw.endsWith('/') ? raw + '/' : raw;
export const apiUrl = (path) => `${API_BASE}api/${path}`;
