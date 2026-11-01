//@ts-check
'use strict';

const path = require('path');
const base = require('./webpack.config.js')[0];

/** A separate test bundle avoids copying the model runtime assets into dist/test. */
module.exports = {
	...base,
	name: 'browser-smoke',
	mode: 'development',
	entry: { browserSmoke: './src/test/browserSmoke.ts' },
	output: { filename: '[name].js', path: path.join(__dirname, 'dist', 'test'), libraryTarget: 'commonjs' },
	plugins: [],
	devtool: 'source-map',
};
