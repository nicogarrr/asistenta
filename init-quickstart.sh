#!/bin/sh
luna-send -n 1 -f 'luna://com.webos.settingsservice/getSystemSettings' '{"category":"other","keys":["quickStart"]}' 2>/dev/null
# Verifica si Quick Start sigue en off; si vuelve a on (por ejemplo tras reset parcial), lo vuelve a apagar.
sleep 30
luna-send -n 1 -f 'luna://com.webos.settingsservice/getSystemSettings' '{"category":"other","keys":["quickStart"]}' 2>/dev/null | grep -q '"quickStart":"on"' && luna-send -n 1 -f 'luna://com.webos.settingsservice/setSystemSettings' '{"category":"other","settings":{"quickStart":"off"}}' 2>/dev/null || echo quickstart-ok
