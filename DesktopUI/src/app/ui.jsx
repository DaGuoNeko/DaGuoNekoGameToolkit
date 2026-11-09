import React, { useEffect, useRef, useState, useId } from "react";

const paths = {
  archive: (
    <>
      <rect x="3" y="3" width="18" height="5" rx="1" />
      <path d="M5 8v12h14V8M9 12h6" />
    </>
  ),
  "launch-profile": (
    <>
      <path d="M11 21H5V3h14v7M8 7h7M8 11h3" />
      <path d="m15 13 6 4-6 4z" />
    </>
  ),
  gamepad: (
    <>
      <path d="M7 6h10a4 4 0 0 1 4 3l1 8a2 2 0 0 1-3 2l-3-3H8l-3 3a2 2 0 0 1-3-2l1-8a4 4 0 0 1 4-3Z" />
      <path d="M5 11h5M7.5 8.5v5" />
      <circle cx="15.5" cy="10" r=".7" fill="currentColor" />
      <circle cx="18.5" cy="12.5" r=".7" fill="currentColor" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m6 8 3 3-3 3M12 14h6M6 17h12" />
    </>
  ),
  bug: (
    <>
      <rect x="7" y="7" width="10" height="13" rx="5" />
      <path d="m9 7-2-4m8 4 2-4M7 11H3m14 0h4M7 16H3m14 0h4M7 19l-3 2m13-2 3 2M12 8v12" />
    </>
  ),
  inspect: (
    <>
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
      <rect x="8" y="8" width="8" height="8" rx="1" />
      <path d="M12 5v3m0 8v3M5 12h3m8 0h3" />
    </>
  ),
  activity: (
    <>
      <path d="M3 3v18h18M6 14l4-7 4 10 4-6h3" />
    </>
  ),
  "layout-edit": (
    <>
      <path d="M9 20H3V4h17v5M3 8h17M8 8v12" />
      <path d="m12 17 7-7 3 3-7 7-4 1zM17 12l3 3" />
    </>
  ),
  gear: (
    <>
      <path d="m9 3 1-1h4l1 3 2 1 3-.5 2 3-2 2v3l2 2-2 3-3-.5-2 1-1 3h-4l-1-3-2-1-3 .5-2-3 2-2v-3l-2-2 2-3 3 .5 2-1z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  sound: (
    <>
      <path d="M4 10h4l5-5v14l-5-5H4zM16 9a5 5 0 0 1 0 6M19 6a9 9 0 0 1 0 12" />
    </>
  ),
  skin: (
    <>
      <circle cx="12" cy="8" r="3" />
      <path d="M5 21v-3a7 7 0 0 1 14 0v3" />
    </>
  ),
  cube: (
    <>
      <path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8" />
    </>
  ),
  text: (
    <>
      <path d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3" />
    </>
  ),
  tools: (
    <>
      <path d="m14 6 4 4M10 14l-6 6-2-2 6-6M13 3a6 6 0 0 0 8 8l-4 4-8-8z" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z" />,
  settings: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v.1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" />
    </>
  ),
  import: (
    <>
      <path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5" />
    </>
  ),
  arrow: <path d="m14 5-7 7 7 7" />,
  up: <path d="m6 14 6-6 6 6" />,
  down: <path d="m6 10 6 6 6-6" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5" />
    </>
  ),
  edit: (
    <>
      <path d="m14 4 6 6M4 20l1-6L16 3l5 5-11 11z" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V3h6v4M6 7l1 14h10l1-14M10 11v6M14 11v6" />
    </>
  ),
  external: (
    <>
      <path d="M13 3h8v8m0-8L10 14M10 5H4v15h15v-6" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1" />
      <path d="m3 17 6-6 4 4 3-3 5 5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M19 5l-1 1M6 18l-1 1" />
    </>
  ),
  moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z" />,
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M12 17v4M8 21h8" />
    </>
  ),
};
export function Icon({ name, size = 18, ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.cube}
    </svg>
  );
}
export function Button({
  icon,
  children,
  primary,
  danger,
  compact = false,
  className = "",
  title,
  ...props
}) {
  return (
    <button
      className={`button ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${!children || compact ? "icon-button" : ""} ${className}`}
      title={title ?? (compact && typeof children === "string" ? children : undefined)}
      {...props}
    >
      {icon && <Icon name={icon} />} {compact ? <span className="visually-hidden">{children}</span> : children}
    </button>
  );
}

// The browser top layer keeps the menu above scrolling panels and modal content.
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "请选择",
  className = "",
  ...labelProps
}) {
  const id = useId();
  const trigger = useRef(null);
  const menu = useRef(null);
  const searchInput = useRef(null);
  const [query, setQuery] = useState("");
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const selected = options.findIndex((option) => option.value === value);
  const enabled = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);
  const matching = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) =>
      `${option.label} ${option.value}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
  const matchingEnabled = matching
    .filter(({ option }) => !option.disabled)
    .map(({ index }) => index);
  const activeIndex = matchingEnabled.includes(active)
    ? active
    : (matchingEnabled[0] ?? -1);

  function position() {
    const rect = trigger.current.getBoundingClientRect();
    const below = innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const desiredHeight = Math.min(336, options.length * 36 + 64);
    const upward = below < desiredHeight && above > below;
    const height = Math.max(0, Math.min(desiredHeight, upward ? above : below));
    const context = document.createElement("canvas").getContext("2d");
    const font = getComputedStyle(trigger.current);
    context.font = `${font.fontSize} ${font.fontFamily}`;
    const labelWidth = Math.max(
      0,
      ...options.map((option) => context.measureText(option.label).width),
    );
    const width = Math.min(
      Math.max(rect.width, labelWidth + 76, 220),
      420,
      innerWidth - 24,
    );
    Object.assign(menu.current.style, {
      width: `${width}px`,
      maxHeight: `${height}px`,
      height: `${height}px`,
      left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`,
      top: `${Math.max(12, Math.min(upward ? rect.top - height - 6 : rect.bottom + 6, innerHeight - height - 12))}px`,
    });
  }

  function close() {
    menu.current.hidePopover();
    setOpen(false);
    setQuery("");
    search.current = { text: "", time: 0 };
  }

  function expand(
    index = selected >= 0 && !options[selected].disabled
      ? selected
      : enabled[0],
  ) {
    if (trigger.current.matches(":disabled") || enabled.length === 0) return;
    position();
    setQuery("");
    setActive(index ?? -1);
    menu.current.showPopover();
    setOpen(true);
  }

  function choose(index) {
    if (
      !options[index] ||
      options[index].disabled ||
      (open && !matchingEnabled.includes(index))
    )
      return;
    close();
    trigger.current.focus();
    if (options[index].value !== value) onChange(options[index].value);
  }

  useEffect(() => {
    const popup = menu.current;
    const sync = (event) => {
      setOpen(event.newState === "open");
      if (event.newState === "closed") {
        search.current = { text: "", time: 0 };
        setQuery("");
      }
    };
    popup.addEventListener("toggle", sync);
    return () => popup.removeEventListener("toggle", sync);
  }, []);

  useEffect(() => {
    if (open) searchInput.current.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (
      disabled ||
      trigger.current.matches(":disabled") ||
      enabled.length === 0
    ) {
      close();
      return;
    }
    position();
    const reposition = (event) => {
      if (!menu.current.contains(event.target)) position();
    };
    const observer = new ResizeObserver(position);
    observer.observe(trigger.current);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open, disabled, options.length]);

  useEffect(() => {
    if (open)
      menu.current
        .querySelector(`[data-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function keyDown(event) {
    if (
      event.isComposing ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    const visible = menu.current.matches(":popover-open");
    const typing = event.target === searchInput.current;
    const navigable = visible ? matchingEnabled : enabled;
    if (typing && ["Home", "End", " "].includes(event.key)) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const current = navigable.indexOf(activeIndex);
      const next =
        event.key === "Home"
          ? navigable[0]
          : event.key === "End"
            ? navigable.at(-1)
            : navigable[
                Math.max(
                  0,
                  Math.min(
                    navigable.length - 1,
                    current + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                )
              ];
      if (visible) setActive(next ?? -1);
      else
        expand(
          event.key === "Home"
            ? enabled[0]
            : event.key === "End"
              ? enabled.at(-1)
              : undefined,
        );
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (visible) choose(activeIndex);
      else expand();
    } else if (event.key === "Escape" && visible) {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.current.focus();
    } else if (event.key === "Tab") {
      if (visible) {
        trigger.current.focus();
        close();
      }
    } else if (
      !typing &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing
    ) {
      const now = Date.now();
      const text =
        (now - search.current.time < 700 ? search.current.text : "") +
        event.key.toLowerCase();
      search.current = { text, time: now };
      const repeated = [...text].every((char) => char === text[0]);
      const prefix = repeated ? text[0] : text;
      const start = visible ? activeIndex : selected;
      const candidates = [
        ...enabled.filter((i) => i > start),
        ...enabled.filter((i) => i <= start),
      ];
      const match = candidates.find((i) =>
        String(options[i].label).toLowerCase().startsWith(prefix),
      );
      if (match !== undefined) {
        event.preventDefault();
        if (visible) setActive(match);
        else choose(match);
      }
    }
  }

  return (
    <div className={`select-control ${className}`}>
      <button
        {...labelProps}
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined
        }
        className="select-trigger"
        disabled={disabled || enabled.length === 0}
        onClick={() =>
          menu.current.matches(":popover-open") ? close() : expand()
        }
        onKeyDown={keyDown}
        onBlur={(event) => {
          if (!menu.current.contains(event.relatedTarget)) close();
        }}
      >
        <span
          className={
            selected < 0 || options[selected].value === ""
              ? "select-placeholder"
              : ""
          }
          title={selected < 0 ? placeholder : options[selected].label}
        >
          {selected < 0 ? placeholder : options[selected].label}
        </span>
        <Icon name="down" size={16} />
      </button>
      <div
        ref={menu}
        popover="auto"
        className="select-menu"
        onBlurCapture={(event) => {
          if (
            !menu.current.contains(event.relatedTarget) &&
            event.relatedTarget !== trigger.current
          )
            close();
        }}
      >
        <div className="select-search">
          <Icon name="search" size={15} />
          <input
            ref={searchInput}
            type="search"
            aria-label="搜索选项"
            aria-controls={id}
            aria-activedescendant={
              open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined
            }
            placeholder="搜索名称或 ID…"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={keyDown}
          />
          {query && (
            <button
              type="button"
              className="bare"
              aria-label="清空选项搜索"
              onClick={() => {
                setQuery("");
                searchInput.current.focus();
              }}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        <div
          id={id}
          role="listbox"
          className="select-options"
          aria-label={labelProps["aria-label"]}
          aria-labelledby={labelProps["aria-labelledby"]}
        >
          {matching.map(({ option, index }) => (
            <div
              id={`${id}-${index}`}
              key={option.value}
              role="option"
              aria-selected={index === selected}
              aria-disabled={option.disabled || undefined}
              data-index={index}
              data-active={index === activeIndex}
              className="select-option"
              title={option.label}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => {
                if (!option.disabled) setActive(index);
              }}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {index === selected && <Icon name="check" size={16} />}
            </div>
          ))}
        </div>
        {!matching.length && (
          <div className="select-empty" role="status">
            没有匹配的选项
          </div>
        )}
      </div>
    </div>
  );
}

export function useValidation(errors) {
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState({});
  return {
    field(key) {
      const touch = () =>
        setTouched((old) => (old[key] ? old : { ...old, [key]: true }));
      return {
        error: attempted || touched[key] ? errors[key] : "",
        onChangeCapture: touch,
        onBlurCapture: touch,
      };
    },
    check() {
      setAttempted(true);
      const valid = !Object.values(errors).some(Boolean);
      if (!valid)
        requestAnimationFrame(() => {
          const scope =
            document.querySelector("dialog[open]") ||
            document.querySelector("main");
          scope?.querySelector('[aria-invalid="true"]')?.focus();
        });
      return valid;
    },
  };
}

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
  ...props
}) {
  const id = useId();
  const bind = (child) => {
    if (!React.isValidElement(child)) return child;
    if (
      ["input", "select", "textarea"].includes(child.type) ||
      child.type === Select
    )
      return React.cloneElement(child, {
        "aria-labelledby": id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby":
          [hint && id + "-hint", error && id + "-error"]
            .filter(Boolean)
            .join(" ") || undefined,
      });
    if (typeof child.type === "string" && child.props.children)
      return React.cloneElement(
        child,
        {},
        React.Children.map(child.props.children, bind),
      );
    return child;
  };
  return (
    <div className={`field ${className}`} {...props}>
      <span id={id}>{label}</span>
      {React.Children.map(children, bind)}
      {hint && <small id={id + "-hint"}>{hint}</small>}
      {error && (
        <small className="field-error" id={id + "-error"}>
          {error}
        </small>
      )}
    </div>
  );
}
export function ErrorBox({ children }) {
  return children ? (
    <div className="error-box" role="alert">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  ) : null;
}
export function Empty({ icon = "folder", title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={32} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function HelpDisclosure({ label = "使用说明", children }) {
  return (
    <details className="help-disclosure">
      <summary><Icon name="info" size={14} />{label}</summary>
      <div className="help-disclosure-body">{children}</div>
    </details>
  );
}
export function Section({ title, description, children, action, descriptionInline = false }) {
  return (
    <section className="section">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          {description && (descriptionInline ? <p>{description}</p> : (
            <HelpDisclosure label={title + "说明"}>{description}</HelpDisclosure>
          ))}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Search({ value, onChange, placeholder = "搜索名称…" }) {
  return (
    <div className="search">
      <Icon name="search" size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          className="bare"
          aria-label="清除搜索"
          onClick={() => onChange("")}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
export function HelpButton({ page, report }) {
  const [opening, setOpening] = useState(false);
  return (
    <Button
      icon="info"
      disabled={opening}
      title="在浏览器中打开帮助文档"
      onClick={async () => {
        setOpening(true);
        try {
          await window.toolkit.call("web.open", { kind: "help", page });
        } catch (error) {
          report(new Error(`无法打开帮助文档：${error.message}`));
        } finally {
          setOpening(false);
        }
      }}
    >
      帮助
    </Button>
  );
}

export function FileDropZone({
  as: Tag = "div",
  onFiles,
  report,
  disabled = false,
  blockWhenModal = false,
  hint = "松开以添加文件",
  className = "",
  children,
  ...props
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0),
    pending = useRef(false),
    alive = useRef(true);
  const handleFiles = useRef(onFiles);
  handleFiles.current = onFiles;
  useEffect(() => {
    alive.current = true;
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset);
    return () => {
      alive.current = false;
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset);
    };
  }, []);
  const blocked = () =>
    disabled ||
    pending.current ||
    document.querySelector('dialog[open][data-busy="true"]') ||
    (blockWhenModal && document.querySelector("dialog[open]"));
  const isFiles = (event) =>
    Array.from(event.dataTransfer.types).includes("Files");
  return (
    <Tag
      {...props}
      className={`file-drop-zone ${dragging ? "drag-active" : ""} ${className}`}
      onDragEnter={(event) => {
        if (!isFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!blocked()) {
          depth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (!isFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = blocked() ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      }}
      onDrop={async (event) => {
        if (!isFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setDragging(false);
        if (blocked() || event.currentTarget.closest("fieldset:disabled"))
          return;
        pending.current = true;
        try {
          const paths = await window.toolkit.droppedFiles(
            Array.from(event.dataTransfer.files),
          );
          if (alive.current) await handleFiles.current(paths);
        } catch (error) {
          if (alive.current) report(error);
        } finally {
          pending.current = false;
        }
      }}
    >
      {dragging && (
        <div className="drop-feedback" role="status">
          <span>{hint}</span>
        </div>
      )}
      {children}
    </Tag>
  );
}

export function Intro({ title, subtitle, children }) {
  return (
    <div className="intro">
      <div>
        <h1>{title}</h1>
        {subtitle && <HelpDisclosure label={title + "使用说明"}>{subtitle}</HelpDisclosure>}
      </div>
      <div className="intro-actions">{children}</div>
    </div>
  );
}
export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  wide = false,
  inline = false,
  busy = false,
  initialFocus,
  onFiles,
  dropReport,
  dropHint = "松开以添加模型、贴图或动画文件",
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (inline) return;
    const previous = document.activeElement;
    ref.current.showModal();
    if (initialFocus) ref.current.querySelector(initialFocus)?.focus();
    return () => {
      previous?.focus();
    };
  }, [inline]);
  const Frame = inline ? "section" : "dialog";
  return (
    <Frame
      ref={ref}
      aria-label={inline ? title : undefined}
      className={inline ? "workspace-surface" : `modal ${wide ? "wide" : ""}`}
      data-busy={busy}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-header">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <Button
          icon="close"
          aria-label={inline ? "返回工作区" : "关闭弹窗"}
          onClick={onClose}
          disabled={busy}
        />
      </div>
      {onFiles ? (
        <FileDropZone
          className="modal-body"
          onFiles={onFiles}
          report={dropReport}
          disabled={busy}
          hint={dropHint}
        >
          {children}
        </FileDropZone>
      ) : (
        <div className="modal-body">{children}</div>
      )}
      {footer && <div className="modal-footer">{footer}</div>}
    </Frame>
  );
}
const imageCache = new Map();
let imageCacheBytes = 0;
function cachedImage(key, read) {
  if (imageCache.has(key)) {
    const entry = imageCache.get(key); imageCache.delete(key); imageCache.set(key, entry); return entry.promise;
  }
  const entry = { bytes: 0, promise: null };
  entry.promise = read().then(value => {
    if (imageCache.get(key) === entry) {
      entry.bytes = value.length * 2; imageCacheBytes += entry.bytes;
      while (imageCache.size > 32 || imageCacheBytes > 32 * 1024 * 1024) {
        const oldest = imageCache.keys().next().value; imageCacheBytes -= imageCache.get(oldest).bytes; imageCache.delete(oldest);
      }
    }
    return value;
  }).catch(() => { if (imageCache.get(key) === entry) imageCache.delete(key); return ""; });
  imageCache.set(key, entry);
  while (imageCache.size > 32) { const oldest = imageCache.keys().next().value; imageCacheBytes -= imageCache.get(oldest).bytes; imageCache.delete(oldest); }
  return entry.promise;
}
export function LocalImage({
  path,
  thumbnail = false,
  className = "",
  alt = "",
}) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let alive = true;
    setSource("");
    if (!path) return;
    const key = path + thumbnail;
    cachedImage(key, () => window.toolkit.call("image.read", { path, thumbnail })).then((value) => {
      if (alive) setSource(value);
    });
    return () => {
      alive = false;
    };
  }, [path, thumbnail]);
  return source ? (
    <img className={className} src={source} alt={alt} />
  ) : (
    <span className={`image-placeholder ${className}`}>
      <Icon name="image" />
    </span>
  );
}
export function PathField({
  label,
  value,
  onChange,
  kind,
  multiple = false,
  hint,
  ...fieldProps
}) {
  const [error, setError] = useState("");
  async function pick() {
    try {
      setError("");
      const files = await window.toolkit.call("files.pick", { kind, multiple });
      if (files.length) onChange(multiple ? files : files[0]);
    } catch (e) {
      setError(e.message);
    }
  }
  function acceptDrop(files) {
    if (files.some((file) => file.directory)) throw new Error("请拖入文件");
    files = files.map((file) => file.path);
    const extensions = {
      skin: ["png"],
      texture: ["png"],
      geo: ["json"],
      animation: ["json"],
      background: ["png", "jpg", "jpeg", "webp", "bmp", "gif"],
      sound: ["ogg"],
      python: ["py"],
      executable: ["exe"],
    }[kind];
    if (
      !extensions ||
      files.some(
        (file) => !extensions.includes(file.split(".").pop().toLowerCase()),
      )
    )
      throw new Error(`拖入的文件类型不适用于“${label}”`);
    if (!multiple && files.length !== 1)
      throw new Error(`“${label}”每次只能选择一个文件`);
    setError("");
    return onChange(multiple ? files : files[0]);
  }
  return (
    <FileDropZone
      onFiles={acceptDrop}
      report={(error) => setError(error.message)}
      hint={`松开以设置${label}`}
    >
      <Field label={label} hint={hint} {...fieldProps}>
        <div className="path-field">
          <input
            value={value || ""}
            readOnly
            placeholder="尚未选择"
            title={value}
          />
          <Button icon="folder" aria-label={`选择${label}`} onClick={pick}>
            选择
          </Button>
        </div>
        <small className="drop-field-hint">也可将文件拖到此处</small>
      </Field>
      <ErrorBox>{error}</ErrorBox>
    </FileDropZone>
  );
}
export const basename = (path) => path.split(/[\\/]/).pop() || "";
