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
    if (!(el instanceof HTMLElement)) return false;
    var style = global.getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < global.innerHeight && rect.left < global.innerWidth;
  }

  function actionable(el) {
    return visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  function matchesSkip(el, args) {
    var labels = [el.getAttribute('aria-label'), el.textContent, el.getAttribute('title')];
    for (var l = 0; l < labels.length; l++) {
      var label = fold(labels[l] || '');
      if (!label) continue;
      for (var t = 0; t < args.texts.length; t++) {
        if (label.indexOf(fold(args.texts[t])) === 0) return true;
      }
    }
    return false;
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
        if (!actionable(el)) continue;
        if (seen.indexOf(el) !== -1) continue;
        seen.push(el);
        found.push(el);
      }
    }

    var matched = [];
    for (var k = 0; k < found.length; k++) {
      if (!matchesSkip(found[k], args)) continue;
      matched.push(found[k]);
    }

    var adShowing = false;
    if (args.adSelector) {
      try {
        var adNodes = global.document.querySelectorAll(args.adSelector);
        for (var a = 0; a < adNodes.length; a++) {
          if (adNodes[a] instanceof HTMLElement && global.getComputedStyle(adNodes[a]).display !== 'none' && global.getComputedStyle(adNodes[a]).visibility !== 'hidden') {
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
        if (actionable(nodes[j]) && matchesSkip(nodes[j], args)) skipButtonsVisible++;
      }
    }

    var adShowing = false;
    if (args.adSelector) {
      try {
        var adNodes = global.document.querySelectorAll(args.adSelector);
        for (var a = 0; a < adNodes.length; a++) {
          if (adNodes[a] instanceof HTMLElement && global.getComputedStyle(adNodes[a]).display !== 'none' && global.getComputedStyle(adNodes[a]).visibility !== 'hidden') {
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