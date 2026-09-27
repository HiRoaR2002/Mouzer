'use strict';

// Confirms a captured frame is a real, non-blank image: decodes it and reports
// dimensions plus pixel spread. A failed capture (black screen, secure desktop)
// yields near-zero variance, which is what this catches.

const Jimp = require('jimp');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, 'selftest-frame.jpg');

(async () => {
  const image = await Jimp.read(target);
  const { width, height } = image.bitmap;

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  let min = 255;
  let max = 0;
  const hist = new Array(256).fill(0);

  image.scan(0, 0, width, height, function (x, y, idx) {
    const v = (this.bitmap.data[idx] + this.bitmap.data[idx + 1] + this.bitmap.data[idx + 2]) / 3;
    sum += v;
    sumSq += v * v;
    n++;
    if (v < min) min = v;
    if (v > max) max = v;
    hist[Math.round(v)]++;
  });

  const mean = sum / n;
  const stddev = Math.sqrt(sumSq / n - mean * mean);
  const distinct = hist.filter((c) => c > n * 0.0001).length;

  console.log('file    :', path.basename(target));
  console.log('size    :', `${width}x${height}`, `(${width * height} px)`);
  console.log('mean    :', mean.toFixed(1));
  console.log('stddev  :', stddev.toFixed(1));
  console.log('range   :', `${min.toFixed(0)}..${max.toFixed(0)}`);
  console.log('distinct levels:', distinct);

  const blank = stddev < 3 || distinct < 8;
  console.log(blank ? '\nVERDICT: BLANK (capture is not returning real pixels)' : '\nVERDICT: REAL IMAGE');
  process.exitCode = blank ? 1 : 0;
})().catch((err) => {
  console.error('could not decode:', err.message);
  process.exit(1);
});
