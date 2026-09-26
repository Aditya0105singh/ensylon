"use client";

import { useEffect } from "react";

/** Registers the installability service worker (see public/sw.js). Silently
 * no-ops on browsers without support (e.g. some in-app webviews) rather than
 * erroring - installability is a nice-to-have, never a hard requirement. */
export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
