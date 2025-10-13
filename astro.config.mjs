import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://pba-nation.github.io',
  // base: '/contribution-portal', // Commented out for local development
  integrations: [tailwind()],
  output: 'static',
});