# Vigilante de errores de precio — Amazon.es

Asistenta barre Amazon.es cada 30 minutos y te avisa por Telegram cuando un producto cuesta
**un 60 % o más por debajo de un histórico real** y la ficha del producto lo confirma.

## Encenderlo

Viene **encendido**. Solo necesitas:

1. `git pull`, `npm ci`, `npm run build` y reiniciar Asistenta.
2. La primera vez que haya un candidato, Asistenta abre la ficha en su Chrome. Si te pregunta
   «¿Abro amazon.es?», pulsa **Siempre**. No hace falta iniciar sesión en Amazon (si la tienes
   iniciada en ese Chrome, mejor: ve tu dirección y tus precios).
3. En Telegram: `/precios` para ver el estado.

Apagar: `/precios off` (o `PA_PRECIOS=0` en el `.env`). Encender: `/precios on`.
Barrer ya: `/precios ahora`.

## Qué barre

Por categoría (por defecto: informática, electrónica, grandes electrodomésticos, hogar y cocina,
videojuegos, juguetes, deportes, bricolaje, belleza, bebé, bebidas/licores y relojes inteligentes —este por
búsqueda—), tres listados: «Los más vendidos»,
«Los que más suben» y las novedades de la búsqueda. Cada barrido lee 6 páginas (rotando), con
6–12 s entre petición y petición. Elegir categorías:

    PA_PRECIOS_CATEGORIAS=cocina,informatica,https://www.amazon.es/s?k=robot+aspirador

**De noche también.** En las horas de silencio del dueño (22:00–08:00 por defecto) sigue
barriendo, al doble de intervalo (normal cada 60 min, rápido cada ~24 min). El aviso
«🚨 ERROR DE PRECIO» sale en el momento aunque sea de madrugada; nada más del vigilante manda
mensajes de noche.

**Siempre en marcha en el PC.** `pa autostart install --start` (una vez, en PowerShell desde la
carpeta de Asistenta) la arranca al iniciar sesión y deja la tarea «Asistenta-vigilante», que la
vuelve a levantar cada 5 min si se cae (ver docs/windows-startup.md). Los barridos van por reloj
de pared: tras suspender o hibernar el portátil, el barrido atrasado sale en el primer minuto
despierto, y uno que se quedó colgado durante la suspensión deja de bloquear a los 30 min.
Con la tapa cerrada o el PC apagado no barre.

**Resumen diario.** A las 21:00 (hora local) manda una línea por Telegram para que se vea que
sigue vivo: «Precios hoy: N páginas, mejor descuento X % (producto), 0 errores de precio». Si el
portátil dormía a esa hora, sale al despertar ese mismo día. `PA_PRECIOS_RESUMEN_DIARIO=0` la quita.

Además, un **barrido rápido** cada ~12 min (±25 %, `PA_PRECIOS_RAPIDO_MIN`) de búsquedas de
marcas y productos caros, donde un error de precio dura poco: relojes inteligentes (Apple Watch,
Galaxy Watch, Garmin, Amazfit, Huawei Watch, Pixel Watch), sobre todo informática (portátiles de marca —Lenovo, HP, ASUS, Acer, MSI, Dell— y
gaming, sobremesa y torres gaming —PcCom, MSI, HP Omen, Lenovo Legion—, Mac mini, NUC, iMac, MacBook, monitores, SSD NVMe, tarjetas RTX, procesadores Ryzen/Intel, iPad y tablets,
auriculares Sony/Bose/AirPods, iPhone, Galaxy S, routers mesh, RAM DDR5/DDR4 —Corsair, Kingston
Fury, G.Skill, Crucial—, placas base, fuentes, refrigeración AIO, cajas, discos NAS, teclados y
ratones gaming Logitech/Razer), y belleza y licores (ghd, Dyson,
planchas y secadores, perfumes, whisky, ginebra premium, ron añejo). Y la página de «Ofertas»
(amazon.es/deals, sus productos vienen en un JSON dentro de la página). Son 4 páginas por barrido
(rotando, `PA_PRECIOS_RAPIDO_PAGINAS`). Cambiarlas: `PA_PRECIOS_RAPIDAS=ghd,chivas regal|grocery,dyson`
(«no» = ninguna). Casos reales que tienen que salir: la plancha ghd Gold a 29,90 € (normal
~250 €) y el Chivas Regal Mizunara a 12,50 € (normal ~69 €), los dos vendidos por Amazon.es.

Los listados y las fichas se abren en el Chrome de Asistenta (con su sesión, Amazon pone menos
captchas). Si ese Chrome falla, lee sin navegador y no lo vuelve a intentar en 6 h; `/precios`
lo dice.

## El aviso

Por Telegram, con «🚨 ERROR DE PRECIO», el producto, el precio frente a la referencia, el −X % y
por qué, y dos botones: «🛒 Comprar ya» (mete ese producto en la cesta de un toque:
`https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=<ASIN>&Quantity.1=1`; si Amazon no tiene la
sesión iniciada en ese navegador, pide entrar y luego lo añade) y «🔗 Ver en Amazon» (la ficha).
Los dos enlaces van también en el texto.

## −60 % frente a un histórico REAL

Nico (6-nov-2026, 12:08): «60 % vale siempre que el histórico sea real, que no sea un falso 60 %».
Avisa con precio ≤ 40 % de una referencia que sea un precio al que se ha vendido de verdad:

- el historial propio de Asistenta (≥ 3 lecturas en más de un día);
- el «precio más bajo de los últimos 30 días» o el «Mediano» de Amazon (si no lo vende un tercero);
- el histórico de camelcamelcamel (media de lo que ha costado en Amazon), que se abre solo para un
  candidato que pasaría con el PVP, nunca durante el barrido.

El «Recomendado»/PVP o un tachado «antes» no valen nunca solos. Caso real: unos Sony WH-CH520 a
25,49 € con «Recomendado 69,99 €» (−64 %) que en Amazon cuestan de media 30,06 €: no avisa. El
aviso dice qué referencia usó («histórico real: …»). `PA_PRECIOS_UMBRAL=60` (por defecto).

## Sin marca, fuera

Nico (6-nov-2026): «Quita productos sin marca». No avisa (ni abre la ficha) de productos con marca
«Genérico», «Generic», «Sin marca»…, con el campo de marca vacío, o con un título que empieza por el
tipo de producto sin una marca conocida («2026 Tablet 10 Pulgadas…», «Reloj Inteligente Mujer
Hombre…»). Marcas extra que tratar igual: `PA_PRECIOS_SIN_MARCA=deertime,pinglang`.

Y si lo vende un tercero (aunque lo envíe Amazon), su tachado o su «precio más bajo de los últimos
30 días» no vale solo: lo fija el vendedor. Hace falta el historial propio de Asistenta. Caso real:
una tablet sin marca en oferta flash a 82,99 € «antes» 299,99 €, vendida por PINGLANG Tech.

## Cuándo avisa

- **Referencia fiable** (se usa la más baja): la mediana de lo que Asistenta ya ha visto de ese
  producto (3 lecturas en más de un día); el «Precio más bajo reciente» de Amazon; o el
  «Recomendado» tachado **solo si lo vende Amazon**. Así un producto nuevo sin historial también
  puede avisar.
- **Precio ≤ 40 % de la referencia real** (`PA_PRECIOS_UMBRAL=60`) y referencia de 40 € o más.
- **Verificado en la ficha**: nuevo (no reacondicionado ni de segunda mano), en stock, el mismo
  precio que en el listado (±5 %), y lo vende o lo envía Amazon.
- **Descarta**: recambios y accesorios («Kit de recambios compatible con Conga…», «Cepillos
  para…»), precios «desde»/otras ofertas, precios por unidad o kilo, y el tachado de un anuncio
  de otro producto metido en el mismo resultado (así se colaban avisos falsos).
- No repite el aviso del mismo producto en 7 días salvo que baje otro 10 %.

## Si Amazon se pone pesado

Si Amazon contesta con un captcha o un 503, el vigilante **para en seco** y espera 30 min,
luego 1 h, 2 h… hasta 6 h. `/precios` dice a qué hora vuelve a probar. Nunca insiste.

## Por qué Amazon «fallaba»

Pedida sin navegador real, la ficha de Amazon **esconde el precio** («Para ver los detalles del
producto, añádelo a la cesta»), y la búsqueda mete dentro de cada resultado anuncios de otros
productos con su propio tachado. Ahora la ficha se abre en el Chrome de Asistenta y el tachado
solo cuenta si es del propio producto.

## Lo que se aprendió cazando en amazon.es real (6-nov-2026, navegador en Madrid)

- La ficha real pesa 2–3 MB; el vendedor («Vendido por», «Remitente / Vendedor») cae a 330–510 KB y
  el tachado («El precio más bajo de los últimos 30 días») está en la columna central, no en la caja
  de compra, que sale antes en la página. Antes se perdían los dos: un Huawei Watch vendido por
  Amazon salía como «vendedor desconocido».
- Las ofertas (/deals) no traen productos en HTML, sino un JSON con `priceToPay` y `basisPrice`
  («Recomendado:», «Mediano:» —el precio mediano de Amazon— o «Más bajo:»).
- Con el navegador en inglés Amazon.es enseña «Recommended: €249.00» y no se lee nada: el Chrome de
  Asistenta tiene que estar en español.
