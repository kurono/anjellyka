/**
 * Inter-body narrow-phase collision detection and positional response.
 *
 * Builds triangle-based body contact tests, computes exit corrections for
 * penetrating points, and scales collision passes with scene complexity.
 *
 * @author Ilya Tsivilskiy
 * @see getTriangleExitCorrection
 * @see resolvePointsAgainstTriangles
 * @see resolveBodyPairCollisions
 * @see resolveInterBodyCollisions
 * @see getEffectiveCollisionPasses
 */

(function () {
  const app = window.Anjellyka;
  const {
    clamp,
    boundsOverlap,
    closestPointOnSegment,
    getGridCellKey,
    pointInTriangleByArea,
  } = app;

  /**
   * Computes a position correction that pushes a point out of a triangle.
   *
   * @param {Point} point Penetrating particle.
   * @param {Point} a Triangle vertex.
   * @param {Point} b Triangle vertex.
   * @param {Point} c Triangle vertex.
   * @returns {Vec2}
   */
  function getTriangleExitCorrection(point, a, b, c) {
    const ab = closestPointOnSegment(point, a, b);
    const bc = closestPointOnSegment(point, b, c);
    const ca = closestPointOnSegment(point, c, a);

    let bestPoint = ab;
    let bestDistance = Math.hypot(point.x - ab.x, point.y - ab.y);

    const bcDistance = Math.hypot(point.x - bc.x, point.y - bc.y);
    if (bcDistance < bestDistance) {
      bestDistance = bcDistance;
      bestPoint = bc;
    }

    const caDistance = Math.hypot(point.x - ca.x, point.y - ca.y);
    if (caDistance < bestDistance) {
      bestDistance = caDistance;
      bestPoint = ca;
    }

    let dirX = bestPoint.x - point.x;
    let dirY = bestPoint.y - point.y;
    let length = Math.hypot(dirX, dirY);

    if (length < 1e-6) {
      const centroidX = (a.x + b.x + c.x) / 3;
      const centroidY = (a.y + b.y + c.y) / 3;
      dirX = point.x - centroidX;
      dirY = point.y - centroidY;
      length = Math.hypot(dirX, dirY);
    }

    if (length < 1e-6) {
      dirX = 0;
      dirY = -1;
      length = 1;
    }

    const depth = clamp(
      bestDistance + point.radius * 0.85 + 0.35,
      point.radius * 0.45,
      point.radius + 10
    );

    return {
      x: (dirX / length) * depth,
      y: (dirY / length) * depth,
    };
  }

  /**
   * Distributes an inter-body collision correction between the source particle and
   * the penetrated triangle's vertices.
   *
   * @param {Point} sourcePoint Penetrating particle.
   * @param {Point} a Triangle vertex.
   * @param {Point} b Triangle vertex.
   * @param {Point} c Triangle vertex.
   * @param {Vec2} correction Exit vector computed for the penetration.
   */
  function applyTriangleCollisionCorrection(sourcePoint, a, b, c, correction) {
    let movableCount = 0;
    if (!a.pinned) movableCount += 1;
    if (!b.pinned) movableCount += 1;
    if (!c.pinned) movableCount += 1;

    const sourceShare = sourcePoint.pinned ? 0 : movableCount ? 0.76 : 1;
    const triangleShare = movableCount ? 1 - sourceShare : 0;

    if (sourceShare > 0) {
      sourcePoint.x += correction.x * sourceShare;
      sourcePoint.y += correction.y * sourceShare;
    }

    if (triangleShare > 0) {
      const perPointShare = triangleShare / movableCount;

      if (!a.pinned) {
        a.x -= correction.x * perPointShare;
        a.y -= correction.y * perPointShare;
      }

      if (!b.pinned) {
        b.x -= correction.x * perPointShare;
        b.y -= correction.y * perPointShare;
      }

      if (!c.pinned) {
        c.x -= correction.x * perPointShare;
        c.y -= correction.y * perPointShare;
      }
    }
  }

  /**
   * Tests every source particle against nearby target triangles and resolves the
   * first penetration found for each point.
   *
   * @param {SoftBody} sourceBody Body whose particles are tested.
   * @param {SoftBody} targetBody Body whose boundary triangles define solid space.
   * @returns {boolean} Whether any correction was applied.
   */
  function resolvePointsAgainstTriangles(sourceBody, targetBody) {
    const sourcePoints = sourceBody.points;
    const targetBoundary = targetBody.boundary;
    const targetTriangles = targetBody.triangles;
    const targetBounds = targetBody.bounds;
    const targetTriangleGrid = targetBody.triangleGrid;
    const cellSize = targetBody.gridCellSize;
    let changed = false;

    for (let i = 0; i < sourcePoints.length; i += 1) {
      const point = sourcePoints[i];
      const radius = point.radius;

      if (
        point.x + radius < targetBounds.minX ||
        point.x - radius > targetBounds.maxX ||
        point.y + radius < targetBounds.minY ||
        point.y - radius > targetBounds.maxY
      ) {
        continue;
      }

      if (targetBody.triangleQueryStamp > 1000000000) {
        targetBody.triangleQueryStamp = 0;
        for (let t = 0; t < targetTriangles.length; t += 1) {
          targetTriangles[t].stamp = 0;
        }
      }

      targetBody.triangleQueryStamp += 1;
      const queryStamp = targetBody.triangleQueryStamp;
      const minCellX = Math.floor((point.x - radius) / cellSize);
      const maxCellX = Math.floor((point.x + radius) / cellSize);
      const minCellY = Math.floor((point.y - radius) / cellSize);
      const maxCellY = Math.floor((point.y + radius) / cellSize);
      let resolved = false;

      for (let cellY = minCellY; cellY <= maxCellY && !resolved; cellY += 1) {
        for (let cellX = minCellX; cellX <= maxCellX && !resolved; cellX += 1) {
          const bucket = targetTriangleGrid.get(getGridCellKey(cellX, cellY));
          if (!bucket) {
            continue;
          }

          for (let bucketIndex = 0; bucketIndex < bucket.length; bucketIndex += 1) {
            const triangle = targetTriangles[bucket[bucketIndex]];
            if (triangle.stamp === queryStamp) {
              continue;
            }

            triangle.stamp = queryStamp;

            if (
              point.x + radius < triangle.minX ||
              point.x - radius > triangle.maxX ||
              point.y + radius < triangle.minY ||
              point.y - radius > triangle.maxY
            ) {
              continue;
            }

            const a = targetBoundary[triangle.a];
            const b = targetBoundary[triangle.b];
            const c = targetBoundary[triangle.c];

            if (!pointInTriangleByArea(point, a, b, c)) {
              continue;
            }

            const correction = getTriangleExitCorrection(point, a, b, c);
            applyTriangleCollisionCorrection(point, a, b, c, correction);
            changed = true;
            resolved = true;
            break;
          }
        }
      }
    }

    return changed;
  }

  /**
   * Resolves mutual penetrations between two bodies.
   *
   * @param {SoftBody} bodyA
   * @param {SoftBody} bodyB
   */
  function resolveBodyPairCollisions(bodyA, bodyB) {
    if (!boundsOverlap(bodyA.bounds, bodyB.bounds)) {
      return;
    }

    if (!bodyA.triangles.length || !bodyB.triangles.length) {
      return;
    }

    const changedA = resolvePointsAgainstTriangles(bodyA, bodyB);
    if (changedA) {
      bodyA.refreshCollisionCache();
      bodyB.refreshCollisionCache();
    }

    const changedB = resolvePointsAgainstTriangles(bodyB, bodyA);
    if (changedB) {
      bodyA.refreshCollisionCache();
      bodyB.refreshCollisionCache();
    }
  }

  /**
   * Resolves collisions for every unordered body pair in the scene.
   *
   * @param {SoftBody[]} bodies
   */
  function resolveInterBodyCollisions(bodies) {
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        resolveBodyPairCollisions(bodies[i], bodies[j]);
      }
    }
  }

  /**
   * Increases the effective number of collision passes as body count grows.
   *
   * @param {SimulationSettings} settings
   * @param {number} bodyCount
   * @returns {number}
   */
  function getEffectiveCollisionPasses(settings, bodyCount) {
    let passes = settings.collisionPasses;

    if (bodyCount >= 6) {
      passes += 1;
    }

    if (bodyCount >= 10) {
      passes += 1;
    }

    return Math.min(8, passes);
  }

  Object.assign(app, {
    getTriangleExitCorrection,
    applyTriangleCollisionCorrection,
    resolvePointsAgainstTriangles,
    resolveBodyPairCollisions,
    resolveInterBodyCollisions,
    getEffectiveCollisionPasses,
  });
})();
