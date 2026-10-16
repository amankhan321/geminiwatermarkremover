// Decode → detect/remove → encode, off the main thread.
import { cleanImage, ready } from './engine.js';

const init = ready();

self.onmessage = async (e) => {
  const { id, file, opts } = e.data;
  try {
    await init;
    const bmp = await createImageBitmap(file, {
      colorSpaceConversion: 'none', // keep raw pixel values: the blend math depends on them
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
    });
    const { width, height } = bmp;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const imgData = ctx.getImageData(0, 0, width, height);
    const res = cleanImage({ data: imgData.data, width, height }, opts);
    let blob = null;
    if (res.status === 'processed') {
      ctx.putImageData(imgData, 0, 0);
      blob = await canvas.convertToBlob(
        opts.type === 'image/png' ? { type: 'image/png' } : { type: opts.type, quality: opts.quality }
      );
    }
    self.postMessage({ id, ok: true, res, blob, width, height });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
