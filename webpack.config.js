const path = require('path');
const webpack = require('webpack');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

module.exports = {
  entry: './index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'WebTorrentPlayer',
    sourceMapFilename: 'bundle.js.map'
  },
  mode: 'production',
  devtool: 'source-map',
  module: { // Add this 'module' section
    rules: [
      {
        test: /\.js$/, // Apply babel-loader to all .js files
        exclude: /node_modules/, // Don't transpile code in node_modules
        use: {
          loader: 'babel-loader', // Use babel-loader
          options: {
            presets: ['@babel/preset-env'] // Use the @babel/preset-env preset
          }
        }
      }
    ]
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: 'process-fast'
    }),
    new NodePolyfillPlugin()
  ]
};
