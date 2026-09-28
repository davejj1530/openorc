import { RuntimeLoader } from "@rive-app/canvas";
import wasmUrl from "@rive-app/canvas/rive.wasm?url";

// Every Rive animation shares one runtime loader. It loads the WASM that ships
// with the app and never falls back to a CDN copy.
RuntimeLoader.setWasmUrl(wasmUrl);
RuntimeLoader.setWasmFallbackUrl(null);

export { Alignment, Fit, Layout, Rive } from "@rive-app/canvas";
