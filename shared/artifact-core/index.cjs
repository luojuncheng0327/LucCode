"use strict";

/**
 * shared/artifact-core/index.cjs
 *
 * Aggregator for the artifact-core library. Namespaced rather than
 * flattened so build and update consumers can require exactly the surface they need without name
 * collisions between modules.
 */

module.exports = {
  ustar: require("./ustar.cjs"),
  manifest: require("./manifest.cjs"),
  pointerStore: require("./pointer-store.cjs"),
  activation: require("./activation.cjs"),
};
