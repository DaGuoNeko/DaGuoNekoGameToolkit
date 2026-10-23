import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

// Browser snapshots animate the outgoing page without mounting a second live
// editor or duplicating its subscriptions, requests and form controls.
export function usePageNavigation(initialPage, order) {
  const [page, setPage] = useState(initialPage);
  const displayed = useRef(initialPage);
  const requested = useRef(initialPage);
  const sequence = useRef(0);
  const transition = useRef(null);

  useEffect(
    () => () => {
      sequence.current++;
      transition.current?.skipTransition();
      delete document.documentElement.dataset.pageDirection;
      delete document.documentElement.dataset.pageAnimating;
    },
    [],
  );

  function navigate(next) {
    if (!order.includes(next) || requested.current === next) return;
    requested.current = next;
    const ticket = ++sequence.current;
    transition.current?.skipTransition();
    transition.current = null;
    const finish = () => {
      if (sequence.current !== ticket) return;
      transition.current = null;
      delete document.documentElement.dataset.pageDirection;
      delete document.documentElement.dataset.pageAnimating;
    };
    const update = () => {
      // A skipped transition still invokes its callback; never apply an old route.
      if (sequence.current !== ticket) return;
      flushSync(() => setPage(next));
      displayed.current = next;
    };
    if (
      next === displayed.current ||
      !document.startViewTransition ||
      document.visibilityState === "hidden" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      update();
      finish();
      return;
    }
    document
      .querySelectorAll(":popover-open")
      .forEach((popup) => popup.hidePopover());
    document.documentElement.dataset.pageDirection =
      order.indexOf(next) > order.indexOf(displayed.current)
        ? "forward"
        : "backward";
    document.documentElement.dataset.pageAnimating = "true";
    const current = document.startViewTransition(update);
    transition.current = current;
    // Skipping during rapid navigation rejects ready even though the route update succeeds.
    current.ready.catch(() => {});
    current.finished.then(finish, (error) => {
      finish();
      console.error("页面切换失败", error);
    });
  }
  return [page, navigate];
}
