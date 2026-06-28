'use strict';

/*
 * Frontend constants for youtube-zero.
 *
 * Classic script: defines window-level constants picked up by every file
 * loaded after it. No exports.
 */

// Video classification
const SHORTS_MAX_SECONDS    = 180;   // videos shorter than this are "Shorts"

// Embed/player host — normally set by /config.js (loaded just before this file)
// from the server's USE_NOCOOKIE flag. Fall back to nocookie if that didn't run.
window.YT_EMBED_HOST = window.YT_EMBED_HOST || 'https://www.youtube-nocookie.com';

// Responsive breakpoints (kept in sync with style.css @media rules)
const MOBILE_MAX_WIDTH      = 600;
const NARROW_MAX_WIDTH      = 900;

// Thumbnail probing
const THUMBNAIL_MIN_WIDTH   = 320;   // below this, fall through the fallback chain

// Icon picker popup geometry
const ICON_PICKER_WIDTH     = 284;
const ICON_PICKER_HEIGHT    = 320;
const ICON_PICKER_FLIP_GAP  = 324;   // when flipping above anchor, leave this gap
