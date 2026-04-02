/**
 * Geometry primitives, hit tests, triangulation, and shared math helpers.
 *
 * Provides polygon area and winding helpers, distance and bounds queries, path
 * simplification and resampling, palette utilities, and ear-clipping support.
 *
 * @author Ilya Tsivilskiy
 * @see polygonArea
 * @see pointInPolygon
 * @see simplifyPath
 * @see resampleClosedPath
 * @see triangulatePolygon
 */

(function () {
  const app = window.Anjellyka;
  const { state } = app;

  /**
   * Computes the signed area of a polygon with the shoelace formula.
   *
   * Positive area indicates counter-clockwise winding.
   *
   * @param {Vec2[]} points Polygon vertices.
   * @returns {number}
   */
  function polygonArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      area += current.x * next.y - current.y * next.x;
    }
    return area * 0.5;
  }

  /**
   * Ensures a polygon is counter-clockwise, reversing it when necessary.
   *
   * @param {Vec2[]} points Polygon vertices to normalize in place.
   * @returns {Vec2[]}
   */
  function ensureCounterClockwise(points) {
    if (polygonArea(points) < 0) {
      points.reverse();
    }
    return points;
  }

  /**
   * Returns the Euclidean distance between two 2D points.
   *
   * @param {Vec2} a
   * @param {Vec2} b
   * @returns {number}
   */
  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /**
   * Clamps a scalar to the inclusive range `[min, max]`.
   *
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Linearly interpolates between two scalars.
   *
   * @param {number} start
   * @param {number} end
   * @param {number} t Interpolation factor in `[0, 1]`.
   * @returns {number}
   */
  function lerp(start, end, t) {
    return start + (end - start) * t;
  }

  /**
   * Returns twice the signed area of a triangle via the 2D cross product.
   *
   * @param {Vec2} a
   * @param {Vec2} b
   * @param {Vec2} c
   * @returns {number}
   */
  function triangleSignedDoubleArea(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  /**
   * Returns the unsigned area of a triangle.
   *
   * @param {Vec2} a
   * @param {Vec2} b
   * @param {Vec2} c
   * @returns {number}
   */
  function triangleArea(a, b, c) {
    return Math.abs(triangleSignedDoubleArea(a, b, c)) * 0.5;
  }

  /**
   * Tests whether a point lies inside a triangle using the area-sum identity.
   *
   * @param {Vec2} point Query point.
   * @param {Vec2} a Triangle vertex.
   * @param {Vec2} b Triangle vertex.
   * @param {Vec2} c Triangle vertex.
   * @param {number} [toleranceScale=0.0015] Relative tolerance factor.
   * @returns {boolean}
   */
  function pointInTriangleByArea(point, a, b, c, toleranceScale = 0.0015) {
    const area2 = Math.abs(triangleSignedDoubleArea(a, b, c));
    const areaSum2 =
      Math.abs(triangleSignedDoubleArea(point, a, b)) +
      Math.abs(triangleSignedDoubleArea(point, b, c)) +
      Math.abs(triangleSignedDoubleArea(point, c, a));
    const tolerance = Math.max(0.4, area2 * toleranceScale);
    return Math.abs(areaSum2 - area2) <= tolerance;
  }

  /**
   * Makes a shallow copy of polygon coordinates.
   *
   * @param {Vec2[]} points
   * @returns {Vec2[]}
   */
  function clonePolygon(points) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }

  /**
   * Builds a hashable string key for a Cartesian collision-grid cell.
   *
   * @param {number} cellX
   * @param {number} cellY
   * @returns {string}
   */
  function getGridCellKey(cellX, cellY) {
    return `${cellX}:${cellY}`;
  }

  /**
   * Creates a distinct body color from an index using a golden-angle hue offset.
   *
   * @param {number} index
   * @returns {BodyColor}
   */
  function createBodyColor(index) {
    const hue = (index * 137.508) % 360;
    const stroke = `hsl(${hue.toFixed(1)} 82% 70%)`;
    const fill = `hsl(${hue.toFixed(1)} 78% 62% / 0.26)`;
    return { fill, stroke };
  }

  /**
   * Reserves and returns the next automatically generated body color.
   *
   * @returns {BodyColor}
   */
  function takeNextBodyColor() {
    const color = createBodyColor(state.nextColorIndex);
    state.nextColorIndex += 1;
    return color;
  }

  /**
   * Tests whether a point is inside a simple polygon with the ray-casting method.
   *
   * @param {Vec2} point Query point.
   * @param {Vec2[]} polygon Polygon vertices.
   * @returns {boolean}
   */
  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;

      const intersects =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 1e-6) + xi;

      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Returns the shortest distance from a point to a line segment.
   *
   * @param {Vec2} point Query point.
   * @param {Vec2} a Segment start.
   * @param {Vec2} b Segment end.
   * @returns {number}
   */
  function distanceToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;

    if (!lengthSq) {
      return distance(point, a);
    }

    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    const closestX = a.x + dx * t;
    const closestY = a.y + dy * t;
    return Math.hypot(point.x - closestX, point.y - closestY);
  }

  /**
   * Returns the minimum distance from a point to any polygon edge.
   *
   * @param {Vec2} point Query point.
   * @param {Vec2[]} polygon Polygon vertices.
   * @returns {number}
   */
  function distanceToPolygonEdges(point, polygon) {
    let min = Infinity;
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      min = Math.min(min, distanceToSegment(point, a, b));
    }
    return min;
  }

  /**
   * Removes consecutive points that are closer than a chosen threshold.
   *
   * @param {Vec2[]} path Input path.
   * @param {number} minDistance Minimum accepted spacing.
   * @returns {Vec2[]}
   */
  function simplifyPath(path, minDistance) {
    if (path.length < 2) {
      return path.slice();
    }

    const simplified = [path[0]];
    for (let i = 1; i < path.length; i += 1) {
      if (distance(path[i], simplified[simplified.length - 1]) >= minDistance) {
        simplified.push(path[i]);
      }
    }
    return simplified;
  }

  /**
   * Resamples a closed polygon so the boundary vertices are distributed more
   * uniformly along arc length.
   *
   * @param {Vec2[]} points Input polygon.
   * @param {number} spacing Target boundary spacing.
   * @returns {Vec2[]}
   */
  function resampleClosedPath(points, spacing) {
    if (points.length < 3) {
      return points.slice();
    }

    const closed = points.concat([points[0]]);
    const resampled = [];

    for (let i = 0; i < closed.length - 1; i += 1) {
      const start = closed[i];
      const end = closed[i + 1];
      const segmentLength = distance(start, end);
      const count = Math.max(1, Math.round(segmentLength / spacing));

      for (let step = 0; step < count; step += 1) {
        const t = step / count;
        resampled.push({
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t,
        });
      }
    }

    return ensureCounterClockwise(simplifyPath(resampled, spacing * 0.5));
  }

  /**
   * Computes an axis-aligned bounding box for a point set.
   *
   * @param {Vec2[]} points
   * @returns {Bounds}
   */
  function getPolygonBounds(points) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }

    return { minX, maxX, minY, maxY };
  }

  /**
   * Computes an AABB and expands it by an optional padding amount.
   *
   * @param {Vec2[]} points
   * @param {number} [padding=0]
   * @returns {Bounds}
   */
  function getPointsBounds(points, padding = 0) {
    const bounds = getPolygonBounds(points);
    return {
      minX: bounds.minX - padding,
      maxX: bounds.maxX + padding,
      minY: bounds.minY - padding,
      maxY: bounds.maxY + padding,
    };
  }

  /**
   * Returns whether two axis-aligned bounding boxes overlap.
   *
   * @param {Bounds} a
   * @param {Bounds} b
   * @returns {boolean}
   */
  function boundsOverlap(a, b) {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
  }

  /**
   * Projects a point onto a segment and returns the closest point plus segment
   * parameter.
   *
   * @param {Vec2} point Query point.
   * @param {Vec2} a Segment start.
   * @param {Vec2} b Segment end.
   * @returns {{ x: number, y: number, t: number }}
   */
  function closestPointOnSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;

    if (!lengthSq) {
      return { x: a.x, y: a.y, t: 0 };
    }

    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    return {
      x: a.x + dx * t,
      y: a.y + dy * t,
      t,
    };
  }

  /**
   * Triangulates a simple polygon with a lightweight ear-clipping algorithm.
   *
   * @param {Vec2[]} points
   * @returns {number[][]}
   */
  function triangulatePolygon(points) {
    if (points.length < 3) {
      return [];
    }

    const indices = Array.from({ length: points.length }, (_, index) => index);
    if (polygonArea(points) < 0) {
      indices.reverse();
    }

    const triangles = [];
    const maxIterations = points.length * points.length;
    let guard = 0;

    while (indices.length > 3 && guard < maxIterations) {
      let earFound = false;

      for (let i = 0; i < indices.length; i += 1) {
        const prevIndex = indices[(i - 1 + indices.length) % indices.length];
        const currentIndex = indices[i];
        const nextIndex = indices[(i + 1) % indices.length];
        const prev = points[prevIndex];
        const current = points[currentIndex];
        const next = points[nextIndex];

        if (triangleSignedDoubleArea(prev, current, next) <= 1e-6) {
          continue;
        }

        let containsPoint = false;
        for (const candidateIndex of indices) {
          if (
            candidateIndex === prevIndex ||
            candidateIndex === currentIndex ||
            candidateIndex === nextIndex
          ) {
            continue;
          }

          if (pointInTriangleByArea(points[candidateIndex], prev, current, next, 0.0025)) {
            containsPoint = true;
            break;
          }
        }

        if (containsPoint) {
          continue;
        }

        triangles.push([prevIndex, currentIndex, nextIndex]);
        indices.splice(i, 1);
        earFound = true;
        break;
      }

      if (!earFound) {
        break;
      }

      guard += 1;
    }

    if (indices.length === 3) {
      triangles.push([indices[0], indices[1], indices[2]]);
    }

    if (!triangles.length) {
      for (let i = 1; i < indices.length - 1; i += 1) {
        triangles.push([indices[0], indices[i], indices[i + 1]]);
      }
    }

    return triangles;
  }

  Object.assign(app, {
    polygonArea,
    ensureCounterClockwise,
    distance,
    clamp,
    lerp,
    triangleSignedDoubleArea,
    triangleArea,
    pointInTriangleByArea,
    clonePolygon,
    getGridCellKey,
    createBodyColor,
    takeNextBodyColor,
    pointInPolygon,
    distanceToSegment,
    distanceToPolygonEdges,
    simplifyPath,
    resampleClosedPath,
    getPolygonBounds,
    getPointsBounds,
    boundsOverlap,
    closestPointOnSegment,
    triangulatePolygon,
  });
})();
