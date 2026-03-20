const SLASH = '/'.charCodeAt(0);
const QUESTION = '?'.charCodeAt(0);
const AT = '@'.charCodeAt(0);
const UNDERSCORE = '_'.charCodeAt(0);
const LOWER_A = 'a'.charCodeAt(0);
const LOWER_Z = 'z'.charCodeAt(0);

export function controlChar(c: number) {
  if ((AT <= c && c <= UNDERSCORE) || (LOWER_A <= c && c <= LOWER_Z)) {
    return c & 0x1F;
  } else if (c === QUESTION) {
    return 0x1F;
  } else {
    if (c === SLASH) {
      return 0x1F;
    }
    if (c < QUESTION) {
      return c;
    }
    return c & 0x1F;
  }
}
