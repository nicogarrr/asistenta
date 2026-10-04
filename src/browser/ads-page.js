/**
 * Ad-skipping and media state, as plain JavaScript.
 *
 * Plain .js on purpose, for the same reason as scan-page.js: code handed to
 * page.evaluate must not come from a bundled TypeScript module, because esbuild's
 * keepNames rewrites nested declarations and appends __name(...) calls that do not exist
 * in the page. This file is read at runtime and installed, so nothing renames it.
 */

/* eslint-disable */
(function (global) {
  function fold(s) {
    return String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function visible(el) {
    return el instanceof HTMLElement && el.offsetParent !== null;
  }

  function clickSkip(args) {
    var found = [];
    var seen = [];

    for (var i = 0; i < args.selectors.length; i++) {
      var nodes;
      try {
        nodes = global.document.querySelectorAll(args.selectors[i]);
      } catch {
        continue;
      }
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (!visible(el)) continue;
        if (seen.indexOf(el) !== -1) continue;
        seen.push(el);
        found.push(el);
      }
    }

    var matched = [];
    for (var k = 0; k < found.length; k++) {
      var label = fold(found[k].textContent || found[k].getAttribute('aria-label') || '');
      if (!label) continue;
      var startsWithHint = false;
      for (var t = 0; t < args.texts.length; t++) {
        if (label.indexOf(fold(args.texts[t])) === 0) {
          startsWithHint = true;
          break;
        }
      }
      if (!startsWithHint) continue;
      matched.push(found[k]);
    }

    var adShowing = false;
    if (args.adSelector) {
      try {
        var adNodes = global.document.querySelectorAll(args.adSelector);
        for (var a = 0; a < adNodes.length; a++) {
          if (visible(adNodes[a])) {
            adShowing = true;
            break;
          }
        }
      } catch {
        adShowing = false;
      }
    }

    var clicked = 0;
    for (var m = 0; m < matched.length; m++) {
      try {
        matched[m].click();
        clicked++;
      } catch {
        // A node can vanish between the scan and the click; the next candidate may work.
      }
    }

    return { clicked: clicked, adShowing: adShowing };
  }

  function mediaState(args) {
    var skipButtonsVisible = 0;
    for (var i = 0; i < args.selectors.length; i++) {
      var nodes;
      try {
        nodes = global.document.querySelectorAll(args.selectors[i]);
      } catch {
        continue;
      }
      for (var j = 0; j < nodes.length; j++) {
        if (!visible(nodes[j])) continue;
        var label = fold(nodes[j].textContent || nodes[j].getAttribute('aria-label') || '');
        if (!label) continue;
        var startsWithHint = false;
        for (var t = 0; t < args.texts.length; t++) {
          if (label.indexOf(fold(args.texts[t])) === 0) {
            startsWithHint = true;
            break;
          }
        }
        if (startsWithHint) skipButtonsVisible++;
      }
    }

    var adShowing = false;
    if (args.adSelector) {
      try {
        var adNodes = global.document.querySelectorAll(args.adSelector);
        for (var a = 0; a < adNodes.length; a++) {
          if (visible(adNodes[a])) {
            adShowing = true;
            break;
          }
        }
      } catch {
        adShowing = false;
      }
    }

    var media = global.document.querySelector('video,audio');
    var hasVideo = !!media;
    return {
      hasVideo: hasVideo,
      playing: hasVideo ? !media.paused && !media.ended : false,
      currentTime: hasVideo ? media.currentTime : 0,
      duration: hasVideo && isFinite(media.duration) ? media.duration : 0,
      muted: hasVideo ? media.muted : null,
      adShowing: adShowing,
      skipButtonsVisible: skipButtonsVisible,
      title: global.document.title,
    };
  }

  global.__paClickSkip = clickSkip;
  global.__paMediaState = mediaState;
})(typeof window !== 'undefined' ? window : globalThis);