import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useLogFollow(
  consoleRef,
  scope,
  source,
  search,
  level,
  settingsOpen,
) {
  const following = useRef(true),
    anchor = useRef(null);
  const [isFollowing, setFollowing] = useState(true);
  const remember = useCallback(() => {
    const el = consoleRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 4;
    following.current = bottom;
    setFollowing(bottom);
    if (bottom) {
      anchor.current = null;
      return;
    }
    const top = el.getBoundingClientRect().top,
      rows = el.children;
    let low = 0,
      high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
      else high = middle;
    }
    const row = rows[low];
    anchor.current = {
      id: row?.dataset.logId,
      offset: row ? row.getBoundingClientRect().top - top : 0,
      scrollTop: el.scrollTop,
    };
  }, [consoleRef]);
  const align = useCallback(() => {
    const el = consoleRef.current;
    if (!el) return;
    if (following.current) el.scrollTop = el.scrollHeight;
    else if (anchor.current) {
      const saved = anchor.current;
      const row = saved.id
        ? el.querySelector(`[data-log-id="${saved.id}"]`)
        : null;
      if (row)
        el.scrollTop +=
          row.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          saved.offset;
      else el.scrollTop = saved.scrollTop;
    }
    remember();
  }, [consoleRef, remember]);
  useLayoutEffect(() => {
    following.current = true;
    anchor.current = null;
    align();
  }, [scope, align]);
  useLayoutEffect(align, [source, search, level, settingsOpen, align]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(align);
    if (consoleRef.current) observer.observe(consoleRef.current);
    return () => observer.disconnect();
  }, [align, consoleRef]);
  const scrollToBottom = useCallback(() => {
    following.current = true;
    anchor.current = null;
    align();
  }, [align]);
  const scrollToEntry = useCallback(
    (id) => {
      const el = consoleRef.current,
        row = el?.querySelector(`[data-log-id="${id}"]`);
      if (!row) return;
      following.current = false;
      el.scrollTop +=
        row.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        el.clientHeight / 2;
      remember();
    },
    [consoleRef, remember],
  );
  return { isFollowing, onScroll: remember, scrollToBottom, scrollToEntry };
}
