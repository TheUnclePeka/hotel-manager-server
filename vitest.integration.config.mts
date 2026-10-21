import {defineConfig} from 'vitest/config';
if(!process.env.DATABASE_URL || !process.env.ADMIN_PASSWORD) throw new Error('Use npm run test:security (isolated database).');
export default defineConfig({test:{include:['tests/*.integration.ts'],fileParallelism:false,testTimeout:30000,hookTimeout:60000}});
