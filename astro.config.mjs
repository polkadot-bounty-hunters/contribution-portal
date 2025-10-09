import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://pba-nation.github.io',
  base: '/contribution-portal',
  integrations: [tailwind()],
  output: 'static',
});