import * as THREE from 'three';
import { EYE_HEIGHT, moveOnGround, SPAWN, terrainHeight, type Obstacle } from './spatial.ts';

export function worldInputBlocked():boolean {
  const c=document.body.classList;
  return document.hidden||c.contains('is-intro')||c.contains('is-menu')||c.contains('is-paused')||c.contains('is-cutscene')
    ||document.querySelector<HTMLElement>('#spellbook')?.hidden===false;
}

/** The Kindler's view, with footsteps on the trail and brief looks toward approaching creatures. */
export class CasterView {
  private readonly base = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private advanceTime = 0;
  private advanceDuration = 0;
  private stride = 0;
  private hop = 0;
  private lookTime = 0;
  private lookAngle = 0;
  private angle = 0;
  private dip = 0;

  constructor(private readonly camera:THREE.PerspectiveCamera,canvas:HTMLCanvasElement){
    canvas.tabIndex=0;canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label','The Hushwood. Hold up your hands to aim and cast spells as you move through the forest.');
    canvas.style.cursor='default';
    this.reset();
  }
  reset():void {
    this.base.set(SPAWN.x,terrainHeight(SPAWN.x,SPAWN.z)+EYE_HEIGHT,SPAWN.z);
    this.camera.position.copy(this.base);
    this.camera.lookAt(0,1.2,-12);this.camera.updateMatrixWorld(true);
    this.advanceTime = this.advanceDuration = this.lookTime = this.angle = this.dip = 0;
  }

  get canLookAside(): boolean { return this.lookTime <= 0 && Math.abs(this.angle) < 0.09 && this.advanceTime >= this.advanceDuration; }

  advance(distance: number, duration: number, stepOver: boolean): void {
    this.advanceTime = 0;
    this.advanceDuration = duration;
    this.stride = distance / duration;
    this.hop = stepOver ? 1 : 0;
  }

  lookAside(angle: number): void {
    this.lookAngle = THREE.MathUtils.clamp(angle, -1.03, 1.03);
    this.lookTime = 4.2;
  }

  update(dt: number, obstacles: readonly Obstacle[], reduced: boolean, groundThreat: number): void {
    const old = this.advanceTime;
    this.advanceTime = Math.min(this.advanceDuration, old + dt);
    const moving = this.advanceTime < this.advanceDuration;
    if (this.advanceTime > old) {
      const sway = !reduced ? Math.sin(this.advanceTime * 4) * 0.16 : 0;
      moveOnGround(this.base, sway * dt, -this.stride * (this.advanceTime - old), obstacles);
    }
    this.lookTime = Math.max(0, this.lookTime - dt);
    this.angle = THREE.MathUtils.damp(this.angle, this.lookTime > 0.85 ? this.lookAngle : 0, reduced ? 3.2 : 5.2, dt);
    this.dip = THREE.MathUtils.damp(this.dip, groundThreat, 3.5, dt);
    const phase = this.advanceTime / Math.max(0.01, this.advanceDuration);
    const motion = !reduced && moving ? Math.sin(Math.PI * phase) : 0;
    const step = this.advanceTime * (this.hop ? 15 : 10);
    this.camera.position.copy(this.base);
    this.camera.position.y += Math.cos(step) * 0.065 * motion + this.hop * Math.max(0, 1 - Math.abs(phase - 0.54) * 8) ** 2 * 0.31 * motion;
    this.pivot.set(Math.sin(this.angle) * 20, -0.38 - this.dip * 3.6, -Math.cos(this.angle) * 20).add(this.camera.position);
    this.camera.lookAt(this.pivot);
    this.camera.rotateZ(motion * Math.sin(step * 0.5) * 0.018);
    this.camera.updateMatrixWorld(true);
  }

  dispose():void{}
}
