/**
 * Pointer hit testing, dragging, and freehand body drawing interaction.
 *
 * Converts canvas events into stage-space gestures, supports point grabbing,
 * body removal, and drawn-outline creation for new soft-body instances.
 *
 * @author Ilya Tsivilskiy
 * @see getCanvasPoint
 * @see findGrabTarget
 * @see beginDraw
 * @see finishDraw
 * @see handlePointerDown
 */

(function () {
  const app = window.Anjellyka;
  const {
    canvas,
    state,
    createBodyColor,
    distance,
    pointInPolygon,
    simplifyPath,
    buildSoftBodyFromPolygon,
    createBodyFactoryFromPolygon,
    addBody,
    removeBody,
    clearGrab,
    updateCanvasCursor,
  } = app;
  const LEGACY_MOUSE_POINTER_ID = 1;
  const NON_PASSIVE_LISTENER = { passive: false };

  /**
   * Returns whether the event represents the primary contact we should use for
   * single-pointer drag and draw gestures.
   *
   * @param {{ button?: number, isPrimary?: boolean }} event
   * @returns {boolean}
   */
  function isPrimaryPointer(event) {
    if (typeof event.button === "number" && event.button !== 0) {
      return false;
    }

    if (typeof event.isPrimary === "boolean" && !event.isPrimary) {
      return false;
    }

    return true;
  }

  /**
   * Prevents browser-native touch gestures from stealing the active interaction.
   *
   * @param {{ preventDefault?: Function }} event
   */
  function cancelNativeGesture(event) {
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  }

  /**
   * Returns whether a real PointerEvent is available for pointer capture APIs.
   *
   * @param {Event} event
   * @returns {boolean}
   */
  function isNativePointerEvent(event) {
    return typeof PointerEvent !== "undefined" && event instanceof PointerEvent;
  }

  /**
   * Creates a pointer-like event from a legacy mouse event.
   *
   * @param {MouseEvent} event
   * @returns {PointerEvent}
   */
  function normalizeMouseEvent(event) {
    return {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: LEGACY_MOUSE_POINTER_ID,
      pointerType: "mouse",
      button: event.button,
      buttons: event.buttons,
      isPrimary: true,
      preventDefault: () => event.preventDefault(),
    };
  }

  /**
   * Creates a pointer-like event from a single changed touch.
   *
   * @param {TouchEvent} event
   * @param {Touch} touch
   * @returns {PointerEvent}
   */
  function normalizeTouchEvent(event, touch) {
    return {
      clientX: touch.clientX,
      clientY: touch.clientY,
      pointerId: touch.identifier,
      pointerType: "touch",
      button: 0,
      buttons: 1,
      isPrimary: true,
      preventDefault: () => event.preventDefault(),
    };
  }

  /**
   * Finds a touch entry by identifier within a TouchList-like collection.
   *
   * @param {TouchList} touchList
   * @param {number | null} identifier
   * @returns {Touch | null}
   */
  function findTouchByIdentifier(touchList, identifier) {
    if (identifier == null || !touchList) {
      return null;
    }

    for (let index = 0; index < touchList.length; index += 1) {
      if (touchList[index].identifier === identifier) {
        return touchList[index];
      }
    }

    return null;
  }

  /**
   * Converts a pointer event from viewport coordinates into canvas coordinates.
   *
   * @param {PointerEvent} event
   * @returns {Vec2}
   */
  function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const logicalWidth = rect.width > 0 ? canvas.width / scale : 0;
    const logicalHeight = rect.height > 0 ? canvas.height / scale : 0;
    const scaleX = rect.width > 0 ? logicalWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? logicalHeight / rect.height : 1;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  /**
   * Finds the nearest particle across all bodies within a search radius.
   *
   * @param {Vec2} position
   * @param {number} [radius=34]
   * @returns {GrabTarget | null}
   */
  function findNearestPoint(position, radius = 34) {
    if (!state.bodies.length) {
      return null;
    }

    let match = null;
    let bestDistance = radius;

    state.bodies.forEach((body, bodyIndex) => {
      body.points.forEach((point, pointIndex) => {
        const gap = Math.hypot(position.x - point.x, position.y - point.y);
        if (gap < bestDistance) {
          bestDistance = gap;
          match = { body, bodyIndex, pointIndex, point, gap };
        }
      });
    });

    return match;
  }

  /**
   * Finds the nearest particle within a single body.
   *
   * @param {SoftBody} body
   * @param {number} bodyIndex
   * @param {Vec2} position
   * @returns {GrabTarget | null}
   */
  function findNearestPointInBody(body, bodyIndex, position) {
    let match = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    body.points.forEach((point, pointIndex) => {
      const gap = Math.hypot(position.x - point.x, position.y - point.y);
      if (gap < bestDistance) {
        bestDistance = gap;
        match = { body, bodyIndex, pointIndex, point, gap };
      }
    });

    return match;
  }

  /**
   * Returns whether a point lies inside a body's boundary polygon.
   *
   * @param {Vec2} position
   * @param {SoftBody | null} body
   * @returns {boolean}
   */
  function isInsideBody(position, body) {
    if (!body) {
      return false;
    }

    return pointInPolygon(position, body.boundaryPoints());
  }

  /**
   * Finds the topmost body whose boundary contains the given point.
   *
   * @param {Vec2} position
   * @returns {{ body: SoftBody, bodyIndex: number } | null}
   */
  function findBodyAtPosition(position) {
    for (let bodyIndex = state.bodies.length - 1; bodyIndex >= 0; bodyIndex -= 1) {
      const body = state.bodies[bodyIndex];
      if (isInsideBody(position, body)) {
        return { body, bodyIndex };
      }
    }

    return null;
  }

  /**
   * Chooses the best particle to grab from a pointer position.
   *
   * @param {Vec2} position
   * @param {number} [radius=Math.max(34, state.settings.spacing * 1.25)]
   * @returns {GrabTarget | null}
   */
  function findGrabTarget(position, radius = Math.max(34, state.settings.spacing * 1.25)) {
    if (!state.bodies.length) {
      return null;
    }

    let insideMatch = null;

    state.bodies.forEach((body, bodyIndex) => {
      if (!isInsideBody(position, body)) {
        return;
      }

      const bodyNearest = findNearestPointInBody(body, bodyIndex, position);
      if (!insideMatch || bodyNearest.gap < insideMatch.gap) {
        insideMatch = bodyNearest;
      }
    });

    if (insideMatch) {
      return insideMatch;
    }

    const nearest = findNearestPoint(position, radius);
    if (nearest && nearest.gap <= radius) {
      return nearest;
    }

    return null;
  }

  /**
   * Starts a freehand body outline.
   *
   * @param {Vec2} position
   */
  function beginDraw(position) {
    state.pointer.drawPath = [position];
  }

  /**
   * Appends a point to the current draw path when the pointer has moved enough.
   *
   * @param {Vec2} position
   */
  function updateDraw(position) {
    const last = state.pointer.drawPath[state.pointer.drawPath.length - 1];
    if (!last || distance(last, position) > 6) {
      state.pointer.drawPath.push(position);
    }
  }

  /**
   * Finalizes a freehand path, converts it to a soft body, and appends it to the
   * scene if the shape is valid.
   */
  function finishDraw() {
    if (state.pointer.drawPath.length < 8) {
      state.pointer.drawPath = [];
      return;
    }

    const path = simplifyPath(state.pointer.drawPath, Math.max(5, state.settings.spacing * 0.35));
    const reservedColor = createBodyColor(state.nextColorIndex);
    const body = buildSoftBodyFromPolygon(path, state.settings.spacing, reservedColor);
    state.pointer.drawPath = [];

    if (!body) {
      return;
    }

    state.nextColorIndex += 1;
    addBody(createBodyFactoryFromPolygon(path, state.settings.spacing, reservedColor));
  }

  /**
   * Handles pointer press events for both drawing and grabbing.
   *
   * @param {PointerEvent} event
   */
  function handlePointerDown(event) {
    if (!isPrimaryPointer(event) || state.pointer.active) {
      return;
    }

    cancelNativeGesture(event);
    const position = getCanvasPoint(event);

    if (state.mode === "remove") {
      const hit = findBodyAtPosition(position);
      if (hit) {
        removeBody(hit.bodyIndex);
      }
      return;
    }

    state.pointer.active = true;
    state.pointer.id = event.pointerId;
    state.pointer.x = position.x;
    state.pointer.y = position.y;
    state.pointer.lastMoveTime = performance.now();
    state.pointer.vx = 0;
    state.pointer.vy = 0;

    if (isNativePointerEvent(event)) {
      canvas.setPointerCapture(event.pointerId);
    }

    if (state.mode === "draw") {
      beginDraw(position);
      return;
    }

    const found = findGrabTarget(position);
    if (!found) {
      return;
    }

    found.point.pinned = true;
    found.point.pinX = position.x;
    found.point.pinY = position.y;
    found.point.pinVX = 0;
    found.point.pinVY = 0;
    state.pointer.grabbed = found;
    updateCanvasCursor();
  }

  /**
   * Handles pointer motion, updating hover state, draw paths, and drag pins.
   *
   * @param {PointerEvent} event
   */
  function handlePointerMove(event) {
    if (state.pointer.active && state.pointer.id !== event.pointerId) {
      return;
    }

    if (state.pointer.active || event.pointerType === "touch" || event.pointerType === "pen") {
      cancelNativeGesture(event);
    }

    const position = getCanvasPoint(event);
    const now = performance.now();
    const dt = Math.max(1 / 240, (now - state.pointer.lastMoveTime) / 1000);
    state.pointer.vx = (position.x - state.pointer.x) / dt;
    state.pointer.vy = (position.y - state.pointer.y) / dt;
    state.pointer.x = position.x;
    state.pointer.y = position.y;
    state.pointer.lastMoveTime = now;

    if (!state.pointer.active) {
      state.pointer.hovering =
        state.mode === "preset"
          ? findGrabTarget(position, Math.max(20, state.settings.spacing))
          : null;
      updateCanvasCursor();
      return;
    }

    if (state.mode === "draw") {
      updateDraw(position);
      return;
    }

    if (state.pointer.grabbed) {
      state.pointer.grabbed.point.pinX = position.x;
      state.pointer.grabbed.point.pinY = position.y;
      state.pointer.grabbed.point.pinVX = state.pointer.vx;
      state.pointer.grabbed.point.pinVY = state.pointer.vy;
    }
  }

  /**
   * Handles pointer release and completes either a draw gesture or a grab.
   *
   * @param {PointerEvent} event
   */
  function handlePointerUp(event) {
    if (!state.pointer.active || state.pointer.id !== event.pointerId) {
      return;
    }

    cancelNativeGesture(event);

    if (isNativePointerEvent(event) && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    if (state.mode === "draw") {
      finishDraw();
    } else {
      clearGrab();
    }

    state.pointer.active = false;
    state.pointer.id = null;
    updateCanvasCursor();
  }

  /**
   * Attaches stage interaction listeners with Pointer Events first and legacy
   * mouse/touch fallbacks for browsers that still lack them.
   */
  function bindStageInteraction() {
    if (window.PointerEvent) {
      canvas.addEventListener("pointerdown", handlePointerDown, NON_PASSIVE_LISTENER);
      canvas.addEventListener("pointermove", handlePointerMove, NON_PASSIVE_LISTENER);
      canvas.addEventListener("pointerup", handlePointerUp, NON_PASSIVE_LISTENER);
      canvas.addEventListener("pointercancel", handlePointerUp, NON_PASSIVE_LISTENER);
      canvas.addEventListener("pointerleave", (event) => {
        if (state.pointer.active && state.mode === "draw" && state.pointer.id === event.pointerId) {
          handlePointerUp(event);
          return;
        }

        if (!state.pointer.active && event.pointerType === "mouse") {
          state.pointer.hovering = null;
          updateCanvasCursor();
        }
      });
      return;
    }

    canvas.addEventListener("mousedown", (event) => {
      handlePointerDown(normalizeMouseEvent(event));
    });

    window.addEventListener("mousemove", (event) => {
      if (!state.pointer.active && event.target !== canvas) {
        return;
      }

      handlePointerMove(normalizeMouseEvent(event));
    });

    window.addEventListener("mouseup", (event) => {
      handlePointerUp(normalizeMouseEvent(event));
    });

    canvas.addEventListener("mouseleave", () => {
      if (state.pointer.active) {
        return;
      }

      state.pointer.hovering = null;
      updateCanvasCursor();
    });

    canvas.addEventListener(
      "touchstart",
      (event) => {
        if (state.pointer.active) {
          return;
        }

        const touch = event.changedTouches[0];
        if (!touch) {
          return;
        }

        handlePointerDown(normalizeTouchEvent(event, touch));
      },
      NON_PASSIVE_LISTENER
    );

    window.addEventListener(
      "touchmove",
      (event) => {
        if (!state.pointer.active) {
          return;
        }

        const touch = findTouchByIdentifier(event.touches, state.pointer.id);
        if (!touch) {
          return;
        }

        handlePointerMove(normalizeTouchEvent(event, touch));
      },
      NON_PASSIVE_LISTENER
    );

    const finishTouchInteraction = (event) => {
      const touch = findTouchByIdentifier(event.changedTouches, state.pointer.id);
      if (!touch) {
        return;
      }

      handlePointerUp(normalizeTouchEvent(event, touch));
    };

    window.addEventListener("touchend", finishTouchInteraction, NON_PASSIVE_LISTENER);
    window.addEventListener("touchcancel", finishTouchInteraction, NON_PASSIVE_LISTENER);
  }

  Object.assign(app, {
    getCanvasPoint,
    findNearestPoint,
    findNearestPointInBody,
    isInsideBody,
    findBodyAtPosition,
    findGrabTarget,
    beginDraw,
    updateDraw,
    finishDraw,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    bindStageInteraction,
  });
})();
