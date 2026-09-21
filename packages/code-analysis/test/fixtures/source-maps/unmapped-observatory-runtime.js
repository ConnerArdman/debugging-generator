/*
 * Hand-authored fixture imitating an unmapped dev-server runtime chunk: it is never executed,
 * imported or bundled, and it carries no companion `.map` file on purpose: absence is the point.
 */

(() => {
  'use strict';

  // Factories the observatory chunks register, their instantiated exports, and the chunk
  // bookkeeping a dev-server runtime keeps (0 marks a chunk whose factories have arrived).
  var factories = {};
  var cache = {};
  var installed = { 'observatory-runtime': 0 };

  function __webpack_require__(moduleId) {
    var hit = cache[moduleId];
    if (hit !== undefined) return hit.exports;
    var factory = factories[moduleId];
    if (factory === undefined) {
      throw new Error('module missing from every installed observatory chunk: ' + moduleId);
    }
    var mod = (cache[moduleId] = { id: moduleId, exports: {} });
    factory(mod, mod.exports, __webpack_require__);
    return mod.exports;
  }

  __webpack_require__.m = factories;
  __webpack_require__.p = '/_next/static/chunks/';
  __webpack_require__.u = function (chunkId) {
    return 'static/chunks/' + chunkId + '.4c1e7b.js';
  };

  function installChunk(chunk) {
    for (var moduleId in chunk[1]) factories[moduleId] = chunk[1][moduleId];
    for (var i = 0; i < chunk[0].length; i++) installed[chunk[0][i]] = 0;
  }

  var queued = (self.webpackChunk_N_E = self.webpackChunk_N_E || []);
  queued.forEach(installChunk);
  queued.push = installChunk;
})();
