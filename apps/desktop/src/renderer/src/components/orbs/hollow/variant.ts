// SPDX-License-Identifier: Apache-2.0
import { d } from "typegpu";
import type { OrbVariant } from "../renderer";
import shader from "./pearl.wgsl?raw";

export const hollowOrb: OrbVariant = {
  key: "hollow",
  label: "Hollow",
  note: "Original OpenOrc shader. Apache-2.0.",
  shader,
  uniforms: d.struct({
    time: d.f32,
    anim: d.f32,
    inputVol: d.f32,
    outputVol: d.f32,
    res: d.vec2f,
    mouse: d.vec2f,
    p_form: d.f32,
    p_energy: d.f32,
  }),
  params: [
    { key: "form", label: "Form", min: 0, max: 2, step: 1, default: 1 },
    { key: "energy", label: "Energy", min: 0, max: 1, step: 0.01, default: 0 },
  ],
  colors: [],
  statePresets: { idle: { energy: 0 }, thinking: { energy: 1 }, speaking: { energy: 1 } },
};
