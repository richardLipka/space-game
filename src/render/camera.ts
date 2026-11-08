import type { Vec2 } from "../sim/core/vec2";

export type CameraMode = "follow" | "follow-target" | "free";
export const CAMERA_MODES: readonly CameraMode[] = ["follow-target", "follow", "free"];

/** 2D camera (spec §10.1). World y is up; screen y is down. `zoom` is pixels per metre. */
export class Camera {
  center: Vec2 = { x: 0, y: 0 };
  zoom = 8;
  /** User zoom multiplier applied on top of auto-fit in follow-target mode. */
  userZoom = 1;
  mode: CameraMode = "follow-target";
  width = 800;
  height = 600;

  static readonly MIN_ZOOM = 0.005;
  static readonly MAX_ZOOM = 80;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  zoomBy(factor: number): void {
    if (this.mode === "follow-target") this.userZoom = clamp(this.userZoom * factor, 0.05, 20);
    else this.zoom = clamp(this.zoom * factor, Camera.MIN_ZOOM, Camera.MAX_ZOOM);
  }

  /**
   * @param ship  controlled ship position (CoM)
   * @param radius controlled ship bounding radius (m)
   * @param target optional target position
   */
  update(ship: Vec2 | null, radius: number, target: Vec2 | null, dt: number): void {
    if (this.mode === "free" || !ship) return;
    let desiredCenter = ship;
    let desiredZoom = this.zoom;
    if (this.mode === "follow-target" && target) {
      // Zooming in past the fit slides the view toward the controlled ship so it never leaves the screen.
      const w = 0.5 * Math.min(1, 1 / this.userZoom);
      desiredCenter = { x: ship.x + (target.x - ship.x) * w, y: ship.y + (target.y - ship.y) * w };
      const spanX = Math.abs(ship.x - target.x) + radius * 4;
      const spanY = Math.abs(ship.y - target.y) + radius * 4;
      const fit = Math.min((this.width * 0.8) / spanX, (this.height * 0.8) / spanY);
      desiredZoom = clamp(fit * this.userZoom, Camera.MIN_ZOOM, Camera.MAX_ZOOM);
    } else if (this.mode === "follow-target") {
      // No target: frame the ship at a comfortable size.
      desiredZoom = clamp(
        (Math.min(this.width, this.height) * 0.12 * this.userZoom) / Math.max(radius, 1),
        Camera.MIN_ZOOM,
        Camera.MAX_ZOOM,
      );
    }
    const k = 1 - Math.exp(-dt * 8);
    this.center = {
      x: this.center.x + (desiredCenter.x - this.center.x) * k,
      y: this.center.y + (desiredCenter.y - this.center.y) * k,
    };
    if (this.mode === "follow-target") this.zoom = this.zoom * Math.pow(desiredZoom / this.zoom, k);
  }

  pan(dxPx: number, dyPx: number): void {
    this.center = { x: this.center.x - dxPx / this.zoom, y: this.center.y + dyPx / this.zoom };
  }

  worldToScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.center.x) * this.zoom + this.width / 2,
      y: -(p.y - this.center.y) * this.zoom + this.height / 2,
    };
  }

  screenToWorld(p: Vec2): Vec2 {
    return {
      x: (p.x - this.width / 2) / this.zoom + this.center.x,
      y: -(p.y - this.height / 2) / this.zoom + this.center.y,
    };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
