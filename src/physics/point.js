/**
 * Verlet point primitive used by soft-body particles and pointer pinning.
 *
 * Stores current and previous positions, collision radius, and temporary pin
 * state so bodies can be integrated without an explicit velocity vector.
 *
 * @author Ilya Tsivilskiy
 * @see Point
 * @see SoftBody
 * @see clearGrab
 */

const pointApp = window.Anjellyka;

/**
 * A single Verlet particle.
 *
 * The particle stores its current and previous positions rather than an
 * explicit velocity vector. User interaction temporarily pins particles to the
 * pointer.
 */
class Point {
  /**
   * @param {number} x Initial x-coordinate.
   * @param {number} y Initial y-coordinate.
   * @param {number} radius Collision/render radius.
   */
  constructor(x, y, radius) {
    this.x = x;
    this.y = y;
    this.oldX = x;
    this.oldY = y;
    this.radius = radius;
    this.pinned = false;
    this.pinX = x;
    this.pinY = y;
    this.pinVX = 0;
    this.pinVY = 0;
  }
}

pointApp.Point = Point;
