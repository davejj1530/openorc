// SPDX-License-Identifier: Apache-2.0
// Original OpenOrc prototype, authored from elementary implicit surfaces.
// No Orbkit/XorDev shader source is used in this geometry or lighting.
struct Params {
  time: f32,
  anim: f32,
  inputVol: f32,
  outputVol: f32,
  res: vec2f,
  mouse: vec2f,
  p_form: f32,
  p_energy: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

fn isHollow() -> bool {
  return params.p_form > 0.5 && params.p_form < 1.5;
}

fn corePosition() -> vec3f {
  return vec3f(0.07*sin(params.anim*0.6), 0.06*cos(params.anim*0.45), 0.0);
}

fn turn(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c*v.x - s*v.y, s*v.x + c*v.y);
}

fn objectSpace(world: vec3f) -> vec3f {
  var p = world;
  // One continuous clock; changing state cannot jump the sculpture's pose.
  // The renderer integrates anim's state-dependent speed, so acceleration does
  // not reset orientation. Hollow turns roughly 6–8x faster than the first study.
  let yaw = select(params.time*0.17, params.anim*0.9, isHollow()) + 0.55;
  p = vec3f(turn(p.xz, yaw).x, p.y, turn(p.xz, yaw).y);
  let tumble = select(0.0, 0.18*sin(params.anim*0.55), isHollow());
  let tilted = turn(p.xy, -0.38 + tumble);
  p = vec3f(tilted, p.z);
  let pitch = turn(p.yz, 0.48);
  return vec3f(p.x, pitch);
}

fn sculptureScale() -> f32 {
  let breath = 1.0 + params.p_energy*0.025*sin(params.time*2.6);
  return breath*select(1.0, 1.13, isHollow());
}

fn sculpture(world: vec3f) -> f32 {
  let scale = sculptureScale();
  let p = objectSpace(world)/scale;
  let radius = length(p);
  var distance: f32;

  if (params.p_form < 0.5) {
    // Broad curved ribbons cut from a thick spherical wall.
    let bend = p.y + 0.22*sin(2.8*p.x + params.time*0.22)
      + 0.12*sin(3.1*p.z - params.time*0.15);
    let ribbon = (abs(sin(bend*6.6)) - 0.62)/8.8;
    let wall = abs(radius - 0.88) - 0.105;
    distance = max(wall, ribbon) - 0.018;
  } else if (params.p_form < 1.5) {
    // A low-frequency gyroid opens a continuous, porous spherical shell.
    let q = p*4.05;
    let gyroid = dot(sin(q), cos(q.yzx));
    let pores = (abs(gyroid) - 0.48)/8.2;
    distance = max(abs(radius - 0.84) - 0.14, pores) - 0.018;
  } else {
    // Eight rounded facets separated by fine orthogonal seams.
    let octahedron = dot(abs(p), vec3f(0.57735027)) - 0.78;
    let body = max(radius - 0.97, octahedron) - 0.04;
    let hollow = 0.67 - radius;
    let seams = 0.028 - min(abs(p.x), min(abs(p.y), abs(p.z)));
    distance = max(max(body, hollow), seams) - 0.014;
  }
  return distance*scale;
}

fn normalAt(p: vec3f, epsilon: f32) -> vec3f {
  let e = vec2f(epsilon, 0.0);
  return normalize(vec3f(
    sculpture(p + e.xyy) - sculpture(p - e.xyy),
    sculpture(p + e.yxy) - sculpture(p - e.yxy),
    sculpture(p + e.yyx) - sculpture(p - e.yyx)
  ));
}

fn shade(p: vec3f, n: vec3f) -> vec3f {
  let view = vec3f(0.0, 0.0, 1.0);
  let key = normalize(vec3f(-0.65, 0.9, 1.2));
  let fill = normalize(vec3f(0.9, 0.2, 0.4));
  let rim = normalize(vec3f(0.3, 0.7, -1.0));
  let diffuse = max(dot(n, key), 0.0);
  let side = max(dot(n, fill), 0.0);
  let fresnel = pow(1.0 - max(dot(n, view), 0.0), 3.0);
  var occlusion = 0.0;
  for (var i = 1; i <= 3; i++) {
    let step = f32(i)*0.085;
    occlusion += max(0.0, step - sculpture(p + n*step))/(step*5.0);
  }
  let ao = clamp(1.0 - occlusion, 0.28, 1.0);
  let pearl = vec3f(0.82, 0.835, 0.85);
  let halfKey = normalize(key + view);
  let specular = pow(max(dot(n, halfKey), 0.0), 34.0)*0.7
    + pow(max(dot(n, halfKey), 0.0), 180.0)*0.65;
  let strip = pow(max(dot(reflect(-view, n), normalize(vec3f(-0.6, 1.5, 0.7))), 0.0), 10.0);
  let edge = pow(max(dot(n, rim), 0.0), 2.0)*fresnel;
  var color = pearl*(0.12 + 0.65*diffuse + 0.13*side)*ao;
  color += vec3f(specular + strip*0.24)*mix(0.5, 1.0, ao);
  color += vec3f(0.67, 0.72, 0.78)*edge*0.6;
  // A tiny pearl lift keeps inward surfaces legible at the 36px app size.
  color += vec3f(0.065)*fresnel*ao;
  if (isHollow()) {
    // A quiet, rough silver shell gives the transmitted light room to read.
    // Keep bright highlights concentrated around the source-facing cut edges.
    color *= 0.23;
    let toCore = corePosition() - p;
    let innerFacing = max(dot(n, normalize(toCore)), 0.0);
    // Direct illumination from the enclosed source lights the cut walls while
    // the outside keeps its silver shading. Do not suppress it with exterior AO.
    let coreLight = pow(innerFacing, 1.4)*0.52/(0.55 + dot(toCore, toCore));
    color += vec3f(0.98, 0.985, 1.0)*coreLight;
    return pow(vec3f(1.0) - exp(-color*1.4), vec3f(0.85));
  }
  return pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(0.82));
}

// A finite light source sees the shell's openings as soft apertures. Checking
// two depths keeps the glow attached to real holes through the thick shell.
fn aperture(direction: vec3f, source: vec3f) -> f32 {
  let along = dot(source, direction);
  let sourceSq = dot(source, source);
  let scale = sculptureScale();
  let inner = -along + sqrt(along*along + pow(0.78*scale, 2.0) - sourceSq);
  let outer = -along + sqrt(along*along + pow(0.91*scale, 2.0) - sourceSq);
  let opening = min(sculpture(source + direction*inner), sculpture(source + direction*outer));
  return smoothstep(0.0, 0.065, opening);
}

// Integrate illuminated mist both INSIDE and OUTSIDE the shell. The shell
// occludes the source. A directional emission field forms coherent filaments,
// and forward scattering makes rays facing the viewer brighter than edge haze.
// Stop at the first opaque surface on the view ray.
fn lightVolume(origin: vec3f, end: f32) -> f32 {
  if (!isHollow()) { return 0.0; }
  let start = 1.88;
  let step = max(0.0, min(end, 4.72) - start)/40.0;
  let source = corePosition();
  let scale = sculptureScale();
  var glow = 0.0;
  for (var i = 0; i < 40; i++) {
    let sample = origin - vec3f(0.0, 0.0, start + (f32(i) + 0.5)*step);
    let radius = length(sample);
    let envelope = 1.0 - smoothstep(1.16, 1.42, radius);
    if (envelope < 0.001) { continue; }
    let offset = sample - source;
    let localRadius = radius/scale;
    let enclosed = 1.0 - smoothstep(0.52, 0.80, localRadius);
    // A compact luminous volume gives the source a soft, continuous edge;
    // there is no opaque white ball filling whichever opening faces the eye.
    let sourceDistance = dot(offset, offset);
    let interior = (exp(-sourceDistance*6.0)*0.18 + exp(-sourceDistance*100.0)*3.5)*enclosed;
    var spill = 0.0;
    if (localRadius > 0.20) {
      let direction = normalize(offset);
      let opening = aperture(direction, source);
      let angular = objectSpace(direction);
      // Smooth variation across directions breaks up each aperture's shaft
      // without periodic stripes or near-opaque wedges through the cavity.
      let detail = sin(angular.x*13.0 + sin(angular.y*8.0))
        *sin(angular.y*11.0 + angular.z*5.0)
        *cos(angular.z*9.0 - angular.x*6.0 + params.anim*0.08);
      let filaments = smoothstep(0.20, 0.85, 0.5 + 0.5*detail);
      let anisotropy = 0.55;
      let scattering = (1.0 - anisotropy*anisotropy)
        /pow(1.0 + anisotropy*anisotropy - 2.0*anisotropy*direction.z, 1.5);
      let falloff = exp(-max(localRadius - 0.8, 0.0)*4.2)/(0.45 + radius*radius);
      // Most visible scattering lives beyond the aperture. Inside, the lit
      // walls and compact source preserve depth instead of painted-on bands.
      let exterior = mix(0.20, 2.0, smoothstep(0.68, 1.14, localRadius));
      spill = opening*(0.32 + filaments*0.68)*(0.23 + scattering*0.25)
        *falloff*smoothstep(0.20, 0.72, localRadius)*exterior;
    }
    glow += (interior + spill)*envelope*step;
  }
  return 1.0 - exp(-glow*(3.2 + params.p_energy*0.6));
}

@fragment fn pearl(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Reserve transparent space for Hollow's escaping light within its canvas.
  let viewScale = select(1.28, 1.44, isHollow());
  let screen = (uv*2.0 - 1.0)*vec2f(params.res.x/params.res.y, -1.0)*viewScale;
  let origin = vec3f(screen, 3.3);
  let pixel = 2.0*viewScale/params.res.y;
  let epsilon = max(0.0012, pixel*0.24);
  var travel = 2.1;
  var point = origin;
  var hit = false;
  for (var i = 0; i < 96; i++) {
    point = origin + vec3f(0.0, 0.0, -travel);
    let distance = sculpture(point);
    if (distance < epsilon) {
      hit = true;
      break;
    }
    travel += max(distance*0.68, epsilon*0.35);
    if (travel > 4.5) { break; }
  }
  let glow = lightVolume(origin, travel);
  let radiance = vec3f(0.98, 0.985, 1.0);
  if (!hit) { return vec4f(radiance*glow, glow); }
  let normal = normalAt(point, max(0.0015, pixel*0.16));
  let color = mix(shade(point, normal), radiance, glow);
  return vec4f(color, 1.0);
}
