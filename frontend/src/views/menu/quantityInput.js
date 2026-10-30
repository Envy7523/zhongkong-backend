// Keep whole quantities unpadded, and limit edited quantities to two decimals.
// Unit prices and calculated costs retain their own higher precision.
export function quantityValue(value) {
  return value == null ? null : Math.round((Number(value) + Number.EPSILON) * 100) / 100
}
