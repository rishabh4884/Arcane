import * as THREE from 'three';
import { INK, INK_NOISE } from './InkPaint.ts';
import { FIGURE_LIGHT } from '../rig/figureMaterial.ts';
import { SPELL_LIGHT_GLSL, SPELL_LIGHTS } from '../LanternLighting.ts';

/** Paint belongs to the wood, not to a camera. Broad cool shadows, warm lit planes and restrained
 * leaf marks share the cast's light while keeping the background's softer edge hierarchy. */
export function forestPaint(time: {value:number}, tint: {value:THREE.Color}, tree = true, luminous = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'Surface-painted forest', vertexColors: true,
    defines: { TREE: tree ? 1 : 0, LUMINOUS: luminous ? 1 : 0 },
    uniforms: {...INK, ...SPELL_LIGHTS, uAir: FIGURE_LIGHT.uAir, uTime: time, uTint: tint},
    vertexShader: /* glsl */`
      varying vec3 vColor; varying vec3 vWorld; varying vec3 vRest; varying vec3 vNormalW;
      varying float vLeaf;
      uniform float uTime;
      void main() {
        vColor = color.rgb;
        #ifdef USE_COLOR_ALPHA
          vLeaf = color.a;
        #else
          vLeaf = 0.0;
        #endif
        vec4 local = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          // Inverse scale before rotation: rocks have non-uniform instance scales.
          mat3 im = mat3(instanceMatrix);
          n /= vec3(dot(im[0],im[0]), dot(im[1],im[1]), dot(im[2],im[2]));
          n = im * n;
        #endif
        vec4 world = modelMatrix * local;
        vRest = world.xyz;
        #if TREE
          float h = max(position.y - 3.0, 0.0);
          float phase = world.x * 0.09 + world.z * 0.07;
          float gust = sin(uTime * 0.67 + phase) * 0.7 + sin(uTime * 1.11 + phase * 1.8) * 0.3;
          world.xz += vec2(gust, sin(uTime * 0.51 + phase)) * h * h * 0.0009;
        #endif
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * n);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uFillDir; uniform vec3 uMoonDir; uniform vec3 uLitColor; uniform vec3 uMidColor;
      uniform vec3 uShadeColor; uniform vec3 uRimColor; uniform vec3 uAir; uniform vec3 uTint;
      varying vec3 vColor; varying vec3 vWorld; varying vec3 vRest; varying vec3 vNormalW; varying float vLeaf;
      ${INK_NOISE}
      ${SPELL_LIGHT_GLSL}
      void main() {
        vec3 n = normalize(vNormalW);
        float leaf = smoothstep(0.25, 0.75, vLeaf);
        // A low-frequency brush only breaks the boundary of a painted shadow. No screen grain.
        float brush = ipNoise(vRest * vec3(1.1, 0.55, 1.1)) - 0.5;
        float light = dot(n, uFillDir) * 0.5 + 0.5 + brush * 0.07;
        float aa = max(fwidth(light) * 1.5, 0.035);
        float mid = smoothstep(0.43 - aa, 0.43 + aa, light);
        float top = smoothstep(0.76 - aa, 0.76 + aa, light);
        vec3 base = vColor;
        vec3 shade = mix(uShadeColor, uMidColor, 0.22);
        vec3 col = base * mix(shade, mix(uMidColor, uLitColor, top), mid);
        // Foliage is grouped into overlapping lit shelves, not outlined one leaf at a time.
        float up = smoothstep(0.0, 0.6, n.y);
        col *= 1.0 + leaf * up * 0.12;
        float dab = ipNoise(vRest * vec3(1.6, 3.4, 1.6));
        float dabAA = max(fwidth(dab), 0.025);
        float leafStroke = smoothstep(0.56 - dabAA, 0.56 + dabAA, dab);
        col = mix(col, col * 1.16 + base * uLitColor * 0.035, leafStroke * leaf * (0.18 + up * 0.42));
        float rim = smoothstep(0.58, 0.78, dot(n, uMoonDir));
        col = mix(col, base * uLitColor + uRimColor * 0.055, rim * 0.35);
        col += base * spellIllumination(vWorld) * 1.2;
        #if LUMINOUS
          col = base * 1.4;
        #else
          float dist = length(vWorld - cameraPosition);
          float air = (1.0 - exp(-max(dist - 8.0, 0.0) / 62.0)) * 0.92;
          col = mix(col, uAir, min(air, 0.88));
        #endif
        gl_FragColor = vec4(col * uTint, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}
