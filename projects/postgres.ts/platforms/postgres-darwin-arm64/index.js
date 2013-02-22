import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export default require('./lib/postgres-darwin-arm64.node');
