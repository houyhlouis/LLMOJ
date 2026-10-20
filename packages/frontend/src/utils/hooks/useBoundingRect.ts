import { useEffect, useState } from "react";

export function useBoundingRect<K extends keyof DOMRect, T extends HTMLElement = HTMLElement>(
  property: K
): [DOMRect[K], (element: T) => void, T];
export function useBoundingRect<T extends HTMLElement = HTMLElement>(): [DOMRect, (element: T) => void, T];

export function useBoundingRect<K extends keyof DOMRect, T extends HTMLElement = HTMLElement>(
  property?: K
): [DOMRect[K] | DOMRect, (element: T) => void, T] {
  const [element, setElement] = useState<T>();
  const [value, setValue] = useState<DOMRect[K] | DOMRect>(null);

  function update() {
    if (element) {
      const rect = element.getBoundingClientRect();
      if (property != null) setValue(rect[property]);
      else setValue(rect);
    }
  }

  useEffect(() => {
    if (element) {
      update();
      const resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(element);
      return () => resizeObserver.disconnect();
    }
  }, [element]);

  return [value, setElement, element];
}
