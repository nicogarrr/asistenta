#!/usr/bin/env python3
"""Genera screensaver-main.qml con la lista de imagenes de art/ (rutas de la TV).
Uso: python make_qml.py [--art art] [--tv-dir /media/developer/art] [--seconds 90]"""
import argparse, json, os
ap = argparse.ArgumentParser()
ap.add_argument("--art", default="art"); ap.add_argument("--tv-dir", default="/media/developer/art")
ap.add_argument("--seconds", type=int, default=90)
a = ap.parse_args()
files = sorted(f for f in os.listdir(a.art) if f.lower().endswith(".jpg"))
paths = ["file://" + a.tv_dir + "/" + f for f in files]
qml = '''/* Salvapantallas de arte. Sustituye (bind mount) al main.qml del salvapantallas de webOS.
   Prueba: luna-send -n 1 'luna://com.webos.service.tvpower/power/turnOnScreenSaver' '{}' */
import QtQuick 2.4
import Eos.Window 0.1
import QtQuick.Window 2.2

WebOSWindow {
    id: window
    width: 1920; height: 1080
    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    color: "black"
    title: "Screensaver"
    appId: "com.webos.app.screensaver"
    visible: true

    property var imgs: %s
    property int idx: Math.floor(Math.random() * imgs.length)
    property bool front: true

    function nextImage() {
        idx = (idx + 1) %% imgs.length
        var target = front ? b : a
        target.source = imgs[idx]
    }

    Rectangle { anchors.fill: parent; color: "black" }

    Image { id: a; anchors.fill: parent; fillMode: Image.PreserveAspectFit; asynchronous: true
            cache: false; sourceSize.width: 3840; sourceSize.height: 2160
            opacity: front ? 1 : 0; Behavior on opacity { NumberAnimation { duration: 2500 } }
            source: imgs[idx] }
    Image { id: b; anchors.fill: parent; fillMode: Image.PreserveAspectFit; asynchronous: true
            cache: false; sourceSize.width: 3840; sourceSize.height: 2160
            opacity: front ? 0 : 1; Behavior on opacity { NumberAnimation { duration: 2500 } } }

    Timer {
        interval: %d; running: true; repeat: true
        onTriggered: { nextImage(); /* cambia al terminar de cargar */ swap.start() }
    }
    Timer { id: swap; interval: 1200; onTriggered: front = !front }
}
''' % (json.dumps(paths, indent=1), a.seconds * 1000)
open("screensaver-main.qml", "w", encoding="utf-8").write(qml)
print(len(paths), "imagenes -> screensaver-main.qml")
