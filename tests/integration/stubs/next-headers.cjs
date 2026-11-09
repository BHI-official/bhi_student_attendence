// One cookie jar; tests clear it and sign in as different people.
const g = globalThis;
g.__jar ??= new Map();
exports.cookies = async () => ({
  get: (name) => (g.__jar.has(name) ? { name, value: g.__jar.get(name) } : undefined),
  set: (name, value) => { g.__jar.set(name, value); },
  delete: (name) => { g.__jar.delete(name); },
});
exports.headers = async () => new Map();
