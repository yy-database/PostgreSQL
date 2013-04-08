// Nifty project configuration for PostgreSQL (hybrid cargo + pnpm).
import { defineConfig } from '@doki-land/nifty';

export default defineConfig({
    trust: {
        npm: {
            repo: 'yy-database/PostgreSQL',
            file: 'publish-npm.yml',
            environment: 'NPM_PUBLISH',
        },
    },
});
