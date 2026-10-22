// One-time tips: fire at most once per profile, at the moment the feature becomes relevant.
// Remembered in the local settings file (no telemetry, nothing leaves the machine).
export function createHints({ settings, persist, toast }) {
  return {
    /** Shows `message` once, then remembers it. Returns true when it was actually shown. */
    once(key, message, duration = 6000) {
      if (settings[key]) return false;
      settings[key] = true;
      persist(key, true);
      toast(message, duration);
      return true;
    },
  };
}
