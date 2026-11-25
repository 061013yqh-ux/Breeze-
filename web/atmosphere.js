export function coverLight(image) {
  if (!image.naturalWidth) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 24;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    if (!context) return null;
    context.drawImage(image, 0, 0, 24, 24);
    const pixels = context.getImageData(1, 1, 22, 22).data;
    const buckets = Array.from({length: 12}, () => ({sum: [0, 0, 0], weight: 0}));
    for (let i = 0; i < pixels.length; i += 4) {
      const rgb = [pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255];
      const max = Math.max(...rgb), min = Math.min(...rgb);
      const chroma = max - min;
      if (pixels[i + 3] < 160 || chroma < .10 || max < .14) continue;
      const [red, green, blue] = rgb;
      const hue = max === red ? (green - blue) / chroma + 6 :
        max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
      const bucket = buckets[Math.floor((hue % 6) * 2)];
      const weight = chroma * chroma * (.42 + max);
      bucket.weight += weight;
      bucket.sum = bucket.sum.map((value, channel) => value + rgb[channel] * weight);
    }
    const chosen = buckets.reduce((best, bucket) => bucket.weight > best.weight ? bucket : best);
    if (chosen.weight < .3) return [.64, .58, .79];
    const rgb = chosen.sum.map(value => value / chosen.weight);
    const peak = Math.max(...rgb);
    return rgb.map(value => .24 + .76 * value / peak);
  } catch {
    return null;
  }
}
