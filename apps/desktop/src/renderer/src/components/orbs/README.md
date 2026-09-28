# Hollow conversation indicator

Hollow is an original Apache-2.0 shader. `hollow/pearl.wgsl` holds its geometry and lighting; `hollow/variant.ts` defines uniforms and idle/thinking presets. `AgentOrb` lazy-loads `hollow/index.tsx` at 36px and retains a glyph fallback when WebGPU is unavailable or reduced motion is requested.

The geometry uses elementary implicit-surface mathematics and analytical lighting. No restricted Orb 01/31 shader body was copied or adapted. The original shader source carries an Apache-2.0 SPDX identifier.

## Shared runtime

`renderer.ts` and `canvas.tsx` were adapted from the [shadercn](https://www.shadercn.run) registry and retain its MIT license. Preserve [the upstream notice](../../../../../../../licenses/shadercn-MIT.txt).

When resynchronizing the runtime, preserve these local integration changes:

- Remove Next.js-only `"use client"` directives that Rollup cannot place.
- Retain the bounds-justified typed-array assertions required by `noUncheckedIndexedAccess`.
- Preserve animation/device cleanup, spring transitions, activity clocks, and visibility/reduced-motion behavior.

The original shader and the separately licensed renderer retain their respective terms. See [third-party notices](../../../../../../../THIRD_PARTY_NOTICES.md).
