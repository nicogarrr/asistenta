#!/bin/sh
# webOS Custom Home — on-device uninstaller. Copy this local file to the TV and run it
# (only with Nico's window; do not fetch it from the network):
# Removes the boot hook, stops the watcher, and removes the app. Restores stock
# behavior — nothing touched the read-only OS, so no factory reset is needed.

APP_ID="tld.my.customhome"
INITD="/var/lib/webosbrew/init.d/50-customhome"

echo "==> Removing boot autostart hook..."
rm -f "$INITD"

echo "==> Stopping the HOME watcher..."
[ -f /tmp/home-svc.pid ] && kill -9 "$(cat /tmp/home-svc.pid)" 2>/dev/null
rm -f /tmp/home-svc.pid

echo "==> Removing the app..."
luna-send -n 1 -f luna://com.webos.appInstallService/dev/remove \
  "{\"id\":\"${APP_ID}\",\"subscribe\":false}" >/dev/null 2>&1
# Fallback: also try the Homebrew Channel uninstall path.
luna-send -n 1 -f luna://org.webosbrew.hbchannel.service/uninstall \
  "{\"id\":\"${APP_ID}\"}" >/dev/null 2>&1

echo "✓ Uninstalled. Your TV's stock Home returns on the next reboot."
