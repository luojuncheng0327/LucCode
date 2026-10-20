"use strict";

/**
 * shared/artifact-core/pointer-channels.cjs
 *
 * Pointer channel namespace naming — the ONLY definition point for the
 * seed/OTA channel identifiers consumed across boot decisions and
 * background updates. `SEED_CHANNEL` is the unqualified channel name
 * ("stable") that the server pointer namespace uses as-is; renderer uses
 * an independent pointer namespace derived from it via
 * `rendererPointerChannel` (`${channel}.renderer`) so server and renderer
 * `current`/`previous`/`next` pointers never collide under the same
 * channel. `pointer-store.cjs`'s `channel` parameter is an opaque filename
 * fragment with no semantic validation, so this qualifier never needs to
 * touch any other artifact-core module.
 */

const SEED_CHANNEL = "stable";

/**
 * renderer 的独立指针命名空间（同一 channel 下跟 server 互不覆盖）。
 */
function rendererPointerChannel(channel) {
  return `${channel}.renderer`;
}

module.exports = {
  SEED_CHANNEL,
  rendererPointerChannel,
};
