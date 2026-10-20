// Test-only preload for the e2e server (see playwright.config.ts). Shifts Date by
// E2E_CLOCK_OFFSET_MS so the save flows, which confirm the 09:00 suggested IN, do not
// depend on the hour the suite runs. Time keeps flowing; nothing else is changed.
// Covers the Node runtime only; Edge-runtime handlers would still see the real clock.
const OFFSET = Number(process.env.E2E_CLOCK_OFFSET_MS || 0);

if (OFFSET) {
  const RealDate = Date;
  // A plain function, so `Date()` without `new` still returns a string like the native one.
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + OFFSET).toString();
    return args.length === 0 ? new RealDate(RealDate.now() + OFFSET) : new RealDate(...args);
  }
  ShiftedDate.prototype = RealDate.prototype;
  // Own properties, not inherited ones: Next's middleware sandbox copies only those.
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;
  ShiftedDate.now = () => RealDate.now() + OFFSET;
  globalThis.Date = ShiftedDate;
}
