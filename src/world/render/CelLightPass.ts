import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * CEL LIGHT
 * ─────────
 * Spells are made of light, and an effects animator draws light as shapes: a hard bright core, a
 * flat band of colour around it, a fainter band beyond, then nothing. Every additive glow a spell
 * makes (its ribbons, domes, bolts, halos) is moved to its own layer; this pass renders that light,
 * hidden behind whatever stands in front of it, into its own buffer, cuts it into those bands, keeps
 * only a whisper of the soft falloff, and adds it back over the frame. The bloom that follows lays the
 * soft halo of digital compositing around the hard cores. With no spell in the air it does nothing.
 *
 * What hides the light is the depth of everything solid (not the mist, the halos or the particles,
 * which light passes through). The scene's own render already lays that depth down before any
 * transparent object, so a marker drawn last among the solid objects copies it, as it stands at that
 * moment, into this pass's buffer: one GPU copy instead of drawing the whole scene a second time.
 * Should the copy be unavailable (a mismatched depth format), the pass draws that depth itself.
 */

/** Layer the spells' additive light renders on. */
export const CEL_LIGHT_LAYER = 5;

export class CelLightPass extends Pass {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly layers = new THREE.Layers();
  private readonly hidden: THREE.Object3D[] = [];
  private readonly savedClear = new THREE.Color();
  /** Drawn last among the solid objects of the scene's own render (see the class comment). */
  private readonly marker = new THREE.Group();
  /** The copy of this frame's solid depth is in `target`. */
  private depthCopied = false;
  /** null: not yet tried; false: the copy failed once and the pass draws the depth itself. */
  private copyWorks: boolean | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    super();
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    // Mipmapped, so the composite can tell a broad flash from a slim shape of light.
    this.target.texture.generateMipmaps = true;
    this.target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tLight: { value: this.target.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse; uniform sampler2D tLight;
        varying vec2 vUv;
        float band(float l, float at, float w) { return smoothstep(at - w, at + w, l); }
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 light = texture2D(tLight, vUv).rgb;
          float l = max(light.r, max(light.g, light.b));
          vec3 hue = light / max(l, 1e-4);
          float w = max(fwidth(l) * 0.75, 0.004);
          // The body of the light and its hot core are cut into flat bands; faint light (halos,
          // washes) stays soft and quiet, as an animator would airbrush it.
          float body = band(l, 0.38, w);
          float core = band(l, 0.6, w);
          vec3 cel = hue * (body * 0.3 + core * 0.55) * 1.15;
          cel = mix(cel, vec3(1.0), band(l, 0.85, w) * 0.5);
          vec3 soft = light * mix(0.62, 0.15, body);
          // A broad flash or beam (light all around, not just here) is drawn as a soft fill: cut into
          // bands it would read as flat bars. Only slim shapes of light take the cel.
          vec3 around = texture2D(tLight, vUv, 6.0).rgb;
          float broad = smoothstep(0.08, 0.22, max(around.r, max(around.g, around.b)));
          vec3 drawn = mix(cel + soft, light, broad);
          gl_FragColor = vec4(base.rgb + drawn, base.a);
        }`,
    });
    // A full-screen composite: no depth test (see InkEdgePass).
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.quad = new FullScreenQuad(this.material);
    this.layers.set(CEL_LIGHT_LAYER);
    this.enabled = false;           // the world enables it while spell light is in the air

    // The marker: an empty mesh (it draws nothing) in a group ordered after every other solid object.
    const probe = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    probe.frustumCulled = false;
    probe.name = 'Cel light depth marker';
    probe.onBeforeRender = (renderer) => this.copySolidDepth(renderer);
    this.marker.renderOrder = Number.MAX_SAFE_INTEGER;
    this.marker.name = 'Cel light depth marker';
    this.marker.add(probe);
    scene.add(this.marker);
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  /** The scene's render reached the marker: every solid object is drawn, nothing transparent yet. */
  private copySolidDepth(renderer: THREE.WebGLRenderer): void {
    if (!this.enabled || this.copyWorks === false) return;
    const from = renderer.getRenderTarget();
    if (!from || from === this.target || from.width !== this.target.width || from.height !== this.target.height) return;
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) { this.copyWorks = false; return; }
    const properties = renderer.properties;
    const source = (properties.get(from) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    let destination = (properties.get(this.target) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!source || Array.isArray(source)) return;
    if (!destination) {
      // The target's framebuffer is made the first time it is bound; bind it once, then return.
      renderer.setRenderTarget(this.target);
      renderer.setRenderTarget(from);
      destination = (properties.get(this.target) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
      if (!destination) return;
    }
    // Errors left over from earlier calls must not be mistaken for the copy's own (checked once).
    if (this.copyWorks === null) for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++);
    const state = renderer.state;
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination);
    gl.blitFramebuffer(0, 0, from.width, from.height, 0, 0, from.width, from.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, source);
    if (this.copyWorks === null) {
      // Checked once: a driver that refuses the copy keeps the original depth pass for good.
      this.copyWorks = gl.getError() === gl.NO_ERROR;
      if (!this.copyWorks) return;
    }
    this.depthCopied = true;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const camLayers = this.camera.layers.mask;
    const background = this.scene.background;
    const override = this.scene.overrideMaterial;
    const clear = renderer.getClearColor(this.savedClear);
    const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;     // the light must land on the depth laid down before it
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    this.scene.background = null;
    if (this.depthCopied) {
      renderer.clear(true, false, false);
    } else {
      renderer.clear(true, true, true);
      // What stands in front hides the light: lay down the depth of everything solid first.
      this.scene.traverseVisible((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if ((o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite || (m && !Array.isArray(m) && (m.transparent || !m.depthWrite))) this.hidden.push(o);
      });
      for (const o of this.hidden) o.visible = false;
      this.scene.overrideMaterial = this.depthOnly;
      renderer.render(this.scene, this.camera);
      this.scene.overrideMaterial = override;
      for (const o of this.hidden) o.visible = true;
      this.hidden.length = 0;
    }
    this.depthCopied = false;
    // Then only the spells' light.
    this.camera.layers.mask = this.layers.mask;
    renderer.render(this.scene, this.camera);
    this.camera.layers.mask = camLayers;
    this.scene.background = background;
    renderer.setClearColor(clear, alpha);
    renderer.autoClear = autoClear;
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.tLight.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.marker.removeFromParent();
    (this.marker.children[0] as THREE.Mesh).geometry.dispose();
    ((this.marker.children[0] as THREE.Mesh).material as THREE.Material).dispose();
    this.target.dispose();
    this.material.dispose();
    this.depthOnly.dispose();
    this.quad.dispose();
  }
}

/** Move a spell's additive light onto the cel-light layer; returns how many things it moved or found. */
export function tagSpellLight(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    const additive = Array.isArray(m) ? m.some((x) => x.blending === THREE.AdditiveBlending) : m.blending === THREE.AdditiveBlending;
    if (!additive) return;
    if (!o.layers.isEnabled(CEL_LIGHT_LAYER) || o.layers.isEnabled(0)) o.layers.set(CEL_LIGHT_LAYER);
    if (o.visible) n++;
  });
  return n;
}
