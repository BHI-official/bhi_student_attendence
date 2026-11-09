// Runs server actions outside Next: swaps Next's request plumbing for small stand-ins,
// for both require() and import.
const path = require("node:path");
const Module = require("node:module");
const stubs = {
  "server-only": "server-only.cjs",
  "next/headers": "next-headers.cjs",
  "next/cache": "next-cache.cjs",
  "next/navigation": "next-navigation.cjs",
};
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (stubs[request]) return path.join(__dirname, "stubs", stubs[request]);
  return original.call(this, request, ...rest);
};
Module.register?.(
  "data:text/javascript," + encodeURIComponent(`
    const map = ${JSON.stringify(Object.fromEntries(Object.entries(stubs).map(([k, v]) => [k, require("node:url").pathToFileURL(path.join(__dirname, "stubs", v)).href])))};
    export async function resolve(s, c, next) { return map[s] ? { url: map[s], shortCircuit: true } : next(s, c); }
  `),
);
