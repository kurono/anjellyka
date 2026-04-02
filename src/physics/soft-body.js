/**
 * Soft-body solver, constraint projection, and boundary collision handling.
 *
 * Updates deformable bodies with Verlet integration, distance and area
 * preservation, spatial collision caches, and stage-boundary response.
 *
 * @author Ilya Tsivilskiy
 * @see SoftBody
 * @see Point
 * @see solveDistanceConstraints
 * @see solveAreaConstraint
 * @see refreshCollisionCache
 */

const softBodyApp = window.Anjellyka;
const { clamp, polygonArea, clonePolygon, triangulatePolygon, getGridCellKey } = softBodyApp;

/**
 * Deformable body made of particles and constraints.
 *
 * Boundary particles define the visible polygon and are also used for area
 * preservation and collision triangulation. Interior particles and extra
 * constraints improve stability and reduce collapse.
 */
class SoftBody {
  /**
   * @param {Point[]} points All particles in the body.
   * @param {number} boundaryCount Number of leading particles that belong to the boundary loop.
   * @param {Constraint[]} constraints Distance constraints between particles.
   * @param {BodyColor} color Fill and stroke colors for rendering.
   */
  constructor(points, boundaryCount, constraints, color) {
    this.points = points;
    this.boundaryCount = boundaryCount;
    this.boundary = points.slice(0, boundaryCount);
    this.constraints = constraints;
    this.pointRadius = points[0] ? points[0].radius : 0;
    this.gridCellSize = clamp(this.pointRadius * 12, 28, 72);
    this.triangleGrid = new Map();
    this.triangleQueryStamp = 0;
    this.triangles = triangulatePolygon(clonePolygon(this.boundary)).map(([a, b, c]) => ({
      a,
      b,
      c,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      stamp: 0,
    }));
    this.gradientCache = Array.from({ length: boundaryCount }, () => ({ x: 0, y: 0 }));
    this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    this.targetArea = Math.abs(polygonArea(this.boundary));
    this.color = color;
    this.refreshCollisionCache();
  }

  /**
   * Returns the boundary polygon used for rendering and area-based operations.
   *
   * @returns {Point[]}
   */
  boundaryPoints() {
    return this.boundary;
  }

  /**
   * Rebuilds the body's cached broad-phase collision data.
   */
  refreshCollisionCache() {
    const points = this.points;
    const triangles = this.triangles;
    const boundary = this.boundary;
    const triangleGrid = this.triangleGrid;
    const cellSize = this.gridCellSize;
    const padding = this.pointRadius + 8;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    triangleGrid.clear();

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }

    this.bounds.minX = minX - padding;
    this.bounds.maxX = maxX + padding;
    this.bounds.minY = minY - padding;
    this.bounds.maxY = maxY + padding;

    for (let i = 0; i < triangles.length; i += 1) {
      const triangle = triangles[i];
      const a = boundary[triangle.a];
      const b = boundary[triangle.b];
      const c = boundary[triangle.c];

      triangle.minX = Math.min(a.x, b.x, c.x);
      triangle.maxX = Math.max(a.x, b.x, c.x);
      triangle.minY = Math.min(a.y, b.y, c.y);
      triangle.maxY = Math.max(a.y, b.y, c.y);

      const minCellX = Math.floor(triangle.minX / cellSize);
      const maxCellX = Math.floor(triangle.maxX / cellSize);
      const minCellY = Math.floor(triangle.minY / cellSize);
      const maxCellY = Math.floor(triangle.maxY / cellSize);

      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
          const key = getGridCellKey(cellX, cellY);
          let bucket = triangleGrid.get(key);

          if (!bucket) {
            bucket = [];
            triangleGrid.set(key, bucket);
          }

          bucket.push(i);
        }
      }
    }
  }

  /**
   * Advances all free particles by one substep using damped Verlet integration.
   *
   * @param {number} dt Substep duration in seconds.
   * @param {SimulationSettings} settings Current solver settings.
   */
  integrate(dt, settings) {
    const dtSq = dt * dt;
    const maxFrameSpeed = 1600 * dt;
    const points = this.points;

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      if (point.pinned) {
        point.x = point.pinX;
        point.y = point.pinY;
        point.oldX = point.pinX - point.pinVX * dt;
        point.oldY = point.pinY - point.pinVY * dt;
        continue;
      }

      let vx = (point.x - point.oldX) * settings.drag;
      let vy = (point.y - point.oldY) * settings.drag;
      const speed = Math.hypot(vx, vy);

      if (speed > maxFrameSpeed && speed > 0) {
        const scale = maxFrameSpeed / speed;
        vx *= scale;
        vy *= scale;
      }

      point.oldX = point.x;
      point.oldY = point.y;
      point.x += vx + (settings.gravityX + settings.windX) * dtSq;
      point.y += vy + (settings.gravityY + settings.windY) * dtSq;
    }
  }

  /**
   * Iteratively projects all distance constraints toward their rest lengths.
   *
   * @param {SimulationSettings} settings Current solver settings.
   */
  solveDistanceConstraints(settings) {
    const constraints = this.constraints;
    const points = this.points;

    for (let i = 0; i < constraints.length; i += 1) {
      const constraint = constraints[i];
      const a = points[constraint.a];
      const b = points[constraint.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distanceValue = Math.hypot(dx, dy);

      if (!distanceValue) {
        continue;
      }

      const error = (distanceValue - constraint.restLength) / distanceValue;
      const stiffness = settings.stiffness * constraint.stiffness;
      const weightA = a.pinned ? 0 : 1;
      const weightB = b.pinned ? 0 : 1;
      const totalWeight = weightA + weightB;

      if (!totalWeight) {
        continue;
      }

      const correctionX = dx * error * stiffness;
      const correctionY = dy * error * stiffness;

      if (weightA) {
        a.x += correctionX * (weightA / totalWeight);
        a.y += correctionY * (weightA / totalWeight);
      }

      if (weightB) {
        b.x -= correctionX * (weightB / totalWeight);
        b.y -= correctionY * (weightB / totalWeight);
      }
    }
  }

  /**
   * Applies a global area-preservation correction to the boundary polygon.
   *
   * @param {SimulationSettings} settings Current solver settings.
   */
  solveAreaConstraint(settings) {
    const boundary = this.boundary;
    if (boundary.length < 3 || settings.pressure <= 0) {
      return;
    }

    const currentArea = polygonArea(boundary);
    const gradients = this.gradientCache;
    let gradientMagnitudeSum = 0;

    for (let i = 0; i < boundary.length; i += 1) {
      const prev = boundary[(i - 1 + boundary.length) % boundary.length];
      const next = boundary[(i + 1) % boundary.length];
      const gx = 0.5 * (next.y - prev.y);
      const gy = 0.5 * (prev.x - next.x);
      gradients[i].x = gx;
      gradients[i].y = gy;

      if (!boundary[i].pinned) {
        gradientMagnitudeSum += gx * gx + gy * gy;
      }
    }

    if (gradientMagnitudeSum < 1e-6) {
      return;
    }

    const lambda = clamp(
      ((this.targetArea - currentArea) / gradientMagnitudeSum) * settings.pressure,
      -12,
      12
    );

    for (let i = 0; i < boundary.length; i += 1) {
      const point = boundary[i];
      if (point.pinned) {
        continue;
      }

      point.x += gradients[i].x * lambda;
      point.y += gradients[i].y * lambda;
    }
  }

  /**
   * Resolves collisions against the rectangular canvas bounds.
   *
   * Tangential velocity is additionally damped on wall contact to create
   * friction against the domain sides.
   *
   * @param {{ width: number, height: number }} bounds Canvas-space bounds.
   * @param {SimulationSettings} settings Current solver settings.
   */
  collide(bounds, settings) {
    const points = this.points;
    const tangentialRetention = settings.wallFriction;

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      if (point.pinned) {
        continue;
      }

      const vx = point.x - point.oldX;
      const vy = point.y - point.oldY;

      if (point.x < point.radius) {
        point.x = point.radius;
        point.oldX = point.x + vx * settings.bounce;
        point.oldY = point.y - vy * tangentialRetention;
      } else if (point.x > bounds.width - point.radius) {
        point.x = bounds.width - point.radius;
        point.oldX = point.x + vx * settings.bounce;
        point.oldY = point.y - vy * tangentialRetention;
      }

      if (point.y < point.radius) {
        point.y = point.radius;
        point.oldY = point.y + vy * settings.bounce;
        point.oldX = point.x - vx * tangentialRetention;
      } else if (point.y > bounds.height - point.radius) {
        point.y = bounds.height - point.radius;
        point.oldY = point.y + vy * settings.bounce;
        point.oldX = point.x - vx * tangentialRetention;
      }
    }
  }

  /**
   * Convenience wrapper for advancing a single body through a frame step.
   *
   * @param {number} dt Frame duration in seconds.
   * @param {SimulationSettings} settings Current solver settings.
   * @param {{ width: number, height: number }} bounds Canvas-space bounds.
   */
  update(dt, settings, bounds) {
    const subDt = dt / settings.substeps;

    for (let substep = 0; substep < settings.substeps; substep += 1) {
      this.integrate(subDt, settings);

      for (let iteration = 0; iteration < settings.iterations; iteration += 1) {
        this.solveDistanceConstraints(settings);
        this.solveAreaConstraint(settings);
        this.collide(bounds, settings);
      }
    }
  }
}

softBodyApp.SoftBody = SoftBody;
