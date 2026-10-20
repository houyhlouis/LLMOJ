// What browser code gets for Node's "util" (see vite.config.ts): the one function a dependency (markdown-it-regexp)
// uses.
export function inherits(constructor: { prototype: object }, superConstructor: { prototype: object }): void {
  Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
  Object.defineProperty(constructor, "super_", { value: superConstructor, writable: true, configurable: true });
}

export default { inherits };
