// The liquid under the glass: a slow domain-warped fluid, drawn by one fragment shader.

export const MAX_RIPPLES = 8;

/**
 * The brightest the liquid may get, as WCAG relative luminance. Light text sits
 * straight on it, so this cap is what keeps that text readable; globals.css
 * depends on the number.
 */
export const MAX_LUMINANCE = 0.2;

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_tilt;
uniform float u_breath;   // 0..1, waiting for a payment
uniform float u_calm;     // 0..1, paid
uniform float u_flood;    // seconds since the paid wave began, negative when there is none
uniform vec3 u_rip[${MAX_RIPPLES}];  // x, y, age in seconds (negative = unused)

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float ridge(vec2 p) { return 1.0 - abs(2.0 * noise(p) - 1.0); }
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 s = (uv - 0.5) * vec2(aspect, 1.0);   // screen space, ripples live here
  float t = u_time;

  // Ripples push the liquid outward and carry a little light.
  vec2 push = vec2(0.0);
  float glint = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    float age = u_rip[i].z;
    if (age < 0.0) continue;
    vec2 d = s - u_rip[i].xy;
    float dist = length(d);
    float radius = 0.03 + age * 0.34;
    float fade = exp(-age * 1.1) * smoothstep(2.6, 1.8, age);
    float band = exp(-pow((dist - radius) * 15.0, 2.0));
    float crest = sin((dist - radius) * 70.0);
    push += (d / max(dist, 0.001)) * crest * band * fade * 0.03;
    glint += pow(max(crest, 0.0), 2.0) * band * fade;
  }

  // The liquid sits below the glass, so it slides against the tilt.
  vec2 p = s + push - u_tilt * vec2(0.11, -0.11);
  float r0 = length(s);
  p *= 1.0 + u_breath * 0.035 * sin(t * 1.1);

  vec2 q = vec2(fbm(p * 1.25 + vec2(0.0, t * 0.045)),
                fbm(p * 1.25 + vec2(5.2, 1.3) - t * 0.035));
  vec2 r = vec2(fbm(p * 1.5 + 2.6 * q + vec2(1.7, 9.2) + t * 0.06),
                fbm(p * 1.5 + 2.6 * q + vec2(8.3, 2.8) - t * 0.05));
  float f = fbm(p * 1.3 + 3.2 * r);

  // The paid wave: calm spreads from the centre behind a bright front.
  float calm = u_calm;
  float front = 0.0;
  if (u_flood >= 0.0) {
    float radius = u_flood * 0.45;
    calm *= smoothstep(radius, radius - 0.3, r0);
    front = exp(-pow((r0 - radius) * 7.0, 2.0)) * exp(-u_flood * 0.7);
  }

  // Light through water: two ridged fields cross and leave a net of bright threads.
  vec2 w = p * 1.5 + 2.4 * r;
  float net = ridge(w * 1.7 + vec2(t * 0.035, 0.0)) * ridge(w * 2.6 + vec2(7.1, -t * 0.03));
  float thread = pow(net, 7.0);
  float halo = pow(net, 1.6);

  // Linear-light palette.
  vec3 ink   = vec3(0.001, 0.005, 0.010);
  vec3 deep  = vec3(0.002, 0.030, 0.055);
  vec3 teal  = vec3(0.000, 0.130, 0.200);
  vec3 amber = vec3(1.000, 0.520, 0.020);
  vec3 coral = vec3(1.000, 0.160, 0.070);
  vec3 moss  = vec3(0.010, 0.190, 0.100);
  vec3 gold  = vec3(0.560, 0.820, 0.140);

  vec3 mid = mix(teal, moss, calm);
  vec3 light = mix(amber, gold, calm);

  float depth = smoothstep(0.25, 0.8, f + 0.3 * r.x);
  vec3 col = mix(ink, deep, smoothstep(0.1, 0.5, f));
  col = mix(col, mid, depth * depth);
  // Where the warp gathers, the light pools; elsewhere only the threads carry it.
  float pool = smoothstep(0.42, 0.85, r.x * 1.2 + 0.2 * f - 0.25 * q.y);
  float lit = (0.25 + 0.75 * pool) * (1.0 - 0.4 * calm);
  col += light * (thread * 2.2 + halo * 0.03) * lit;
  float ember = smoothstep(0.55, 0.9, r.y * q.x * 2.6);
  col += coral * ember * (0.05 + thread * 0.9) * (1.0 - calm);

  col *= 1.0 + u_breath * 0.6 * (0.5 + 0.5 * sin(t * 1.1)) * exp(-r0 * 1.6);
  col += light * glint * 0.8;
  col += gold * front * 0.8;
  col *= 1.0 - 0.4 * smoothstep(0.35, 1.0, r0);

  // Never brighter than the cap, so light text on top stays readable.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= min(1.0, ${MAX_LUMINANCE.toFixed(3)} / max(lum, 0.0001));

  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;  // dither out banding
  gl_FragColor = vec4(col, 1.0);
}
`;

export type Frame = {
  time: number;
  tiltX: number;
  tiltY: number;
  breath: number;
  calm: number;
  flood: number;
  /** x, y, age triples. */
  ripples: Float32Array;
};

/** Returns a draw function, or null when WebGL is not available. */
export function createLiquid(canvas: HTMLCanvasElement): ((frame: Frame) => void) | null {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });
  if (!gl) return null;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vert = compile(gl.VERTEX_SHADER, VERT);
  const frag = compile(gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!vert || !frag || !program) return null;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const res = u('u_res');
  const time = u('u_time');
  const tilt = u('u_tilt');
  const breath = u('u_breath');
  const calm = u('u_calm');
  const flood = u('u_flood');
  const rip = u('u_rip');

  return (frame) => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(res, canvas.width, canvas.height);
    gl.uniform1f(time, frame.time);
    gl.uniform2f(tilt, frame.tiltX, frame.tiltY);
    gl.uniform1f(breath, frame.breath);
    gl.uniform1f(calm, frame.calm);
    gl.uniform1f(flood, frame.flood);
    gl.uniform3fv(rip, frame.ripples);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}
