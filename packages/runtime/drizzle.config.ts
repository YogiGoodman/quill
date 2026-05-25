import { defineConfig } from 'drizzle-kit';

/** Drizzle-kit configuration. `generate` emits SQL migrations from walSchema. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/walSchema.ts',
  out: './drizzle',
  dbCredentials: {
    url: 'quill.db',
  },
});
