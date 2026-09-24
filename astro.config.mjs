import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';
import partytown from '@astrojs/partytown';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://quotes.elhellal.com',
  integrations: [
    react(),
    partytown({ config: { forward: ['dataLayer.push'] } }),
    sitemap({ filter: (page) => !page.includes('/404') }),
  ],
  adapter: cloudflare(),
});
