import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://openorc.app",
  output: "static",
  devToolbar: { enabled: false },
  redirects: { "/architecture": "/docs/", "/docs/processes": "/docs/how-it-works/", "/docs/providers": "/docs/agents/", "/docs/conversations": "/docs/threads/" },
});
