#!/usr/bin/env node
'use strict';
// Prints a JSON content manifest (files on disk, what's referenced by projects/logos,
// orphaned files, missing-but-referenced files, and recent content_log entries) for
// whichever machine it's run on. Content sync runs this locally (in-process, via
// lib/content-manifest.js directly) and remotely over SSH (`node scripts/manifest.js`)
// so both sides are compared using the exact same logic.
const path = require('path');
const { buildManifest } = require('../lib/content-manifest');

const root = path.join(__dirname, '..');
const manifest = buildManifest({
  dbPath:    path.join(root, 'data', 'portfolio.db'),
  imagesDir: path.join(root, 'public', 'images'),
});

process.stdout.write(JSON.stringify(manifest));
