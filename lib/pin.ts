/**
 * Staff till PINs.
 *
 * The rule mirrors the check in `set_staff_pin` (`^[0-9]{4,8}$`). It lives here so the add form, the
 * reset dialog and the tests all agree: a PIN that the form accepts must never be rejected by the
 * server, and a PIN the server accepts must be typeable into the form.
 */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

const PIN_PATTERN = /^[0-9]{4,8}$/;

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

/**
 * Keep only what a PIN can contain, so pasting from elsewhere cannot smuggle in spaces or letters.
 * Applied on every keystroke, hence truncating rather than rejecting.
 */
export function sanitisePin(input: string): string {
  return input.replace(/\D/g, "").slice(0, PIN_MAX_LENGTH);
}
