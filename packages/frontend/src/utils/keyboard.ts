import type React from "react";

// Semantic UI renders a menu item, label or icon with only an onClick as an element the keyboard can't reach (an <a>
// without href, an <i>). Spread these props on it to make it a button: focusable with Tab, pressed with Enter or Space.
function clickOnEnterOrSpace(event: React.KeyboardEvent<HTMLElement>) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.currentTarget.click();
  }
}

export const actsAsButton = {
  tabIndex: 0,
  role: "button",
  onKeyDown: clickOnEnterOrSpace
} as const;

// A Semantic UI dropdown built from <Dropdown.Item> children (instead of `options`) opens from the keyboard, but its
// items can't be chosen: the arrow keys and Enter only work with `options`. Spread this on such a <Dropdown> to make
// the arrow keys move through its items and Enter or Space choose one, while the focus stays on the dropdown.
export const keyboardMenu = { "data-keyboard-menu": "" } as const;

const HIGHLIGHT = "data-keyboard-highlight";
let nextItemId = 0;

function menuItems(dropdown: HTMLElement) {
  return Array.from(dropdown.querySelectorAll<HTMLElement>(":scope > .menu > .item")).filter(
    item => !item.classList.contains("disabled") && item.getClientRects().length > 0
  );
}

function highlight(dropdown: HTMLElement, item: HTMLElement | null) {
  for (const previous of Array.from(dropdown.querySelectorAll(`[${HIGHLIGHT}]`))) previous.removeAttribute(HIGHLIGHT);
  if (!item) {
    dropdown.removeAttribute("aria-activedescendant");
    return;
  }
  if (!item.id) item.id = `keyboard-menu-item-${++nextItemId}`;
  item.setAttribute(HIGHLIGHT, "");
  dropdown.setAttribute("aria-activedescendant", item.id);
  item.scrollIntoView?.({ block: "nearest" });
}

export function onKeyboardMenuKeyDown(event: KeyboardEvent) {
  const dropdown = event.target as HTMLElement;
  if (!(dropdown instanceof HTMLElement) || !dropdown.matches("[data-keyboard-menu]")) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;

  const open = dropdown.classList.contains("active");
  const items = open ? menuItems(dropdown) : [];
  const current = items.findIndex(item => item.hasAttribute(HIGHLIGHT));

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const step = event.key === "ArrowDown" ? 1 : -1;
    if (!open) {
      // The dropdown opens itself on an arrow key; start from its first (or last) item once it shows them.
      requestAnimationFrame(() => {
        const shown = menuItems(dropdown);
        highlight(dropdown, (step > 0 ? shown[0] : shown[shown.length - 1]) || null);
      });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (items.length === 0) return;
    const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
    highlight(dropdown, items[next]);
  } else if ((event.key === "Enter" || event.key === " ") && open && current >= 0) {
    event.preventDefault();
    event.stopPropagation();
    const item = items[current];
    highlight(dropdown, null);
    item.click();
  } else if (event.key === "Escape" || event.key === "Tab") {
    highlight(dropdown, null);
  }
}

let installed = false;

// Listens before Semantic UI's own handlers, so a chosen item isn't also taken as a click on the dropdown.
export function installKeyboardMenus() {
  if (installed) return;
  installed = true;
  document.addEventListener("keydown", onKeyboardMenuKeyDown, true);
}
