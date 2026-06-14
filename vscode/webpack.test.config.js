//@ts-check
'use strict';

// Bundles the extension-host test suite into a single web-worker module that
// `vscode-test-web --extensionTestsPath` can load. Mirrors webpack.config.js
// (the extension bundle) but targets test/host/index.ts and uses
// tsconfig.test.json.

const path = require('path');
const webpack = require('webpack');

/** @type {import('webpack').Configuration} */
const testConfig = {
  mode: 'none',
  target: 'webworker',
  entry: {
    index: './test/host/index.ts',
  },
  output: {
    filename: '[name].js',
    path: path.join(__dirname, './dist/web/test'),
    libraryTarget: 'commonjs',
    devtoolModuleFilenameTemplate: '../../[resource-path]',
  },
  resolve: {
    mainFields: ['browser', 'module', 'main'],
    extensions: ['.ts', '.js'],
    fallback: {
      assert: require.resolve('assert'),
      path: require.resolve('path-browserify'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: { configFile: 'tsconfig.test.json' },
          },
        ],
      },
    ],
  },
  plugins: [
    new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    new webpack.ProvidePlugin({
      process: 'process/browser',
    }),
  ],
  externals: {
    vscode: 'commonjs vscode',
  },
  performance: { hints: false },
  devtool: 'nosources-source-map',
};

module.exports = [testConfig];
