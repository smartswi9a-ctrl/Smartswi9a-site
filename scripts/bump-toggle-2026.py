# -*- coding: utf-8 -*-
"""Bump cache to SW v15 + ?v=toggle2026 and align tests."""
import io
import os


def patch(path, pairs):
    with io.open(path, encoding="utf-8") as fh:
        text = fh.read()
    n = 0
    for old, new in pairs:
        c = text.count(old)
        if c:
            text = text.replace(old, new)
            n += c
        else:
            print("  ! introuvable dans %s : %r" % (path, old[:60]))
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    print("  %s : %d remplacement(s)" % (path, n))


patch("admin.html", [
    ("/js/admin-ui.js?v=7", "/js/admin-ui.js?v=toggle2026"),
    ("/js/admin.js?v=gallery2026d", "/js/admin.js?v=toggle2026"),
])

patch("vendor/dashboard.html", [
    ("vendor-ui.css?v=2", "vendor-ui.css?v=toggle2026"),
    ("/js/vendor-ui.js?v=2", "/js/vendor-ui.js?v=toggle2026"),
])

patch("firebase-messaging-sw.js", [("sw-2026-11-27-v14", "sw-2026-11-27-v15")])

for t in ("tests/abandoned-cart.test.cjs", "tests/ads-attribution.test.cjs",
          "tests/ads-automation.test.cjs", "tests/shop-ui.test.cjs"):
    patch(t, [
        ("/js/admin-ui.js?v=7", "/js/admin-ui.js?v=toggle2026"),
        ("/js/admin.js?v=gallery2026d", "/js/admin.js?v=toggle2026"),
        ("sw-2026-11-27-v14", "sw-2026-11-27-v15"),
    ])

# vendor-ui.test : la tablette n'est plus une rail 72px mais un tiroir.
patch("tests/vendor-ui.test.cjs", [
    (
        'check("vendor : tablette 768-1023 compacte 72px", css.includes("@media (min-width: 768px) and (max-width: 1023px)"));',
        'check(\n'
        '  "vendor : tablette 768-1023 en tiroir",\n'
        '  /@media \\(min-width: 768px\\) and \\(max-width: 1023px\\)/.test(css) &&\n'
        '    /translateX\\(calc\\(-100% - 12px\\)\\)/.test(css)\n'
        ');',
    ),
])

print("done")
