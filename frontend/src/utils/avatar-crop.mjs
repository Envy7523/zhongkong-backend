// Keep the square crop inside the source image at every zoom and drag position.
export function cropGeometry(width, height, zoom = 1, x = 0, y = 0, side = 320) {
  if (![width, height, side, zoom, x, y].every(Number.isFinite) || width <= 0 || height <= 0 || side <= 0) throw new Error('图片尺寸无效');
  const scale = Math.max(side / width, side / height) * Math.max(1, Math.min(4, zoom));
  const limitX = (width * scale - side) / 2, limitY = (height * scale - side) / 2;
  const panX = Math.max(-limitX, Math.min(limitX, x)), panY = Math.max(-limitY, Math.min(limitY, y));
  return {panX, panY, sx: (limitX - panX) / scale, sy: (limitY - panY) / scale, size: side / scale};
}
