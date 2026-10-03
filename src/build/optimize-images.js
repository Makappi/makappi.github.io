'use strict';

const { Transform } = require('node:stream');
const path = require('node:path');
const sharp = require('sharp');
const gifsicle = require('imagemin-gifsicle')({ interlaced: true });
const svgo = require('imagemin-svgo')({ plugins: [{ removeViewBox: false }] });

async function optimize(contents, extension) {
  switch (extension) {
    case '.png':
    case '.jpg':
    case '.jpeg': {
      const image = sharp(contents);
      const { format } = await image.metadata();
      // Some existing assets have an extension that differs from their format.
      if (format === 'png') {
        return image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      }
      if (format === 'jpeg') {
        return image.jpeg({ quality: 90, progressive: true, mozjpeg: true }).toBuffer();
      }
      return contents;
    }
    case '.gif':
      return gifsicle(contents);
    case '.svg':
      return svgo(contents);
    default:
      return contents;
  }
}

module.exports = function optimizeImages({ continueOnError = false, reportError = console.error } = {}) {
  return new Transform({
    objectMode: true,
    transform(file, encoding, callback) {
      if (file.isNull()) {
        callback(null, file);
        return;
      }

      const processFile = async () => {
        if (file.isStream()) {
          throw new Error('Streaming images are not supported');
        }
        file.contents = await optimize(file.contents, path.extname(file.path).toLowerCase());
        return file;
      };

      processFile().then(result => callback(null, result), error => {
        const failure = new Error(`Image optimization failed for ${file.relative}: ${error.message}`, { cause: error });
        if (continueOnError) {
          reportError(failure.message);
          // Leave the last successful output intact; the next save retries this file.
          callback();
        } else {
          callback(failure);
        }
      });
    }
  });
};
