import type { InputStream } from "../../data/schemas/inputs";
import { degToRad, vec2 } from "../core/vec2";
import type { ControlIntent } from "../flight/controller";
import type { World } from "../world";

/**
 * Plays a recorded input stream into a world. Each frame sets a ship's persistent intent
 * (thrust/rotate/faceAngle) from its tick onward; `speedKill` and `eject` are one-shot events on that tick.
 * Call `apply(world)` before every `world.step()`.
 */
export class InputPlayer {
  private next = 0;

  constructor(private readonly stream: InputStream) {}

  apply(world: World): void {
    const frames = this.stream.frames;
    while (this.next < frames.length && frames[this.next]!.tick <= world.tick) {
      const f = frames[this.next++]!;
      const intent: ControlIntent = {
        thrust: vec2(f.intent.thrust[0], f.intent.thrust[1]),
        rotate: f.intent.rotate,
        faceAngle: f.intent.faceAngle !== undefined ? degToRad(f.intent.faceAngle) : undefined,
        speedKill: f.intent.speedKill,
      };
      world.setIntent(f.ship, intent);
      const ship = world.getShip(f.ship);
      for (const uid of f.intent.eject ?? []) ship.requestEject(uid);
      ship.weaponCommand = {
        trigger: f.intent.fire ?? false,
        aimPoint: f.intent.aim ? vec2(f.intent.aim[0], f.intent.aim[1]) : null,
        selected: new Set(f.intent.groups ?? [1]),
        targetId: ship.weaponCommand.targetId,
      };
    }
  }

  runWith(world: World, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.apply(world);
      world.step();
    }
  }
}
