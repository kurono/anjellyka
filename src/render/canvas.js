/**
 * WebGL pipelines, mesh batching, and stage rendering helpers.
 *
 * Creates shader programs and draw helpers for soft bodies, draft paths, hover
 * targets, and the gradient stage background rendered onto the shared canvas.
 *
 * @author Ilya Tsivilskiy
 * @see drawSoftBody
 * @see drawDraft
 * @see drawHoverTarget
 * @see renderBackground
 */

(function () {
  const app = window.Anjellyka;
  const { canvas, gl, state, clamp, triangulatePolygon } = app;
  const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
  const TAU = Math.PI * 2;
  const colorCache = new Map();

  const flatPipeline = createFlatPipeline();
  const shadedPipeline = createShadedPipeline();
  const dashPipeline = createDashPipeline();
  const pointPipeline = createPointPipeline();

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const backgroundTopLeft = parseCssColor("rgba(13, 30, 48, 1)");
  const backgroundTopRight = parseCssColor("rgba(7, 18, 30, 1)");
  const backgroundBottomLeft = parseCssColor("rgba(4, 10, 18, 1)");
  const backgroundBottomRight = parseCssColor("rgba(3, 9, 19, 1)");
  const gridColor = parseCssColor("rgba(141, 197, 255, 0.08)");
  const floorColor = parseCssColor("rgba(116, 243, 198, 0.1)");
  const meshColor = parseCssColor("rgba(255, 255, 255, 0.22)");
  const draftColor = parseCssColor("#ffc76b");
  const nodeBoundaryColor = parseCssColor("#b9efff");
  const nodeInteriorColor = parseCssColor("#74f3c6");
  const grabbedColor = parseCssColor("#ff8d7c");
  const hoverColor = parseCssColor("rgba(255, 255, 255, 0.42)");
  const shadowStrong = parseCssColor("rgba(0, 0, 0, 0.22)");
  const shadowSoft = parseCssColor("rgba(0, 0, 0, 0.16)");

  /**
   * Compiles a WebGL shader from source.
   *
   * @param {number} type WebGL shader type enum.
   * @param {string} source GLSL source code.
   * @returns {WebGLShader}
   */
  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(error || "Failed to compile WebGL shader.");
    }

    return shader;
  }

  /**
   * Links a vertex/fragment shader pair into a WebGL program.
   *
   * @param {string} vertexSource Vertex shader GLSL source.
   * @param {string} fragmentSource Fragment shader GLSL source.
   * @returns {WebGLProgram}
   */
  function createProgram(vertexSource, fragmentSource) {
    const vertexShader = createShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(error || "Failed to link WebGL program.");
    }

    return program;
  }

  /**
   * Builds the pipeline used for flat-colored triangle batches.
   *
   * @returns {{
   *   program: WebGLProgram,
   *   buffer: WebGLBuffer,
   *   position: number,
   *   color: number,
   *   resolution: WebGLUniformLocation | null
   * }}
   */
  function createFlatPipeline() {
    const program = createProgram(
      `
        attribute vec2 a_position;
        attribute vec4 a_color;
        uniform vec2 u_resolution;
        varying vec4 v_color;

        void main() {
          vec2 zeroToOne = a_position / u_resolution;
          vec2 clip = zeroToOne * 2.0 - 1.0;
          gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
          v_color = a_color;
        }
      `,
      `
        precision mediump float;
        varying vec4 v_color;

        void main() {
          gl_FragColor = v_color;
        }
      `
    );

    return {
      program,
      buffer: gl.createBuffer(),
      position: gl.getAttribLocation(program, "a_position"),
      color: gl.getAttribLocation(program, "a_color"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
    };
  }

  /**
   * Builds the pipeline used for vertically shaded body fills.
   *
   * @returns {{
   *   program: WebGLProgram,
   *   buffer: WebGLBuffer,
   *   position: number,
   *   color: number,
   *   tone: number,
   *   resolution: WebGLUniformLocation | null
   * }}
   */
  function createShadedPipeline() {
    const program = createProgram(
      `
        attribute vec2 a_position;
        attribute vec4 a_color;
        attribute float a_tone;
        uniform vec2 u_resolution;
        varying vec4 v_color;
        varying float v_tone;

        void main() {
          vec2 zeroToOne = a_position / u_resolution;
          vec2 clip = zeroToOne * 2.0 - 1.0;
          gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
          v_color = a_color;
          v_tone = a_tone;
        }
      `,
      `
        precision mediump float;
        varying vec4 v_color;
        varying float v_tone;

        void main() {
          float shade = mix(1.08, 0.82, clamp(v_tone, 0.0, 1.0));
          gl_FragColor = vec4(v_color.rgb * shade, v_color.a);
        }
      `
    );

    return {
      program,
      buffer: gl.createBuffer(),
      position: gl.getAttribLocation(program, "a_position"),
      color: gl.getAttribLocation(program, "a_color"),
      tone: gl.getAttribLocation(program, "a_tone"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
    };
  }

  /**
   * Builds the pipeline used for dashed overlay strokes.
   *
   * @returns {{
   *   program: WebGLProgram,
   *   buffer: WebGLBuffer,
   *   position: number,
   *   color: number,
   *   length: number,
   *   resolution: WebGLUniformLocation | null,
   *   dashSize: WebGLUniformLocation | null,
   *   gapSize: WebGLUniformLocation | null
   * }}
   */
  function createDashPipeline() {
    const program = createProgram(
      `
        attribute vec2 a_position;
        attribute vec4 a_color;
        attribute float a_length;
        uniform vec2 u_resolution;
        varying vec4 v_color;
        varying float v_length;

        void main() {
          vec2 zeroToOne = a_position / u_resolution;
          vec2 clip = zeroToOne * 2.0 - 1.0;
          gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
          v_color = a_color;
          v_length = a_length;
        }
      `,
      `
        precision mediump float;
        varying vec4 v_color;
        varying float v_length;
        uniform float u_dashSize;
        uniform float u_gapSize;

        void main() {
          float cycle = max(0.0001, u_dashSize + u_gapSize);
          if (u_dashSize > 0.0 && mod(v_length, cycle) > u_dashSize) {
            discard;
          }

          gl_FragColor = v_color;
        }
      `
    );

    return {
      program,
      buffer: gl.createBuffer(),
      position: gl.getAttribLocation(program, "a_position"),
      color: gl.getAttribLocation(program, "a_color"),
      length: gl.getAttribLocation(program, "a_length"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
      dashSize: gl.getUniformLocation(program, "u_dashSize"),
      gapSize: gl.getUniformLocation(program, "u_gapSize"),
    };
  }

  /**
   * Builds the pipeline used for particle sprites.
   *
   * @returns {{
   *   program: WebGLProgram,
   *   buffer: WebGLBuffer,
   *   position: number,
   *   size: number,
   *   color: number,
   *   resolution: WebGLUniformLocation | null,
   *   scale: WebGLUniformLocation | null
   * }}
   */
  function createPointPipeline() {
    const program = createProgram(
      `
        attribute vec2 a_position;
        attribute float a_size;
        attribute vec4 a_color;
        uniform vec2 u_resolution;
        uniform float u_scale;
        varying vec4 v_color;

        void main() {
          vec2 zeroToOne = a_position / u_resolution;
          vec2 clip = zeroToOne * 2.0 - 1.0;
          gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
          gl_PointSize = a_size * u_scale;
          v_color = a_color;
        }
      `,
      `
        precision mediump float;
        varying vec4 v_color;

        void main() {
          vec2 local = gl_PointCoord * 2.0 - 1.0;
          float distanceSq = dot(local, local);

          if (distanceSq > 1.0) {
            discard;
          }

          float alpha = 1.0 - smoothstep(0.82, 1.0, distanceSq);
          gl_FragColor = vec4(v_color.rgb, v_color.a * alpha);
        }
      `
    );

    return {
      program,
      buffer: gl.createBuffer(),
      position: gl.getAttribLocation(program, "a_position"),
      size: gl.getAttribLocation(program, "a_size"),
      color: gl.getAttribLocation(program, "a_color"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
      scale: gl.getUniformLocation(program, "u_scale"),
    };
  }

  /**
   * Returns the canvas size in CSS pixels plus the current device scale.
   *
   * @returns {{ width: number, height: number, scale: number }}
   */
  function getLogicalResolution() {
    const scale = window.devicePixelRatio || 1;
    return {
      width: Math.max(1, canvas.width / scale),
      height: Math.max(1, canvas.height / scale),
      scale,
    };
  }

  /**
   * Uploads and draws a flat-colored triangle batch.
   *
   * @param {number[]} vertices Interleaved position/color data.
   */
  function drawFlatTriangles(vertices) {
    if (!vertices.length) {
      return;
    }

    const resolution = getLogicalResolution();
    gl.useProgram(flatPipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, flatPipeline.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(flatPipeline.position);
    gl.enableVertexAttribArray(flatPipeline.color);
    gl.vertexAttribPointer(flatPipeline.position, 2, gl.FLOAT, false, 6 * FLOAT_BYTES, 0);
    gl.vertexAttribPointer(
      flatPipeline.color,
      4,
      gl.FLOAT,
      false,
      6 * FLOAT_BYTES,
      2 * FLOAT_BYTES
    );
    gl.uniform2f(flatPipeline.resolution, resolution.width, resolution.height);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6);
  }

  /**
   * Uploads and draws a shaded triangle batch.
   *
   * @param {number[]} vertices Interleaved position/color/tone data.
   */
  function drawShadedTriangles(vertices) {
    if (!vertices.length) {
      return;
    }

    const resolution = getLogicalResolution();
    gl.useProgram(shadedPipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, shadedPipeline.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(shadedPipeline.position);
    gl.enableVertexAttribArray(shadedPipeline.color);
    gl.enableVertexAttribArray(shadedPipeline.tone);
    gl.vertexAttribPointer(shadedPipeline.position, 2, gl.FLOAT, false, 7 * FLOAT_BYTES, 0);
    gl.vertexAttribPointer(
      shadedPipeline.color,
      4,
      gl.FLOAT,
      false,
      7 * FLOAT_BYTES,
      2 * FLOAT_BYTES
    );
    gl.vertexAttribPointer(
      shadedPipeline.tone,
      1,
      gl.FLOAT,
      false,
      7 * FLOAT_BYTES,
      6 * FLOAT_BYTES
    );
    gl.uniform2f(shadedPipeline.resolution, resolution.width, resolution.height);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 7);
  }

  /**
   * Uploads and draws a dashed triangle batch.
   *
   * @param {number[]} vertices Interleaved position/color/length data.
   * @param {number} dashSize Visible dash length in CSS pixels.
   * @param {number} gapSize Invisible gap length in CSS pixels.
   */
  function drawDashedTriangles(vertices, dashSize, gapSize) {
    if (!vertices.length) {
      return;
    }

    const resolution = getLogicalResolution();
    gl.useProgram(dashPipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, dashPipeline.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(dashPipeline.position);
    gl.enableVertexAttribArray(dashPipeline.color);
    gl.enableVertexAttribArray(dashPipeline.length);
    gl.vertexAttribPointer(dashPipeline.position, 2, gl.FLOAT, false, 7 * FLOAT_BYTES, 0);
    gl.vertexAttribPointer(
      dashPipeline.color,
      4,
      gl.FLOAT,
      false,
      7 * FLOAT_BYTES,
      2 * FLOAT_BYTES
    );
    gl.vertexAttribPointer(
      dashPipeline.length,
      1,
      gl.FLOAT,
      false,
      7 * FLOAT_BYTES,
      6 * FLOAT_BYTES
    );
    gl.uniform2f(dashPipeline.resolution, resolution.width, resolution.height);
    gl.uniform1f(dashPipeline.dashSize, dashSize);
    gl.uniform1f(dashPipeline.gapSize, gapSize);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 7);
  }

  /**
   * Uploads and draws a point-sprite batch.
   *
   * @param {number[]} vertices Interleaved position/size/color data.
   */
  function drawPoints(vertices) {
    if (!vertices.length) {
      return;
    }

    const resolution = getLogicalResolution();
    gl.useProgram(pointPipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, pointPipeline.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(pointPipeline.position);
    gl.enableVertexAttribArray(pointPipeline.size);
    gl.enableVertexAttribArray(pointPipeline.color);
    gl.vertexAttribPointer(pointPipeline.position, 2, gl.FLOAT, false, 7 * FLOAT_BYTES, 0);
    gl.vertexAttribPointer(pointPipeline.size, 1, gl.FLOAT, false, 7 * FLOAT_BYTES, 2 * FLOAT_BYTES);
    gl.vertexAttribPointer(
      pointPipeline.color,
      4,
      gl.FLOAT,
      false,
      7 * FLOAT_BYTES,
      3 * FLOAT_BYTES
    );
    gl.uniform2f(pointPipeline.resolution, resolution.width, resolution.height);
    gl.uniform1f(pointPipeline.scale, resolution.scale);
    gl.drawArrays(gl.POINTS, 0, vertices.length / 7);
  }

  /**
   * Appends one flat-colored vertex to a batch.
   *
   * @param {number[]} vertices
   * @param {number} x
   * @param {number} y
   * @param {number[]} color
   */
  function pushFlatVertex(vertices, x, y, color) {
    vertices.push(x, y, color[0], color[1], color[2], color[3]);
  }

  /**
   * Appends one shaded vertex to a batch.
   *
   * @param {number[]} vertices
   * @param {number} x
   * @param {number} y
   * @param {number[]} color
   * @param {number} tone
   */
  function pushShadedVertex(vertices, x, y, color, tone) {
    vertices.push(x, y, color[0], color[1], color[2], color[3], tone);
  }

  /**
   * Appends one dashed-stroke vertex to a batch.
   *
   * @param {number[]} vertices
   * @param {number} x
   * @param {number} y
   * @param {number[]} color
   * @param {number} lengthValue Distance along the source polyline.
   */
  function pushDashVertex(vertices, x, y, color, lengthValue) {
    vertices.push(x, y, color[0], color[1], color[2], color[3], lengthValue);
  }

  /**
   * Appends one particle-sprite vertex to a batch.
   *
   * @param {number[]} vertices
   * @param {number} x
   * @param {number} y
   * @param {number} size
   * @param {number[]} color
   */
  function pushPointVertex(vertices, x, y, size, color) {
    vertices.push(x, y, size, color[0], color[1], color[2], color[3]);
  }

  /**
   * Appends a solid rectangle as two triangles.
   *
   * @param {number[]} vertices
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number[]} color
   */
  function appendSolidRect(vertices, x, y, width, height, color) {
    pushFlatVertex(vertices, x, y, color);
    pushFlatVertex(vertices, x + width, y, color);
    pushFlatVertex(vertices, x, y + height, color);
    pushFlatVertex(vertices, x, y + height, color);
    pushFlatVertex(vertices, x + width, y, color);
    pushFlatVertex(vertices, x + width, y + height, color);
  }

  /**
   * Appends the full-screen stage background gradient.
   *
   * @param {number[]} vertices
   * @param {{ width: number, height: number }} bounds
   */
  function appendGradientRect(vertices, bounds) {
    pushFlatVertex(vertices, 0, 0, backgroundTopLeft);
    pushFlatVertex(vertices, bounds.width, 0, backgroundTopRight);
    pushFlatVertex(vertices, 0, bounds.height, backgroundBottomLeft);
    pushFlatVertex(vertices, 0, bounds.height, backgroundBottomLeft);
    pushFlatVertex(vertices, bounds.width, 0, backgroundTopRight);
    pushFlatVertex(vertices, bounds.width, bounds.height, backgroundBottomRight);
  }

  /**
   * Expands a line segment into a quad for portable WebGL stroke rendering.
   *
   * @param {number[]} vertices
   * @param {Vec2} start
   * @param {Vec2} end
   * @param {number} width
   * @param {number[]} color
   */
  function appendLineQuad(vertices, start, end, width, color) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthValue = Math.hypot(dx, dy);

    if (!lengthValue) {
      return;
    }

    const halfWidth = width * 0.5;
    const nx = (-dy / lengthValue) * halfWidth;
    const ny = (dx / lengthValue) * halfWidth;
    const ax = start.x + nx;
    const ay = start.y + ny;
    const bx = start.x - nx;
    const by = start.y - ny;
    const cx = end.x + nx;
    const cy = end.y + ny;
    const dx2 = end.x - nx;
    const dy2 = end.y - ny;

    pushFlatVertex(vertices, ax, ay, color);
    pushFlatVertex(vertices, bx, by, color);
    pushFlatVertex(vertices, cx, cy, color);
    pushFlatVertex(vertices, cx, cy, color);
    pushFlatVertex(vertices, bx, by, color);
    pushFlatVertex(vertices, dx2, dy2, color);
  }

  // WebGL line widths are not portable, so every stroke is expanded into a quad strip.
  /**
   * Appends a polyline as a series of line quads.
   *
   * @param {number[]} vertices
   * @param {Vec2[]} points
   * @param {number} width
   * @param {number[]} color
   * @param {boolean} [closed=false]
   */
  function appendPolyline(vertices, points, width, color, closed = false) {
    if (points.length < 2) {
      return;
    }

    const segmentCount = closed ? points.length : points.length - 1;
    for (let i = 0; i < segmentCount; i += 1) {
      appendLineQuad(vertices, points[i], points[(i + 1) % points.length], width, color);
    }
  }

  /**
   * Appends a dashed polyline as line quads carrying distance-along-path data.
   *
   * @param {number[]} vertices
   * @param {Vec2[]} points
   * @param {number} width
   * @param {number[]} color
   * @param {boolean} [closed=false]
   */
  function appendDashedPolyline(vertices, points, width, color, closed = false) {
    if (points.length < 2) {
      return;
    }

    const segmentCount = closed ? points.length : points.length - 1;
    let totalLength = 0;

    for (let i = 0; i < segmentCount; i += 1) {
      const start = points[i];
      const end = points[(i + 1) % points.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const segmentLength = Math.hypot(dx, dy);

      if (!segmentLength) {
        continue;
      }

      const halfWidth = width * 0.5;
      const nx = (-dy / segmentLength) * halfWidth;
      const ny = (dx / segmentLength) * halfWidth;
      const startLength = totalLength;
      const endLength = totalLength + segmentLength;
      const ax = start.x + nx;
      const ay = start.y + ny;
      const bx = start.x - nx;
      const by = start.y - ny;
      const cx = end.x + nx;
      const cy = end.y + ny;
      const dx2 = end.x - nx;
      const dy2 = end.y - ny;

      pushDashVertex(vertices, ax, ay, color, startLength);
      pushDashVertex(vertices, bx, by, color, startLength);
      pushDashVertex(vertices, cx, cy, color, endLength);
      pushDashVertex(vertices, cx, cy, color, endLength);
      pushDashVertex(vertices, bx, by, color, startLength);
      pushDashVertex(vertices, dx2, dy2, color, endLength);

      totalLength = endLength;
    }
  }

  /**
   * Normalizes triangle data from either tuple or object form.
   *
   * @param {number[] | { a: number, b: number, c: number }} triangle
   * @returns {number[]}
   */
  function getTriangleIndices(triangle) {
    if (Array.isArray(triangle)) {
      return triangle;
    }

    return [triangle.a, triangle.b, triangle.c];
  }

  /**
   * Appends a translated drop shadow under a soft body.
   *
   * @param {number[]} vertices
   * @param {SoftBody} body
   * @param {number[]} color
   * @param {number} offsetX
   * @param {number} offsetY
   */
  function appendBodyShadow(vertices, body, color, offsetX, offsetY) {
    const boundary = body.boundary;
    const triangles = body.triangles.length ? body.triangles : triangulatePolygon(boundary);

    for (let i = 0; i < triangles.length; i += 1) {
      const [indexA, indexB, indexC] = getTriangleIndices(triangles[i]);
      const a = boundary[indexA];
      const b = boundary[indexB];
      const c = boundary[indexC];
      pushFlatVertex(vertices, a.x + offsetX, a.y + offsetY, color);
      pushFlatVertex(vertices, b.x + offsetX, b.y + offsetY, color);
      pushFlatVertex(vertices, c.x + offsetX, c.y + offsetY, color);
    }
  }

  /**
   * Appends the filled surface triangles for a soft body.
   *
   * @param {number[]} vertices
   * @param {SoftBody} body
   * @param {number[]} color
   */
  function appendBodySurface(vertices, body, color) {
    const boundary = body.boundary;
    const triangles = body.triangles.length ? body.triangles : triangulatePolygon(boundary);
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < boundary.length; i += 1) {
      minY = Math.min(minY, boundary[i].y);
      maxY = Math.max(maxY, boundary[i].y);
    }

    const height = Math.max(1, maxY - minY);

    for (let i = 0; i < triangles.length; i += 1) {
      const [indexA, indexB, indexC] = getTriangleIndices(triangles[i]);
      const a = boundary[indexA];
      const b = boundary[indexB];
      const c = boundary[indexC];
      pushShadedVertex(vertices, a.x, a.y, color, clamp((a.y - minY) / height, 0, 1));
      pushShadedVertex(vertices, b.x, b.y, color, clamp((b.y - minY) / height, 0, 1));
      pushShadedVertex(vertices, c.x, c.y, color, clamp((c.y - minY) / height, 0, 1));
    }
  }

  /**
   * Appends all constraint segments for the optional mesh overlay.
   *
   * @param {number[]} vertices
   * @param {SoftBody} body
   */
  function appendConstraintMesh(vertices, body) {
    for (let i = 0; i < body.constraints.length; i += 1) {
      const constraint = body.constraints[i];
      const a = body.points[constraint.a];
      const b = body.points[constraint.b];
      appendLineQuad(vertices, a, b, 1, meshColor);
    }
  }

  /**
   * Appends sprite vertices for all body particles.
   *
   * @param {number[]} vertices
   * @param {SoftBody} body
   */
  function appendBodyNodes(vertices, body) {
    for (let i = 0; i < body.points.length; i += 1) {
      const point = body.points[i];
      const isGrabbed = state.pointer.grabbed && state.pointer.grabbed.point === point;
      const color = isGrabbed
        ? grabbedColor
        : i < body.boundaryCount
          ? nodeBoundaryColor
          : nodeInteriorColor;
      pushPointVertex(vertices, point.x, point.y, (point.radius + 1.5) * 2, color);
    }
  }

  /**
   * Approximates a circle with a closed polyline.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @returns {Vec2[]}
   */
  function makeCirclePolyline(cx, cy, radius) {
    const segments = Math.max(24, Math.ceil(radius * 3));
    const points = [];

    for (let i = 0; i < segments; i += 1) {
      const angle = (i / segments) * TAU;
      points.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }

    return points;
  }

  /**
   * Parses a CSS color string into normalized RGBA floats.
   *
   * @param {string} input
   * @returns {number[]}
   */
  function parseCssColor(input) {
    const cached = colorCache.get(input);
    if (cached) {
      return cached;
    }

    const value = input.trim().toLowerCase();
    let parsed;

    if (value.startsWith("#")) {
      parsed = parseHexColor(value);
    } else if (value.startsWith("rgb")) {
      parsed = parseRgbColor(value);
    } else if (value.startsWith("hsl")) {
      parsed = parseHslColor(value);
    } else {
      throw new Error(`Unsupported color format: ${input}`);
    }

    colorCache.set(input, parsed);
    return parsed;
  }

  /**
   * Parses a hex CSS color into normalized RGBA floats.
   *
   * @param {string} value
   * @returns {number[]}
   */
  function parseHexColor(value) {
    const hex = value.slice(1);

    if (hex.length === 3 || hex.length === 4) {
      const channels = hex.split("").map((channel) => parseInt(channel + channel, 16) / 255);
      return [
        channels[0],
        channels[1],
        channels[2],
        channels.length === 4 ? channels[3] : 1,
      ];
    }

    if (hex.length === 6 || hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      ];
    }

    throw new Error(`Invalid hex color: ${value}`);
  }

  /**
   * Parses an `rgb(...)` or `rgba(...)` CSS color.
   *
   * @param {string} value
   * @returns {number[]}
   */
  function parseRgbColor(value) {
    const body = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")")).trim();
    let alpha = 1;
    let colorPart = body;

    if (body.includes("/")) {
      const parts = body.split("/");
      colorPart = parts[0];
      alpha = parseAlpha(parts[1]);
    }

    const tokens = colorPart.replace(/,/g, " ").trim().split(/\s+/);
    if (tokens.length === 4) {
      alpha = parseAlpha(tokens.pop());
    }

    return [
      parseRgbChannel(tokens[0]),
      parseRgbChannel(tokens[1]),
      parseRgbChannel(tokens[2]),
      alpha,
    ];
  }

  /**
   * Parses an `hsl(...)` or `hsla(...)` CSS color.
   *
   * @param {string} value
   * @returns {number[]}
   */
  function parseHslColor(value) {
    const body = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")")).trim();
    let alpha = 1;
    let colorPart = body;

    if (body.includes("/")) {
      const parts = body.split("/");
      colorPart = parts[0];
      alpha = parseAlpha(parts[1]);
    }

    const tokens = colorPart.replace(/,/g, " ").trim().split(/\s+/);
    if (tokens.length === 4) {
      alpha = parseAlpha(tokens.pop());
    }

    const hue = parseAngle(tokens[0]);
    const saturation = parsePercent(tokens[1]);
    const lightness = parsePercent(tokens[2]);
    const rgb = hslToRgb(hue, saturation, lightness);

    return [rgb[0], rgb[1], rgb[2], alpha];
  }

  /**
   * Parses one RGB channel token into a normalized float.
   *
   * @param {string} token
   * @returns {number}
   */
  function parseRgbChannel(token) {
    const value = token.trim();
    if (value.endsWith("%")) {
      return clamp(parseFloat(value) / 100, 0, 1);
    }

    return clamp(parseFloat(value) / 255, 0, 1);
  }

  /**
   * Parses a percentage token into a normalized float.
   *
   * @param {string} token
   * @returns {number}
   */
  function parsePercent(token) {
    return clamp(parseFloat(token) / 100, 0, 1);
  }

  /**
   * Parses an angle token in degrees, radians, or turns.
   *
   * @param {string} token
   * @returns {number}
   */
  function parseAngle(token) {
    const value = token.trim();
    if (value.endsWith("turn")) {
      return (parseFloat(value) * 360) % 360;
    }

    if (value.endsWith("rad")) {
      return (parseFloat(value) * 180) / Math.PI;
    }

    return parseFloat(value);
  }

  /**
   * Parses an alpha token into a normalized float.
   *
   * @param {string} token
   * @returns {number}
   */
  function parseAlpha(token) {
    const value = token.trim();
    if (value.endsWith("%")) {
      return clamp(parseFloat(value) / 100, 0, 1);
    }

    return clamp(parseFloat(value), 0, 1);
  }

  /**
   * Converts normalized HSL values into normalized RGB values.
   *
   * @param {number} hue
   * @param {number} saturation
   * @param {number} lightness
   * @returns {number[]}
   */
  function hslToRgb(hue, saturation, lightness) {
    const h = ((hue % 360) + 360) % 360 / 360;

    if (!saturation) {
      return [lightness, lightness, lightness];
    }

    const q =
      lightness < 0.5
        ? lightness * (1 + saturation)
        : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;

    return [
      hueToRgb(p, q, h + 1 / 3),
      hueToRgb(p, q, h),
      hueToRgb(p, q, h - 1 / 3),
    ];
  }

  /**
   * Evaluates one color channel of the HSL-to-RGB conversion.
   *
   * @param {number} p
   * @param {number} q
   * @param {number} t
   * @returns {number}
   */
  function hueToRgb(p, q, t) {
    let wrapped = t;
    if (wrapped < 0) wrapped += 1;
    if (wrapped > 1) wrapped -= 1;
    if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped;
    if (wrapped < 1 / 2) return q;
    if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6;
    return p;
  }

  /**
   * Renders a soft body, optionally including its constraint mesh and particles.
   *
   * @param {SoftBody} body
   */
  function drawSoftBody(body) {
    const boundary = body.boundary;
    if (boundary.length < 2) {
      return;
    }

    const shadowVertices = [];
    const surfaceVertices = [];
    const outlineVertices = [];
    const shadowOffsetX = body.pointRadius * 0.65 + 3;
    const shadowOffsetY = body.pointRadius * 1.45 + 4;
    appendBodyShadow(
      shadowVertices,
      body,
      state.bodies.length >= 5 ? shadowSoft : shadowStrong,
      shadowOffsetX,
      shadowOffsetY
    );
    appendBodySurface(surfaceVertices, body, parseCssColor(body.color.fill));
    appendPolyline(outlineVertices, boundary, 3, parseCssColor(body.color.stroke), true);
    drawFlatTriangles(shadowVertices);
    drawShadedTriangles(surfaceVertices);
    drawFlatTriangles(outlineVertices);

    if (state.settings.showMesh) {
      const meshVertices = [];
      appendConstraintMesh(meshVertices, body);
      drawFlatTriangles(meshVertices);
    }

    if (state.settings.showNodes) {
      const pointVertices = [];
      appendBodyNodes(pointVertices, body);
      drawPoints(pointVertices);
    }
  }

  /**
   * Renders the in-progress freehand outline while the user is drawing.
   */
  function drawDraft() {
    if (state.pointer.drawPath.length < 2) {
      return;
    }

    const vertices = [];
    appendDashedPolyline(vertices, state.pointer.drawPath, 3, draftColor, false);
    drawDashedTriangles(vertices, 12, 8);
  }

  /**
   * Highlights the currently hovered or grabbed particle.
   */
  function drawHoverTarget() {
    const target = state.pointer.grabbed || state.pointer.hovering;
    if (!target) {
      return;
    }

    const radius = target.point.radius + 8;
    const circle = makeCirclePolyline(target.point.x, target.point.y, radius);
    const vertices = [];
    appendDashedPolyline(vertices, circle, 2, state.pointer.grabbed ? grabbedColor : hoverColor, true);
    drawDashedTriangles(vertices, 6, 6);
  }

  /**
   * Renders the stage background grid and floor strip.
   *
   * @param {{ width: number, height: number }} bounds
   */
  function renderBackground(bounds) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(backgroundBottomRight[0], backgroundBottomRight[1], backgroundBottomRight[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const backgroundVertices = [];
    appendGradientRect(backgroundVertices, bounds);
    drawFlatTriangles(backgroundVertices);

    const gridVertices = [];
    for (let x = 40; x < bounds.width; x += 40) {
      appendLineQuad(gridVertices, { x, y: 0 }, { x, y: bounds.height }, 1, gridColor);
    }

    for (let y = 40; y < bounds.height; y += 40) {
      appendLineQuad(gridVertices, { x: 0, y }, { x: bounds.width, y }, 1, gridColor);
    }

    drawFlatTriangles(gridVertices);

    const floorVertices = [];
    appendSolidRect(floorVertices, 0, bounds.height - 12, bounds.width, 12, floorColor);
    drawFlatTriangles(floorVertices);
  }

  Object.assign(app, {
    drawSoftBody,
    drawDraft,
    drawHoverTarget,
    renderBackground,
  });
})();
