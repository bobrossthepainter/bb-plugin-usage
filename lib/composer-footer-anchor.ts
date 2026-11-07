// Placement of the session footer inside bb's native composer footer.
//
// bb exposes no composer status-line slot (SDK 0.6.x: actions, banners and
// menus only), so the footer is portaled into the composer's DOM. Every bb
// selector this plugin relies on lives here. When bb's markup changes, the
// fallbacks degrade from "beside the context gauge" to "start of the footer's
// right-hand group" to "not shown" — never into an error or a misplaced node.

declare const __BB_PLUGIN_ID__: string | undefined;

export const COMPOSER_SELECTOR = "[data-follow-up-composer]";
export const FOOTER_SELECTOR = "[data-follow-up-composer-footer]";
export const CONTEXT_GAUGE_SELECTOR = 'button[aria-label^="Context window"], button[aria-label*="context" i]';
export const HOST_ATTRIBUTE = "data-bb-usage-session-indicator";

export type FooterPlacement = { parent: Element; before: Node | null; kind: "gauge" | "right-group" };

/** Where the footer belongs in this composer's footer, or null when bb's footer is not recognisable. */
export function findFooterPlacement(composer: Element): FooterPlacement | null {
  const footer = composer.querySelector(FOOTER_SELECTOR);
  if (!footer) return null;
  const gauge = footer.querySelector(CONTEXT_GAUGE_SELECTOR);
  // The gauge may sit inside a tooltip/trigger wrapper; place beside the
  // outermost wrapper that is still a child of the gauge's control group.
  if (gauge?.parentElement && gauge.parentElement !== footer) {
    let node: Element = gauge;
    while (node.parentElement && node.parentElement.childElementCount === 1 && node.parentElement.parentElement !== footer) {
      node = node.parentElement;
    }
    if (node.parentElement) return { parent: node.parentElement, before: node, kind: "gauge" };
  }
  // No gauge (e.g. before the first response): the footer is a left/right
  // pair; the footer goes first in the right-hand group.
  const right = footer.childElementCount >= 2 ? footer.lastElementChild : null;
  if (right) return { parent: right, before: right.firstChild, kind: "right-group" };
  return null;
}

export function createFooterHost(doc: Document = document) {
  const host = doc.createElement("span");
  host.setAttribute(HOST_ATTRIBUTE, "");
  // The plugin's compiled CSS is scoped to its root; carry the scope so its
  // utility classes apply inside bb's footer.
  host.setAttribute("data-bb-plugin-root", "");
  if (typeof __BB_PLUGIN_ID__ === "string") host.setAttribute("data-bb-plugin", __BB_PLUGIN_ID__);
  // Inline, so placement never depends on host utility classes.
  Object.assign(host.style, {
    display: "flex",
    alignItems: "center",
    minWidth: "0",
    maxWidth: "min(62vw, 40rem)",
    overflow: "hidden",
  });
  return host;
}

/**
 * Keep a footer host placed in the composer that contains `anchor`, calling
 * `onHost` with it while placed and with null otherwise. Returns a disposer.
 */
export function attachFooterHost(anchor: Element, onHost: (host: HTMLElement | null) => void) {
  const composer = anchor.closest(COMPOSER_SELECTOR);
  if (!composer) {
    onHost(null);
    return () => undefined;
  }
  const host = createFooterHost(anchor.ownerDocument);
  let placed = false;
  const place = () => {
    const target = findFooterPlacement(composer);
    if (!target) {
      if (host.isConnected) host.remove();
      if (placed) onHost((placed = false, null));
      return;
    }
    if (host.parentElement !== target.parent || (target.before !== host && host.nextSibling !== target.before)) {
      target.parent.insertBefore(host, target.before === host ? host.nextSibling : target.before);
    }
    if (!placed) onHost((placed = true, host));
  };
  place();
  // Mutations inside our own host are React renders, not bb re-layouts.
  const observer = new MutationObserver((records) => {
    if (records.every((record) => host.contains(record.target))) return;
    place();
  });
  observer.observe(composer, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    host.remove();
    onHost(null);
  };
}
