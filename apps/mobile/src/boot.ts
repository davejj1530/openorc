import "./startup";
import { install } from "react-native-quick-crypto";
import { config } from "zod";

// Buffer and the Node crypto API, natively. The connection to the Mac encrypts with them.
install();
// zod decides when each object schema is built whether to compile a fast parser with `new Function`. On Hermes the
// compile makes the first parse several times slower, so it stays off. This runs before anything imports
// @openorc/protocol and builds its schemas.
config({ jitless: true });
