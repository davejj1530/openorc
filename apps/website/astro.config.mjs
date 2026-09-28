import { defineConfig } from "astro/config";

export default defineConfig({ site: "https://openorc.app", output: "static", devToolbar: { enabled: false }, redirects: { "/architecture": "/docs/" } });
