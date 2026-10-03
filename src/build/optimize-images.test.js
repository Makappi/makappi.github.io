'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const gulp = require('gulp');
const sharp = require('sharp');
const optimizeImages = require('./optimize-images');

async function fixtureDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'makappi-images-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function processFiles(directory, options) {
  const files = [];
  await pipeline(
    gulp.src(path.join(directory, '*')),
    optimizeImages(options),
    new Writable({ objectMode: true, write(file, encoding, callback) {
      files.push(file);
      callback();
    } })
  );
  return files;
}

test('compresses PNG and JPEG without changing dimensions or PNG transparency', async t => {
  const directory = await fixtureDirectory(t);
  const pixels = Buffer.alloc(128 * 96 * 4);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 128; x++) {
      const offset = (y * 128 + x) * 4;
      pixels[offset] = x * 2;
      pixels[offset + 1] = y * 2;
      pixels[offset + 2] = (x + y) % 256;
      pixels[offset + 3] = 128 + (x % 127);
    }
  }
  const image = sharp(pixels, { raw: { width: 128, height: 96, channels: 4 } });
  const png = await image.clone().png({ compressionLevel: 0 }).toBuffer();
  const jpeg = await image.clone().jpeg({ quality: 100 }).toBuffer();
  await fs.writeFile(path.join(directory, 'image.png'), png);
  await fs.writeFile(path.join(directory, 'image.jpg'), jpeg);
  const files = await processFiles(directory);
  assert.equal(files.length, 2);
  for (const file of files) {
    const metadata = await sharp(file.contents).metadata();
    assert.equal(metadata.width, 128);
    assert.equal(metadata.height, 96);
    const isPng = file.extname === '.png';
    assert.equal(metadata.format, isPng ? 'png' : 'jpeg');
    assert.ok(file.contents.length < (isPng ? png : jpeg).length);
    if (isPng) {
      assert.equal(metadata.hasAlpha, true);
      const { data } = await sharp(file.contents).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let offset = 3; offset < data.length; offset += 4) {
        assert.equal(data[offset], pixels[offset]);
      }
    } else {
      assert.equal(metadata.isProgressive, true);
    }
  }
});

test('preserves SVG viewBox and assets outside the optimized formats', async t => {
  const directory = await fixtureDirectory(t);
  await fs.writeFile(path.join(directory, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="red"/></svg>');
  await fs.writeFile(path.join(directory, 'asset.txt'), 'unchanged');
  const files = await processFiles(directory);
  assert.match(files.find(file => file.extname === '.svg').contents.toString(), /viewBox="0 0 20 20"/);
  assert.equal(files.find(file => file.extname === '.txt').contents.toString(), 'unchanged');
});

test('preserves the actual format of images with a misleading extension', async t => {
  const directory = await fixtureDirectory(t);
  const image = sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } });
  await fs.writeFile(path.join(directory, 'jpeg.png'), await image.clone().jpeg().toBuffer());
  const webp = await image.clone().webp().toBuffer();
  await fs.writeFile(path.join(directory, 'webp.png'), webp);
  const files = await processFiles(directory);
  assert.equal((await sharp(files.find(file => file.basename === 'jpeg.png').contents).metadata()).format, 'jpeg');
  assert.deepEqual(files.find(file => file.basename === 'webp.png').contents, webp);
});

test('preserves GIF animation frames and delays', async t => {
  const directory = await fixtureDirectory(t);
  const input = await fs.readFile(path.join(__dirname, '../assets/img/feature-page/automated-marketing.gif'));
  await fs.writeFile(path.join(directory, 'animation.gif'), input);
  const [file] = await processFiles(directory);
  const before = await sharp(input, { animated: true }).metadata();
  const after = await sharp(file.contents, { animated: true }).metadata();
  assert.ok(before.pages > 1);
  assert.equal(after.pages, before.pages);
  assert.deepEqual(after.delay, before.delay);
  assert.equal(after.loop, before.loop);
});

test('watch mode reports a broken image, processes subsequent files and can retry', async t => {
  const directory = await fixtureDirectory(t);
  await fs.writeFile(path.join(directory, 'a-broken.png'), 'invalid PNG');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  await fs.writeFile(path.join(directory, 'b-valid.png'), png);
  const errors = [];
  const files = await processFiles(directory, { continueOnError: true, reportError: error => errors.push(error) });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /a-broken\.png/);
  assert.equal(files.length, 1);
  assert.equal(files[0].basename, 'b-valid.png');
  await fs.writeFile(path.join(directory, 'a-broken.png'), png);
  assert.equal((await processFiles(directory)).length, 2);
});

test('build mode rejects a broken image with its filename', async t => {
  const directory = await fixtureDirectory(t);
  await fs.writeFile(path.join(directory, 'broken.png'), 'invalid PNG');
  await assert.rejects(processFiles(directory), /Image optimization failed for broken\.png/);
});
