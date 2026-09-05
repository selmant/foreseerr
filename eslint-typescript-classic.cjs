const Module = require('module');
const classic = require.resolve('typescript-classic');
const original = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'typescript') {
    return classic;
  }
  return original.call(this, request, parent, isMain, options);
};
