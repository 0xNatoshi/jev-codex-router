const MAX_EXACT_JSON_NUMBER_LENGTH = 4096;
const JSON_NUMBER_PARTS =
  /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

// Normalize a bounded JSON number as an exact decimal coefficient + power.
// This compares mathematical decimal values rather than spellings, so 1.0 and
// 1e3 can survive a rewrite when JSON.stringify emits 1 and 1000 respectively,
// while underflow and rounded high-precision tokens cannot.
function canonicalDecimalToken(token) {
  if (typeof token !== "string" || token.length > MAX_EXACT_JSON_NUMBER_LENGTH) {
    return undefined;
  }
  const match = JSON_NUMBER_PARTS.exec(token);
  if (!match) return undefined;
  const [, sign, integer, fraction = "", exponentText = "0"] = match;
  let digits = integer + fraction;
  if (/^0+$/u.test(digits)) return sign === "-" ? "-0" : "0";

  const exponentSign = exponentText.startsWith("-") ? -1 : 1;
  const unsignedExponent = exponentText.replace(/^[+-]/u, "");
  const significantExponent = unsignedExponent.replace(/^0+/u, "") || "0";
  // A non-zero finite Number cannot retain an exponent remotely this large;
  // bounding it also prevents attacker-controlled giant integer arithmetic.
  if (significantExponent.length > 6) return undefined;
  let exponent = exponentSign * Number(significantExponent) - fraction.length;

  digits = digits.replace(/^0+/u, "");
  const trailingZeros = /0+$/u.exec(digits)?.[0].length || 0;
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros);
    exponent += trailingZeros;
  }
  return `${sign}${digits}e${exponent}`;
}

// Permission to JSON.parse and later JSON.stringify a numeric token without
// changing its exact mathematical decimal value. JavaScript's Number parser
// can otherwise underflow or round a token while still returning a finite
// value, which would silently mutate unrelated response fields during a
// compatibility rewrite.
export function jsonNumberIsStableForRewrite(token) {
  if (typeof token !== "string" || token.length > MAX_EXACT_JSON_NUMBER_LENGTH) {
    return false;
  }
  const parsed = Number(token);
  if (
    !Number.isFinite(parsed) ||
    Object.is(parsed, -0) ||
    (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))
  ) {
    return false;
  }
  const original = canonicalDecimalToken(token);
  const serialized = canonicalDecimalToken(JSON.stringify(parsed));
  return original !== undefined && original === serialized;
}
