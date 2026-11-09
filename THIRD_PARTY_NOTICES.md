# Avisos de terceros

Asistenta toma ideas de estos proyectos. Donde solo se tomó la idea, el código es nuestro
(reescrito); se deja aquí su licencia igualmente, como reconocimiento y por si en el futuro
se adapta código de ellos.

## phoneuse

- Origen: https://github.com/lxe/phoneuse (leído el 7 nov 2026, commit 6bce214).
- Qué se tomó: la pantalla del iPhone como texto con posiciones (OCR fuera del modelo),
  quitar la barra de estado, marcar la flecha de volver, avisar con la pantalla de bloqueo.
  Código reescrito en `src/iphone/texto.ts`; no se ha copiado código.
- También: tocar «por texto» sin adivinar (exacto, empieza por, o una letra mal leída), no tocar la
  isla dinámica, y las recetas de abrir app (Cmd+H, Cmd+Espacio, nombre, Intro), bajar y escribir.
  Reescritas en `src/iphone/texto.ts` y `src/iphone/gestos.ts`.
- También: esperar a que la pantalla se quede quieta tras cada paso en vez de una pausa fija
  (su «settle» de frames.py; aquí sobre la firma del OCR) en `src/iphone/quieta.ts`; y, para el
  iPhone por Bluetooth desde Windows, el puntero absoluto (toque exacto sin calibrar: ir, esperar
  ~0,1 s, pulsar), el arrastre pausado (pulsar en absoluto, un informe relativo cada 8 ms, soltar
  en absoluto, con su medida de 6,9 pt por informe de 2 unidades) y la pantalla por AirPlay con
  UxPlay, reescritos en `src/iphone/hid-informes.ts`, `src/iphone/ble.ts` y `src/iphone/ventana.ts`.
- Licencia:

```
MIT License

Copyright (c) 2026 Aleksey Smolenchuk

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## AimMac

- Origen: https://github.com/Coolerwave/AimMac (leído el 8 nov 2026, commit a2d5296).
- Qué se tomó: la idea de usar el iPhone como puntero (gravedad para arriba/abajo, giro de la vertical para izquierda/derecha, botón Centrar), la proyección «pared» y el filtro 1€ con los tiempos del dispositivo, y que el clic va a donde se apuntaba un instante antes del toque. Todo reescrito en TypeScript en `src/aim/` (filtro 1€ de Casiez et al. en `src/aim/oneeuro.ts`); no se ha copiado código Swift. Las partes de Mac (CoreBluetooth, CGEvent) y la app Xcode no se usan: aquí el móvil es una página web en Safari y el destino es Windows o la LG.
- Licencia:

```
MIT License

Copyright (c) 2026 Bart

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## windows-ble-hid (BleHid)

- Origen: https://github.com/abhishek-raj/windows-ble-hid (leído el 9 nov 2026, commit b33a004).
- Qué se tomó: la idea de que Windows puede hacer de teclado/ratón Bluetooth LE (HID sobre GATT)
  con el `GattServiceProvider` de WinRT que trae el sistema, comprobar antes el rol periférico del
  adaptador, cifrado obligatorio en las características, y lo que su README midió (iOS necesita
  AssistiveTouch para el puntero; el PC se anuncia con su propio nombre). No se instala su app ni
  se ha copiado su código: el ayudante `deploy/iphone/windows/AsistentaHid.cs` es propio, y el mapa
  de informes (con puntero absoluto, que BleHid no tiene) está escrito desde la especificación HID.
- Licencia:

```
MIT License

Copyright (c) 2026 Abhishek Raj

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
