(function () {
  const ONE_LINE_MIN_SCALE = 0.75;

  window.installOverlayLayout = function installOverlayLayout(options) {
    const api = options.api || window.overlayLayoutApi;
    const root =
      typeof options.root === "string"
        ? document.querySelector(options.root)
        : options.root || document.getElementById("panel");
    if (!root || !api)
      return {
        flush: () => Promise.resolve(),
        isEditing: () => false,
        refresh: () => {},
        cancel: () => {},
      };
    const preview =
      window.parent !== window && new URLSearchParams(location.search).get("mode") === "editor";
    const coordinateScale = () => {
      const zoom =
        options.coordinateScale?.() ?? Number.parseFloat(getComputedStyle(document.body).zoom);
      return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    };
    const logicalRect = (value) => {
      const rect = value.getBoundingClientRect ? value.getBoundingClientRect() : value;
      const zoom = coordinateScale();
      return {
        left: rect.left / zoom,
        top: rect.top / zoom,
        right: rect.right / zoom,
        bottom: rect.bottom / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      };
    };
    const originalBackgrounds = new WeakMap();
    let state = null;
    let frame = 0;
    let fitting = false;
    let gesture = null;
    const commands = [];
    let inFlight = null;
    let sending = false;
    const drains = [];
    const pendingClamps = new Set();

    function editing() {
      return preview && Boolean(state?.sessionId);
    }

    function scheduleLayout() {
      if (!frame) frame = requestAnimationFrame(applyLayout);
    }

    function fitOneLine(elements) {
      const fields = options.fitOneLineFields;
      if (!fields?.length || fitting || gesture) return;
      fitting = true;
      try {
        for (const element of elements) {
          if (!fields.includes(element.dataset.rewardField)) continue;
          element.style.removeProperty("--reward-fit-scale");
          element.style.whiteSpace = "nowrap";
          const natural = element.scrollWidth;
          const available = element.clientWidth;
          element.style.whiteSpace = "";
          if (!available || !(natural > available)) continue;
          // scrollWidth and clientWidth are whole pixels, so the fit gives back one.
          const ratio = Math.floor(((available - 1) / natural) * 1000) / 1000;
          if (ratio >= ONE_LINE_MIN_SCALE && ratio < 1)
            element.style.setProperty("--reward-fit-scale", String(ratio));
        }
      } finally {
        fitting = false;
      }
    }

    function applyLayout() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      options.tagFields?.();
      const elements = [...root.querySelectorAll("[data-reward-field]")];
      document.body.classList.toggle("reward-layout-editing", editing());
      for (const element of elements) {
        const field = element.dataset.rewardField;
        const style = state?.layout.fields[field];
        element.classList.toggle("reward-field-hidden", style?.hidden === true);
        element.classList.toggle(
          "reward-field-selected",
          editing() && state.selectedField === field,
        );
        element.style.transform = "";
        element.style.translate = "";
        element.style.scale = "";
        if (options.fitWidthFields?.includes(field)) {
          element.style.width = style && style.scale !== 1 ? `${100 / style.scale}%` : "";
        }
        element.style.color = style?.color || "";
        element.style.setProperty("--overlay-field-color", style?.color || "");
        if (!originalBackgrounds.has(element))
          originalBackgrounds.set(element, element.style.backgroundColor);
        element.style.backgroundColor =
          element.dataset.layoutTint === "background" && style?.color
            ? style.color
            : originalBackgrounds.get(element);
        element.style.maskImage = "";
        element.style.maskMode = "luminance";
        if (field === "scanSpinner") element.style.borderTopColor = style?.color || "";
        const fallback = element.querySelector(".slot-set-part-fallback");
        if (fallback) fallback.style.color = style?.color || "";
        const image = element.querySelector("img");
        if (image) {
          image.style.visibility = "";
          if (style?.color) {
            element.style.backgroundColor = style.color;
            element.style.maskImage = `url("${image.src.replaceAll('"', "%22")}")`;
            image.style.visibility = "hidden";
          }
        }
      }
      fitOneLine(elements);
      const panel = logicalRect(root);
      const positions = [];
      const limits = new Map();
      const resolved = new Set();
      for (const element of elements) {
        const field = element.dataset.rewardField;
        const style = state?.layout.fields[field];
        if (!style || style.hidden || !element.getClientRects().length) continue;
        const rect = logicalRect(element);
        if (!rect.width || !rect.height) continue;
        const container = options.boundsFor?.(element);
        const bounds = container ? logicalRect(container) : panel;
        if (
          bounds.bottom <= panel.top ||
          bounds.top >= panel.bottom ||
          bounds.right <= panel.left ||
          bounds.left >= panel.right
        )
          continue;
        const left = bounds.left + 3;
        const top = bounds.top + 3;
        const right = bounds.right - 3;
        const bottom = bounds.bottom - 3;
        if (right <= left || bottom <= top) continue;
        const scale = Math.min(
          style.scale,
          (right - left) / rect.width,
          (bottom - top) / rect.height,
        );
        const previous = limits.get(field);
        const range = {
          minX: Math.max(left - rect.left, previous?.minX ?? -Infinity),
          maxX: Infinity,
          minY: Math.max(top - rect.top, previous?.minY ?? -Infinity),
          maxY: Infinity,
        };
        limits.set(field, range);
        positions.push({
          element,
          field,
          style,
          scale,
          width: rect.width,
          height: rect.height,
          right: right - rect.left,
          bottom: bottom - rect.top,
        });
      }
      for (const position of positions) {
        const range = limits.get(position.field);
        position.scale = Math.min(
          position.scale,
          (position.right - range.minX) / position.width,
          (position.bottom - range.minY) / position.height,
        );
        range.maxX = Math.min(range.maxX, position.right - position.width * position.scale);
        range.maxY = Math.min(range.maxY, position.bottom - position.height * position.scale);
      }
      for (const { element, field, style, scale } of positions) {
        const range = limits.get(field);
        const x = Math.max(range.minX, Math.min(range.maxX, style.x));
        const y = Math.max(range.minY, Math.min(range.maxY, style.y));
        // Individual properties preserve the spinner's rotation animation.
        element.style.scale = String(Math.max(0.05, scale));
        element.style.translate = `${x}px ${y}px`;
        if (editing() && pendingClamps.has(field) && !resolved.has(field)) {
          resolved.add(field);
          const patch = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
          if (patch.x !== style.x || patch.y !== style.y) {
            state.layout.fields[field] = { ...style, ...patch };
            if (gesture?.field !== field) send({ type: "field", field, patch });
          }
        }
      }
      for (const field of resolved) pendingClamps.delete(field);
    }

    function accept(next) {
      if (!next?.layout || (state && next.revision < state.revision)) return;
      next = structuredClone(next);
      const previous = state;
      if (previous?.sessionId === next.sessionId) {
        for (const command of [inFlight, ...commands]) {
          if (command?.type === "select") next.selectedField = command.field;
          if (command?.type === "field") {
            next.layout.fields[command.field] = {
              ...options.defaultFieldStyle,
              ...next.layout.fields[command.field],
              ...command.patch,
            };
          }
        }
        if (gesture?.field) {
          const style = previous.layout.fields[gesture.field];
          if (style) next.layout.fields[gesture.field] = style;
          else delete next.layout.fields[gesture.field];
        }
      }
      const samePreview =
        previous?.sessionId === next.sessionId &&
        previous.previewCount === next.previewCount &&
        previous.previewVariant === next.previewVariant;
      if (!samePreview) pendingClamps.clear();
      else {
        for (const [field, style] of Object.entries(next.layout.fields)) {
          const before = previous.layout.fields[field] || options.defaultFieldStyle;
          if (
            before &&
            (style.x !== before.x || style.y !== before.y || style.scale !== before.scale)
          )
            pendingClamps.add(field);
        }
      }
      state = next;
      if (editing()) {
        if (
          previous?.sessionId !== next.sessionId ||
          previous.previewCount !== next.previewCount ||
          previous.previewVariant !== next.previewVariant
        ) {
          gesture = null;
          options.renderPreview?.(next);
        }
      } else if (previous?.sessionId) {
        gesture = null;
        commands.length = 0;
        options.resetPreview?.();
      }
      scheduleLayout();
    }

    async function sendPending() {
      if (sending || !commands.length || !editing()) return;
      sending = true;
      const sessionId = state.sessionId;
      const command = commands.shift();
      inFlight = command;
      let failure = null;
      try {
        const next = await api.editLayout(sessionId, command);
        inFlight = null;
        if (state?.sessionId === sessionId && !gesture) {
          accept(next);
          applyLayout();
        }
      } catch (error) {
        failure = error;
        if (state?.sessionId === sessionId) commands.unshift(command);
        console.warn("[Overlay] overlay layout edit failed", String(error));
      } finally {
        inFlight = null;
        sending = false;
        if (!failure && commands.length) void sendPending();
        else {
          for (const waiter of drains.splice(0)) {
            if (failure) waiter.reject(failure);
            else waiter.resolve();
          }
        }
      }
    }

    function send(command) {
      const last = commands[commands.length - 1];
      if (command.type === "field" && last?.type === "field" && last.field === command.field) {
        last.patch = { ...last.patch, ...command.patch };
      } else commands.push(command);
      void sendPending();
    }

    function selectField(field) {
      if (!editing()) return;
      state = { ...state, selectedField: field };
      send({ type: "select", field });
      scheduleLayout();
    }

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!editing() || event.button !== 0) return;
        const target =
          event.target instanceof Element ? event.target.closest("[data-reward-field]") : null;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        // Preventing the default also blocks focus entering this iframe from a host input.
        root.tabIndex = -1;
        root.focus({ preventScroll: true });
        const field = target.dataset.rewardField;
        const style = state.layout.fields[field] || options.defaultFieldStyle;
        const offset = field
          ? getComputedStyle(target).translate.split(" ").map(Number.parseFloat)
          : [];
        gesture = {
          field,
          x: event.clientX,
          y: event.clientY,
          style: {
            ...style,
            x: Number.isFinite(offset[0]) ? offset[0] : 0,
            y: Number.isFinite(offset[1]) ? offset[1] : 0,
          },
        };
        if (field) selectField(field);
        target.setPointerCapture(event.pointerId);
      },
      true,
    );

    document.addEventListener("pointermove", (event) => {
      if (!gesture || !editing()) return;
      if (!(event.buttons & 1)) {
        finishGesture();
        return;
      }
      if (gesture.field) {
        const patch = {
          x: gesture.style.x + (event.clientX - gesture.x) / coordinateScale(),
          y: gesture.style.y + (event.clientY - gesture.y) / coordinateScale(),
        };
        state.layout.fields[gesture.field] = { ...gesture.style, ...patch };
        pendingClamps.add(gesture.field);
        applyLayout();
        const positioned = state.layout.fields[gesture.field];
        send({ type: "field", field: gesture.field, patch: { x: positioned.x, y: positioned.y } });
      }
    });

    function finishGesture() {
      gesture = null;
      void sendPending();
    }
    document.addEventListener("pointerup", finishGesture);
    document.addEventListener("pointercancel", finishGesture);
    document.addEventListener("lostpointercapture", finishGesture);
    window.addEventListener("blur", finishGesture);
    document.addEventListener("contextmenu", (event) => {
      if (editing()) event.preventDefault();
    });
    window.addEventListener("resize", scheduleLayout);
    document.addEventListener("scroll", scheduleLayout, true);
    void document.fonts.ready.then(scheduleLayout);
    new MutationObserver(scheduleLayout).observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    api.onLayout(accept);
    void api
      .getLayout()
      .then(accept)
      .catch((error) => {
        console.warn("[Overlay] overlay layout unavailable", String(error));
      });
    scheduleLayout();
    const editor = {
      flush: () => {
        gesture = null;
        applyLayout();
        if (!sending && !commands.length) return Promise.resolve();
        return new Promise((resolve, reject) => {
          drains.push({ resolve, reject });
          void sendPending();
        });
      },
      isEditing: editing,
      refresh: scheduleLayout,
      cancel: () => {
        if (editing()) {
          commands.length = 0;
          void api
            .endLayout(state.sessionId, false)
            .then(accept)
            .catch((error) => {
              console.warn("[Overlay] overlay layout cancel failed", String(error));
            });
        }
      },
    };
    if (preview) {
      window.rewardEditorSelection = {
        get field() {
          return state?.selectedField;
        },
        select: selectField,
      };
      window.flushRewardEditor = editor.flush;
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && editing()) editor.cancel();
        if (!editing() || event.altKey || event.ctrlKey || event.metaKey || gesture) return;
        if (
          event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]")
        )
          return;
        const delta = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[event.key];
        if (!delta) return;
        event.preventDefault();
        const field = state.selectedField;
        const style = state.layout.fields[field] || options.defaultFieldStyle;
        const step = event.shiftKey ? 10 : 1;
        state.layout.fields[field] = {
          ...style,
          x: style.x + delta[0] * step,
          y: style.y + delta[1] * step,
        };
        pendingClamps.add(field);
        applyLayout();
        const positioned = state.layout.fields[field];
        send({ type: "field", field, patch: { x: positioned.x, y: positioned.y } });
      });
    }
    return editor;
  };
})();
