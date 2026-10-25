/**
 * Page-side DOM scanning, as plain JavaScript.
 *
 * This file exists as .js on purpose. The TypeScript module that uses it cannot pass its
 * own functions to page.evaluate: the build tooling (esbuild with keepNames, used by tsx
 * and vitest) rewrites nested function declarations to dodge name collisions
 * (`controlValue` -> `controlValue2`) without always rewriting the call sites in the same
 * source range, and it appends `__name(fn, "fn")` calls that reference a helper which
 * does not exist in the browser. The shipped source then calls names the page never
 * declares and every evaluate dies with `ReferenceError`. The production build (tsc)
 * happens to emit valid output, which is exactly why this only ever failed under tsx,
 * in vitest, and in the probe scripts.
 *
 * Nothing here is bundled or renamed: the source is read at runtime and installed into
 * the page as a script, so it runs in the page's own global scope.
 */

/* eslint-disable */
(function (global) {
  function visible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    var style = global.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return style.opacity !== '0';
  }

  /**
   * A panel of suggestions counts as open when it is visible AND sits near the field it
   * belongs to. A page can keep an empty listbox in the DOM at all times, and a listbox
   * that is on screen but belongs to some other control would be reported as this field's
   * suggestions, which is worse than reporting nothing.
   */
  function openPanelFor(input) {
    var candidates = global.document.querySelectorAll(
      '[role=option],[role=menuitem],[role=listbox],ul,ol,menu',
    );
    var box = input.getBoundingClientRect();
    var best = null;
    var bestDistance = Infinity;

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!visible(el)) continue;
      var rect = el.getBoundingClientRect();
      // Directly below the field, or covering it, is a suggestion panel. Anything far
      // away on the page is not.
      var dx = rect.left - box.left;
      var dy = rect.top - box.bottom;
      var overlaps = rect.left < box.right && rect.right > box.left;
      var below = dy >= -4 && dy < 400 && Math.abs(dx) < 400;
      if (!overlaps && !below) continue;
      var distance = Math.abs(dy) + Math.abs(dx);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = el;
      }
    }
    return best;
  }

  function escapeAttr(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function roleOf(el) {
    var declared = el.getAttribute('role');
    if (declared) return declared;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    return null;
  }

  function kindOf(el, role) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return 'checkbox';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'text' || type === 'email' || type === 'tel' || type === 'url') return 'textbox';
      return 'input';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    return 'other';
  }

  function controlValue(el, sensitive) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var raw = el.value;
      if (typeof raw !== 'string') return null;
      // Nunca se entrega al modelo el contenido de un campo sensible: solo el hecho
      // de que está relleno. Una contraseña, una tarjeta o un código de un solo uso
      // no deben viajar al proveedor ni quedar en la transcripción.
      if (sensitive) return raw ? '***' : '';
      return raw;
    }
    var aria = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow');
    return aria && aria.trim() ? aria : null;
  }

  // Campos cuyo VALOR jamás se lee: contraseñas, tarjetas, códigos OTP, ocultos y
  // cualquier campo cuyo autocomplete declare una credencial o un dato de pago.
  function sensitiveControl(el) {
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    var auto = (el.getAttribute('autocomplete') || '').trim().toLowerCase();
    if (!auto) return false;
    var parts = auto.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (
        p === 'current-password' ||
        p === 'new-password' ||
        p === 'one-time-code' ||
        p.indexOf('cc-') === 0
      ) {
        return true;
      }
    }
    return false;
  }

  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function nameOf(el) {
    var role = roleOf(el);
    var direct =
      el.getAttribute('name') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      (el.labels && el.labels[0] ? textOf(el.labels[0]) : '');
    var viaId = '';
    if (el.id) {
      var label = global.document.querySelector('label[for="' + escapeAttr(el.id) + '"]');
      if (label) viaId = textOf(label);
    }
    var wrapping = el.closest ? textOf(el.closest('label') || el) : '';
    if (wrapping === textOf(el)) wrapping = '';

    var candidates = [
      direct,
      viaId,
      wrapping,
      (el.placeholder || '').slice(0, 80),
      el.getAttribute('alt') || '',
      el.getAttribute('title') || '',
      textOf(el).slice(0, 80),
      role || el.tagName.toLowerCase(),
    ];
    var best = '';
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && candidates[i].trim()) {
        best = candidates[i];
        break;
      }
    }
    return best.replace(/\s+/g, ' ').trim();
  }

  function selectorOf(el) {
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + escapeAttr(testId) + '"]';
    var tag = el.tagName.toLowerCase();
    var id = el.getAttribute('id');
    if (id) return tag + '#' + global.CSS.escape(id);
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + escapeAttr(name) + '"]';
    var parts = [];
    var node = el;
    while (node && node.tagName !== 'BODY' && parts.length < 4) {
      var nth = 1;
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) nth++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : tag;
  }

  global.__paScanPage = function (args) {
    var max = args && args.max ? args.max : 120;
    var interesting =
      'a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=option],' +
      '[role=menuitem],[role=checkbox],[role=switch],[role=combobox],[role=textbox],[role=searchbox],' +
      '[onclick],[contenteditable]';

    var nodes = Array.prototype.slice.call(global.document.querySelectorAll(interesting));
    var elements = [];
    for (var i = 0; i < nodes.length; i++) {
      if (elements.length >= max) break;
      var el = nodes[i];
      if (!visible(el)) continue;
      var sensitive = sensitiveControl(el);
      var value = controlValue(el, sensitive);
      var name = nameOf(el);
      if (!name) continue;
      var role = roleOf(el);
      elements.push({
        index: elements.length,
        kind: kindOf(el, role),
        role: role || '',
        name: name,
        value: value === null ? '' : value,
        sensitive: sensitive,
        selector: selectorOf(el),
        // Kept so the panel lookup below can measure distance to the actual node. It
        // never leaves this function.
        _el: el,
      });
    }

    // An open suggestion panel changes what can be done next, so it is reported per
    // field, and only when it is genuinely open for that field.
    var suggestions = [];
    var openCount = 0;
    var seenPanels = [];

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i]._el;
      if (!el) continue;
      var panel = openPanelFor(el);
      if (!panel) continue;
      if (seenPanels.indexOf(panel) === -1) seenPanels.push(panel);
      var opts = panel.querySelectorAll('[role=option],[role=menuitem],li');
      var count = 0;
      for (var o = 0; o < opts.length; o++) {
        if (!visible(opts[o])) continue;
        var text = textOf(opts[o]);
        if (!text) continue;
        count++;
        if (suggestions.length < 12) suggestions.push(text);
      }
      if (count > 0) {
        elements[i].openSuggestions = count;
        openCount++;
      }
    }

    return {
      title: global.document.title,
      url: global.location.href,
      total: nodes.length,
      openSuggestions: openCount,
      openPanels: seenPanels.length,
      suggestions: suggestions,
      elements: elements,
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);