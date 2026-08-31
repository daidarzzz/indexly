// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  integrations: [sitemap()],
  devToolbar: {
    enabled: false,
  },
  // Modifica esto para que sea tu nuevo subdominio:
  site: 'https://indexly.daida.net',
  
  // OJO: Si tenías la línea "base", elimínala o déjala solo con una barra:
  base: '/',
});
