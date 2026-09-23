/**
 * Every module here looks its elements up by id in `index.html`. Throwing with
 * the selector in the message is far more useful than the `null` that
 * `querySelector` would otherwise hand back three calls later.
 */
export function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`missing element: ${selector}`);
  return element;
}

/** For elements that legitimately may not be on the page. */
export function findElement<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
