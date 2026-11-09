# iPhone desde el portátil con Windows, sin la ESP32

Asistenta puede manejar el iPhone **solo con el PC**:
- **Pantalla:** el iPhone la duplica por AirPlay a una ventana de UxPlay en el PC. Asistenta la lee con el OCR que ya trae Windows.
- **Manos:** el Bluetooth del PC se presenta al iPhone como teclado y puntero. Lo hace un ayudante pequeño de Asistenta (`AsistentaHid`), que se compila con lo que ya trae Windows.

Es la idea de [phoneuse](https://github.com/lxe/phoneuse) (Linux), llevada a Windows. Está **apagado por defecto** y es experimental: lee la lista «Sin comprobar» del final antes de fiarte.

## 1. En el iPhone (una vez)

1. Ajustes > Accesibilidad > Tocar > **AssistiveTouch: activado.** Sin esto, iOS no dibuja puntero y los toques no llegan.
2. En esa misma pantalla, **«Control de permanencia» (Dwell): desactivado.** Si no, el puntero «hace clic» solo al quedarse quieto.
3. El teclado físico en EE. UU., si lo pregunta: Ajustes > General > Teclado > Teclados físicos. El ayudante escribe con distribución de EE. UU.: sin tildes ni eñes.

## 2. En Windows (una vez; se puede repetir sin miedo)

Abre PowerShell **como administrador** en la carpeta del repo y ejecuta:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\iphone\windows\preparar-windows.ps1
```

Comprueba, y arregla lo que puede:
- Que el Bluetooth del PC puede hacer de **periférico LE**. Si dice que no, con ese adaptador no hay nada que hacer; hace falta un USB que diga 5.0 o más y nombre su chip.
- Compila el ayudante (`compilar-hid.ps1`) con el compilador de C# de Windows. No descarga nada.
- Que **Bonjour** está en marcha. Si falta, instala «Bonjour Print Services» de Apple, que UxPlay necesita para que el iPhone vea el PC.
- Que existe `uxplay.exe` (ver «UxPlay» abajo) y que el cortafuegos le deja entrar **solo en red privada**.
- Que tu red wifi está como **privada**. Si está como pública, el iPhone no ve el PC.

Cuando todo esté en verde:
1. Añade `PA_IPHONE_BLE=1` al `.env` de Asistenta y reiníciala.
2. Arranca la pantalla con:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\iphone\windows\preparar-windows.ps1 -Arrancar
```

### UxPlay

UxPlay es un programa libre (GPL) que recibe AirPlay. Asistenta no lo descarga por ti. Dos formas de tenerlo:
- **Compilarlo** con MSYS2, siguiendo la sección «Building UxPlay on Windows» del README de UxPlay: MSYS2 + el SDK de Bonjour, y `cmake` + `ninja` en la consola UCRT64.
- **El paquete ya hecho** `uxplay-windows` (github.com/leapbtw/uxplay-windows).

En los dos casos deja `uxplay.exe` en `%LOCALAPPDATA%\Asistenta\uxplay\` o en el PATH, o pásale la ruta con `-UxPlay C:\ruta\uxplay.exe`.

## 3. Emparejar

1. Con Asistenta arrancada, pídele por Telegram «estado del iPhone». La primera vez arranca el ayudante y empieza a anunciarse.
2. En el iPhone: Ajustes > Bluetooth. Aparece el **nombre Bluetooth de tu PC** (no «Asistenta HID»: Windows no deja cambiar el nombre que anuncia). Tócalo y acepta el enlace.
3. En el iPhone: Centro de control > Duplicar pantalla > **Asistenta**. En el PC se abre la ventana de UxPlay. No la minimices; puede quedar detrás de otras.

## 4. Probarlo desde Telegram

1. «¿Cómo está el iPhone?» → `iphone status`. Debe decir «Listo: iPhone conectado por Bluetooth… y pantalla de UxPlay en directo». Si no, `iphone setup` dice el paso que falta.
2. «Lee la pantalla del iPhone» → `iphone texto`: las líneas de texto que se ven, con su posición.
3. «Toca Ajustes» → `tocar_texto`. **Te pide permiso en Telegram.** Después de cada paso espera a que la pantalla se quede quieta y te dice qué se ve, o que no cambió nada.
4. «Abre WhatsApp» → `abrir_app` (Cmd+H, Cmd+Espacio, el nombre, Intro).
5. «Baja» → `desplazar`, un arrastre lento con un informe cada 8 ms.
6. «Para» → `iphone stop`: suelta todas las teclas y el botón.

Las mismas guardas que con la ESP32:
- cada paso pide tu OK;
- con la pantalla de bloqueo no escribe ni toca;
- nunca toca la isla dinámica, porque cortaría la duplicación;
- si la radio falla a mitad, dice «Sin saber si se ha hecho» para que mires antes de repetir.

En modo Bluetooth no hay «agente del teléfono» (`run`): todo va paso a paso.

## Sin comprobar (honesto)

Nada de esto se ha probado aún con un iPhone y un PC reales; los tests usan piezas falsas.
- **iOS y el puntero absoluto por BLE.** phoneuse demostró que iOS clava el puntero absoluto sin calibrar, pero por Bluetooth **clásico**. Por BLE (HID sobre GATT) no se sabe. BleHid, el proyecto del que sale la idea, solo usó ratón relativo con el iPhone. Si los toques no caen donde deben, este es el primer sospechoso.
- **El adaptador del MateBook.** Que su Bluetooth admita el rol periférico LE. `preparar-windows.ps1` lo dice.
- **Que el ayudante compile** con el `csc.exe` de .NET Framework contra las APIs WinRT de la caja. El código solo se ha probado en Linux, con un compilador de C# 5 y unas APIs de mentira. Si falla, `compilar-hid.ps1` enseña el error.
- **La distribución del teclado.** El ayudante manda códigos de EE. UU. Con el teclado físico del iPhone en español, algunos signos pueden salir cambiados.
- **Los arrastres:** cuánto mueve cada informe relativo (6,9 pt cada 8 ms, medido por phoneuse por Bluetooth clásico) y si iOS acepta un arrastre así por BLE.
- **El nombre de la ventana de UxPlay en Windows.** Se busca por el proceso `uxplay`, y si no, por el título «UxPlay».
- **El recorte de bandas negras** y el OCR de Windows sobre frames reales de UxPlay.
- **Los textos en español de la pantalla de bloqueo** («Introduce el código»…).
- **Que Cmd+H y Cmd+Espacio** funcionen desde este teclado, como con phoneuse.
