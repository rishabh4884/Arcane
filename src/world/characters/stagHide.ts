import * as THREE from 'three';

/** The old hide rests over the sacrum, gathers against the haunches, then hangs in heavy folds.
 * Two deliberate losses are cut into the hem; no random holes through its load-bearing saddle.
 * A closed shell gives the lifted hems a painted underside instead of disappearing on a turn. */
export function stagHideGeometry(): THREE.BufferGeometry {
  const across = 48, along = 48, count = (across + 1) * (along + 1);
  const p: number[] = [], grad: number[] = [], idx: number[] = [];
  for (let side = 0; side < 2; side++) for (let j = 0; j <= along; j++) for (let i = 0; i <= across; i++) {
    const u = j / along, v = i / across * 2 - 1, w = Math.abs(v), sign = v < 0 ? -1 : 1;
    // The sacrum supports a rounded saddle; its edge rolls into hanging weight, not a right angle.
    const shoulder = 0.39 + 0.055 * Math.sin(u * Math.PI);
    const a = Math.min(1, w / 0.69) * Math.PI / 2;
    const hanging = Math.max(0, (w - 0.50) / 0.50);
    // Broad diagonal gathers fan from the pelvic attachments. Their crests open toward the hem.
    const phase = u * Math.PI * 8.5 + sign * 0.65 + hanging * (0.8 - u * 1.4);
    const fold = Math.sin(phase) * 0.075 + Math.sin(u * Math.PI * 3 + sign) * 0.04;
    const weight = Math.pow(hanging, 0.8);
    const loss = 0.19 * Math.exp(-(((u - (v < 0 ? 0.24 : 0.76)) / 0.065) ** 2));
    // Rounded lobes and a lifted rear corner break the old straight rectangle.
    const scallop = 0.055 * Math.sin(u * Math.PI * 5 + sign * 0.7);
    const drop = (v < 0 ? 0.86 : 0.72) * (0.56 + 0.44 * Math.sin(u * Math.PI)) - loss + scallop;
    const curl = Math.pow(hanging, 5) * (0.045 + 0.035 * Math.sin(phase));
    const x = Math.sin(a) * shoulder * sign + sign * (fold * weight + curl);
    const y = 2.32 + Math.sin(u * Math.PI) * 0.055 - u * 0.11 - (1 - Math.cos(a)) * 0.21 - hanging * drop;
    // Set the free front edge behind the exposed ribs; gathered corners lean back under gravity.
    const z = -0.42 - u * 1.05 - hanging * 0.12 * (1 - u) + Math.sin(v * Math.PI) * 0.025;
    p.push(x - (side ? sign * 0.009 * w : 0), y - (side ? 0.012 * (1 - w * 0.6) : 0), z);
    // Authored broad paint follows the folds. No speckle, procedural grain or random pinholes.
    const valley = Math.max(0, -Math.sin(phase));
    const crest = Math.max(0, Math.sin(phase));
    grad.push(THREE.MathUtils.clamp(0.18 + hanging * 0.19 + valley * weight * 0.44 - crest * weight * 0.16 + (side ? 0.22 : 0), 0, 1));
  }
  for (let j = 0; j < along; j++) for (let i = 0; i < across; i++) {
    const a = j * (across + 1) + i, b = a + 1, d = a + across + 1, e = d + 1;
    idx.push(a, b, d, b, e, d, a + count, d + count, b + count, b + count, d + count, e + count);
  }
  const rim: number[] = [];
  for (let i = 0; i <= across; i++) rim.push(i);
  for (let j = 1; j <= along; j++) rim.push(j * (across + 1) + across);
  for (let i = across - 1; i >= 0; i--) rim.push(along * (across + 1) + i);
  for (let j = along - 1; j > 0; j--) rim.push(j * (across + 1));
  for (let i = 0; i < rim.length; i++) { const a = rim[i], b = rim[(i + 1) % rim.length]; idx.push(a, a + count, b, b, a + count, b + count); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('grad', new THREE.Float32BufferAttribute(grad, 1));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
