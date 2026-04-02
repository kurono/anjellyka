/**
 * Soft-body construction from polygons and preset outline generation.
 *
 * Resamples outlines, places boundary and interior particles, connects
 * structural constraints, and produces reusable preset polygons for spawning.
 *
 * @author Ilya Tsivilskiy
 * @see sampleInteriorPoints
 * @see buildSoftBodyFromPolygon
 * @see makeCirclePolygon
 * @see makeCapsulePolygon
 * @see makeHeartPolygon
 */

(function () {
  const app = window.Anjellyka;
  const {
    Point,
    SoftBody,
    createBodyColor,
    distance,
    distanceToPolygonEdges,
    getPolygonBounds,
    pointInPolygon,
    polygonArea,
    resampleClosedPath,
  } = app;

  /**
   * Samples interior particles on a staggered grid and keeps only candidates
   * that sit safely inside the polygon.
   *
   * @param {Vec2[]} polygon
   * @param {number} spacing
   * @returns {Vec2[]}
   */
  function sampleInteriorPoints(polygon, spacing) {
    const bounds = getPolygonBounds(polygon);
    const rowStep = spacing * Math.sin(Math.PI / 3);
    const interior = [];
    let rowIndex = 0;

    for (let y = bounds.minY; y <= bounds.maxY; y += rowStep) {
      const offset = rowIndex % 2 === 0 ? 0 : spacing * 0.5;

      for (let x = bounds.minX; x <= bounds.maxX; x += spacing) {
        const candidate = { x: x + offset, y };
        if (!pointInPolygon(candidate, polygon)) {
          continue;
        }

        if (distanceToPolygonEdges(candidate, polygon) < spacing * 0.4) {
          continue;
        }

        interior.push(candidate);
      }

      rowIndex += 1;
    }

    return interior;
  }

  /**
   * Adds a unique distance constraint between two particle indices.
   *
   * @param {Constraint[]} constraints Constraint output array.
   * @param {Set<string>} seen Pair cache used to prevent duplicates.
   * @param {Point[]} points Particle list used to measure rest length.
   * @param {number} a First particle index.
   * @param {number} b Second particle index.
   * @param {number} stiffness Per-constraint stiffness multiplier.
   */
  function addConstraint(constraints, seen, points, a, b, stiffness) {
    if (a === b) {
      return;
    }

    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    constraints.push({
      a,
      b,
      stiffness,
      restLength: distance(points[a], points[b]),
    });
  }

  /**
   * Converts a polygon into a soft body.
   *
   * @param {Vec2[]} polygon Input polygon.
   * @param {number} spacing Target particle spacing.
   * @param {BodyColor} [color=createBodyColor(0)] Body rendering colors.
   * @returns {SoftBody | null}
   */
  function buildSoftBodyFromPolygon(polygon, spacing, color = createBodyColor(0)) {
    const boundary = resampleClosedPath(polygon, spacing);

    if (boundary.length < 5 || Math.abs(polygonArea(boundary)) < spacing * spacing * 4) {
      return null;
    }

    const interior = sampleInteriorPoints(boundary, spacing);
    const mergedInterior = interior.filter((point) =>
      boundary.every((boundaryPoint) => distance(point, boundaryPoint) > spacing * 0.55)
    );

    if (!mergedInterior.length) {
      const center = boundary.reduce(
        (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
        { x: 0, y: 0 }
      );
      mergedInterior.push({
        x: center.x / boundary.length,
        y: center.y / boundary.length,
      });
    }

    const particleRadius = Math.max(3.2, spacing * 0.22);
    const points = boundary
      .concat(mergedInterior)
      .map((point) => new Point(point.x, point.y, particleRadius));
    const constraints = [];
    const seen = new Set();
    const boundaryCount = boundary.length;

    for (let i = 0; i < boundaryCount; i += 1) {
      addConstraint(constraints, seen, points, i, (i + 1) % boundaryCount, 1);
      addConstraint(constraints, seen, points, i, (i + 2) % boundaryCount, 0.65);
    }

    // Candidate structural links are searched within a local radius and then
    // added shortest-first to avoid over-connecting the body graph.
    const radius = spacing * 1.85;
    const degree = new Array(points.length).fill(0);
    const candidates = [];

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const gap = distance(points[i], points[j]);
        if (gap < spacing * 0.5 || gap > radius) {
          continue;
        }

        candidates.push({ i, j, gap });
      }
    }

    candidates.sort((left, right) => left.gap - right.gap);

    for (const candidate of candidates) {
      const limitA = candidate.i < boundaryCount ? 10 : 8;
      const limitB = candidate.j < boundaryCount ? 10 : 8;
      if (degree[candidate.i] >= limitA || degree[candidate.j] >= limitB) {
        continue;
      }

      addConstraint(
        constraints,
        seen,
        points,
        candidate.i,
        candidate.j,
        candidate.gap < spacing * 1.15 ? 0.95 : 0.72
      );

      degree[candidate.i] += 1;
      degree[candidate.j] += 1;
    }

    return new SoftBody(points, boundaryCount, constraints, color);
  }

  /**
   * Creates a circular preset polygon.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {number} [samples=18]
   * @returns {Vec2[]}
   */
  function makeCirclePolygon(cx, cy, radius, samples = 18) {
    const points = [];
    for (let i = 0; i < samples; i += 1) {
      const angle = (i / samples) * Math.PI * 2;
      points.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }
    return points;
  }

  /**
   * Creates an axis-aligned box preset polygon.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} width
   * @param {number} height
   * @returns {Vec2[]}
   */
  function makeBoxPolygon(cx, cy, width, height) {
    return [
      { x: cx - width * 0.5, y: cy - height * 0.5 },
      { x: cx + width * 0.5, y: cy - height * 0.5 },
      { x: cx + width * 0.5, y: cy + height * 0.5 },
      { x: cx - width * 0.5, y: cy + height * 0.5 },
    ];
  }

  /**
   * Creates a capsule preset polygon composed of two semicircular end caps.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} width
   * @param {number} height
   * @param {number} [arcSamples=8]
   * @returns {Vec2[]}
   */
  function makeCapsulePolygon(cx, cy, width, height, arcSamples = 8) {
    const radius = height * 0.5;
    const straight = Math.max(radius, width * 0.5 - radius);
    const points = [];

    for (let i = 0; i <= arcSamples; i += 1) {
      const angle = -Math.PI * 0.5 + (i / arcSamples) * Math.PI;
      points.push({
        x: cx + straight + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }

    for (let i = 0; i <= arcSamples; i += 1) {
      const angle = Math.PI * 0.5 + (i / arcSamples) * Math.PI;
      points.push({
        x: cx - straight + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }

    return points;
  }

  /**
   * Creates a star-shaped preset polygon.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} outerRadius
   * @param {number} innerRadius
   * @param {number} [spikes=5]
   * @returns {Vec2[]}
   */
  function makeStarPolygon(cx, cy, outerRadius, innerRadius, spikes = 5) {
    const points = [];
    for (let i = 0; i < spikes * 2; i += 1) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI * 0.5;
      points.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }
    return points;
  }

  /**
   * Creates a heart-shaped preset polygon from a classic parametric curve.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} size
   * @param {number} [samples=40]
   * @returns {Vec2[]}
   */
  function makeHeartPolygon(cx, cy, size, samples = 40) {
    const scale = size / 18;
    const points = [];

    for (let i = 0; i < samples; i += 1) {
      const t = (i / samples) * Math.PI * 2;
      const sinT = Math.sin(t);
      const cosT = Math.cos(t);
      const x = 16 * sinT * sinT * sinT;
      const y = 13 * cosT - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);

      points.push({
        x: cx + x * scale,
        y: cy - y * scale,
      });
    }

    return points;
  }

  Object.assign(app, {
    sampleInteriorPoints,
    addConstraint,
    buildSoftBodyFromPolygon,
    makeCirclePolygon,
    makeBoxPolygon,
    makeCapsulePolygon,
    makeStarPolygon,
    makeHeartPolygon,
  });
})();
