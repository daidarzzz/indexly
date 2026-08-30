// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  devToolbar: {
    enabled: false,
  },
  // Modifica esto para que sea tu nuevo subdominio:
  site: 'https://indexly.daida.net',
  
  // OJO: Si tenías la línea "base", elimínala o déjala solo con una barra:
  base: '/',
});
