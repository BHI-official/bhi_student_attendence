class Redirect extends Error { constructor(to) { super(`REDIRECT:${to}`); this.to = to; } }
exports.Redirect = Redirect;
exports.redirect = (to) => { throw new Redirect(to); };
exports.notFound = () => { throw new Error("NOT_FOUND"); };
exports.useRouter = () => ({});
