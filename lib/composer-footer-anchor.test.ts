// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachFooterHost, findFooterPlacement, HOST_ATTRIBUTE } from "./composer-footer-anchor";

// Shape of bb 0.47's follow-up composer footer (workspace-checkout-display bundle).
function composerMarkup({ gauge = true, wrapped = false } = {}) {
  const button = '<button type="button" aria-label="Context window 6% used"><svg></svg></button>';
  return `
    <div data-follow-up-composer>
      <div class="editor"><span id="anchor"></span></div>
      <div data-follow-up-composer-footer>
        <div id="left">workspace · branch</div>
        <div id="right"><span id="exec">model</span>${gauge ? (wrapped ? `<span id="wrap">${button}</span>` : button) : ""}</div>
      </div>
    </div>`;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("composer footer placement", () => {
  it("places the footer directly before the context gauge", () => {
    document.body.innerHTML = composerMarkup();
    const placement = findFooterPlacement(document.querySelector("[data-follow-up-composer]")!)!;
    expect(placement.kind).toBe("gauge");
    expect((placement.parent as HTMLElement).id).toBe("right");
    expect((placement.before as HTMLElement).tagName).toBe("BUTTON");
  });

  it("places before a single-child wrapper around the gauge", () => {
    document.body.innerHTML = composerMarkup({ wrapped: true });
    const placement = findFooterPlacement(document.querySelector("[data-follow-up-composer]")!)!;
    expect((placement.before as HTMLElement).id).toBe("wrap");
  });

  it("falls back to the start of the right-hand group without a gauge", () => {
    document.body.innerHTML = composerMarkup({ gauge: false });
    const placement = findFooterPlacement(document.querySelector("[data-follow-up-composer]")!)!;
    expect(placement.kind).toBe("right-group");
    expect((placement.parent as HTMLElement).id).toBe("right");
    expect((placement.before as HTMLElement).id).toBe("exec");
  });

  it("finds nothing when bb's footer is not recognisable", () => {
    document.body.innerHTML = '<div data-follow-up-composer><div class="footer"></div></div>';
    expect(findFooterPlacement(document.querySelector("[data-follow-up-composer]")!)).toBeNull();
  });
});

describe("attachFooterHost", () => {
  it("inserts a plugin-scoped host and re-places it after bb re-renders", async () => {
    document.body.innerHTML = composerMarkup();
    const onHost = vi.fn();
    const dispose = attachFooterHost(document.getElementById("anchor")!, onHost);
    const host = onHost.mock.calls[0]![0] as HTMLElement;
    expect(host.hasAttribute(HOST_ATTRIBUTE)).toBe(true);
    expect(host.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(host.nextElementSibling?.tagName).toBe("BUTTON");

    // bb re-renders its right-hand group, dropping foreign nodes.
    const right = document.getElementById("right")!;
    right.innerHTML = '<button type="button" aria-label="Context window 7% used"></button>';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(right.firstElementChild).toBe(host);
    expect(onHost).toHaveBeenCalledTimes(1);

    dispose();
    expect(document.querySelector(`[${HOST_ATTRIBUTE}]`)).toBeNull();
    expect(onHost).toHaveBeenLastCalledWith(null);
  });

  it("withdraws the host when the footer disappears", async () => {
    document.body.innerHTML = composerMarkup();
    const onHost = vi.fn();
    attachFooterHost(document.getElementById("anchor")!, onHost);
    document.querySelector("[data-follow-up-composer-footer]")!.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onHost).toHaveBeenLastCalledWith(null);
    expect(document.querySelector(`[${HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it("does nothing outside a follow-up composer", () => {
    document.body.innerHTML = '<span id="anchor"></span>';
    const onHost = vi.fn();
    attachFooterHost(document.getElementById("anchor")!, onHost)();
    expect(onHost).toHaveBeenCalledWith(null);
  });
});
