// Vercel serverless entrypoint — runs the same handler as `node server.js`.
// vercel.json rewrites /api/:path* here; static files are served by Vercel directly.
const { handleRequest } = require("../server");

module.exports = handleRequest;
